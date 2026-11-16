import os
import sys
import tempfile
import unittest

import numpy as np


class CalibrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_directory = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        os.environ["ENGINEERING_APP_DATA"] = cls.data_directory.name
        os.environ["ESP32_SIMULATOR"] = "1"
        sys.path.insert(0, os.path.abspath("can_server"))
        import app as measurement_app

        cls.module = measurement_app
        cls.client = measurement_app.app.test_client()

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("ENGINEERING_APP_DATA", None)
        os.environ.pop("ESP32_SIMULATOR", None)
        cls.data_directory.cleanup()

    def setUp(self):
        self.module.init_db()
        conn = self.module.get_db_connection()
        conn.execute("DELETE FROM measurements")
        conn.execute("DELETE FROM imported_can_files")
        for table in ("calibration_runs", "calibration_campaigns"):
            try:
                conn.execute(f"DELETE FROM {table}")
            except Exception:
                pass
        conn.commit()
        conn.close()

    def insert_run(self, source, start, current, offset_a, rate=100, seconds=60, drop_every=None, channel="A"):
        rng = np.random.default_rng(7)
        rows = []
        for index in range(int(rate * seconds)):
            if drop_every and index % drop_every == 0:
                continue
            value = current + offset_a + rng.normal(0, 0.0005)
            rows.append((start + index / rate, channel, round(value / 0.00025) * 0.00025, rate, 0, source))
        conn = self.module.get_db_connection()
        conn.executemany(
            "INSERT INTO measurements(timestamp, channel, current_A, frequency_Hz, lost_count, source_file) VALUES (?,?,?,?,?,?)",
            rows,
        )
        conn.commit()
        conn.close()
        return len(rows)

    def create_campaign(self, **protocol):
        response = self.client.post("/api/calibration/campaigns", json={"name": "Essai", "protocol": protocol})
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()["campaign"]

    def test_page_and_home_module_are_available(self):
        home = self.client.get("/").get_data(as_text=True)
        self.assertIn("MODULE 04 / CALIBRATION", home)
        self.assertIn("Logs ASC et base locale", home)
        page = self.client.get("/calibration")
        self.assertEqual(page.status_code, 200)
        self.assertIn("Fluke 287", page.get_data(as_text=True))

    def test_protocol_defaults_expected_samples(self):
        campaign = self.create_campaign()
        protocol = campaign["protocol"]
        self.assertEqual(protocol["frequency_hz"], 100)
        self.assertEqual(protocol["repetitions"], 3)
        self.assertEqual(protocol["checkpoints_s"], [0, 20, 40, 60])
        analysis = self.client.get(f"/api/calibration/campaigns/{campaign['id']}/analysis").get_json()["analysis"]
        self.assertEqual(analysis["summary"]["samples_expected_per_run"], 6000)
        self.assertEqual(analysis["summary"]["samples_expected_total"], 18000)
        self.assertEqual(analysis["summary"]["verdict"], "missing")

    def test_shunt_code_is_accepted(self):
        campaign = self.create_campaign(shunt_ohm="R002")
        self.assertAlmostEqual(campaign["protocol"]["shunt_ohm"], 0.002)
        campaign = self.create_campaign(shunt_ohm="R100")
        self.assertAlmostEqual(campaign["protocol"]["shunt_ohm"], 0.1)
        bad = self.client.post("/api/calibration/campaigns", json={"protocol": {"shunt_ohm": "RXX"}})
        self.assertEqual(bad.status_code, 400)

    def test_rejects_checkpoint_after_duration(self):
        response = self.client.post("/api/calibration/campaigns", json={"protocol": {"duration_s": 30, "checkpoints_s": "0,20,40"}})
        self.assertEqual(response.status_code, 400)

    def test_offset_is_measured_against_reference(self):
        campaign = self.create_campaign()
        for index in range(1, 4):
            source = f"live_run{index}"
            self.insert_run(source, 1_800_000_000 + index * 90, 0.300, 0.002)
            response = self.client.put(
                f"/api/calibration/campaigns/{campaign['id']}/runs/{index}",
                json={"source_file": source, "samples_reported": 6000,
                      "reference": {"0": "0,300", "20": 0.300, "40": 0.300, "60": 0.300},
                      "fluke_min_A": 0.2995, "fluke_max_A": 0.3005},
            )
            self.assertEqual(response.status_code, 200, response.get_json())
        analysis = self.client.get(f"/api/calibration/campaigns/{campaign['id']}/analysis").get_json()["analysis"]
        summary = analysis["summary"]
        self.assertAlmostEqual(summary["offset_A"], 0.002, delta=0.0003)
        self.assertGreater(summary["completeness_pct"], 99.9)
        run = analysis["runs"][0]
        self.assertEqual(run["samples"], 6000)
        self.assertEqual(run["reported_vs_db"], 0)
        self.assertAlmostEqual(run["effective_rate_hz"], 100, delta=0.1)
        # 400 mA range : ±(0,15 % × 0,3 A + 2 × 10 µA) = 470 µA
        self.assertAlmostEqual(run["checkpoints"][1]["reference_limit_A"], 0.00047, places=7)
        self.assertEqual(run["checkpoints"][1]["status"], "warning")
        self.assertTrue(run["allan"])
        self.assertIn("bland_altman", summary)
        titles = [tip["title"] for tip in summary["recommendations"]]
        self.assertIn("Erreur systématique (offset) significative", titles)
        export = self.client.get(f"/api/calibration/campaigns/{campaign['id']}/export.csv")
        self.assertEqual(export.status_code, 200)
        self.assertIn("Limite Fluke A", export.get_data(as_text=True))

    def test_lost_samples_and_segment_detection(self):
        campaign = self.create_campaign()
        start = 1_800_000_000
        for index in range(3):
            self.insert_run("live_single", start + index * 90, 0.1, 0, drop_every=50)
        segments = self.client.get("/api/calibration/segments?source_file=live_single&channel=A&min_gap_s=5").get_json()["segments"]
        self.assertEqual(len(segments), 3)
        self.assertAlmostEqual(segments[1]["start_offset_s"], 90, delta=0.05)
        self.client.put(f"/api/calibration/campaigns/{campaign['id']}/runs/2",
                        json={"source_file": "live_single", "start_offset_s": segments[1]["start_offset_s"], "samples_reported": 5880})
        run = self.client.get(f"/api/calibration/campaigns/{campaign['id']}/analysis").get_json()["analysis"]["runs"][1]
        self.assertEqual(run["samples"], 5880)
        self.assertEqual(run["lost_samples"], 120)
        self.assertEqual(run["gap_count"], 119)  # la 1re perte précède la fenêtre détectée

    def test_multilevel_regression_separates_offset_and_gain(self):
        for level in (0.1, 0.5, 1.0):
            campaign = self.create_campaign(repetitions=1)
            source = f"live_level_{level}"
            measured = level * 1.01 + 0.001
            self.insert_run(source, 1_800_000_000 + level * 1000, measured, 0)
            self.client.put(f"/api/calibration/campaigns/{campaign['id']}/runs/1",
                            json={"source_file": source, "reference": {"0": level, "20": level, "40": level, "60": level}})
        regression = self.client.get("/api/calibration/overview?channel=A").get_json()["regression"]
        self.assertEqual(regression["status"], "ok")
        self.assertAlmostEqual(regression["gain_error_pct"], 1.0, delta=0.05)
        self.assertAlmostEqual(regression["offset_A"], 0.001, delta=0.0003)


    def test_catalog_labels_and_selective_delete(self):
        self.insert_run("live_abc", 1_800_000_000, 0.2, 0, seconds=2)
        self.insert_run("live_abc", 1_800_000_000, 0.2, 0, seconds=2, channel="B")
        self.insert_run("can_s1_0_trace.asc", 1_800_000_100, 0.2, 0, seconds=2)
        conn = self.module.get_db_connection()
        conn.execute("INSERT INTO imported_can_files(source_file, filename) VALUES (?, ?)", ("can_s1_0_trace.asc", "trace.asc"))
        conn.commit()
        conn.close()
        sources = {item["source_file"]: item for item in self.client.get("/api/database_sources").get_json()["sources"]}
        self.assertEqual(sources["live_abc"]["kind"], "digital")
        self.assertIn("Numérique", sources["live_abc"]["label"])
        self.assertEqual(sorted(sources["live_abc"]["channels"]), ["A", "B"])
        self.assertEqual(sources["can_s1_0_trace.asc"]["name"], "trace.asc")

        response = self.client.post("/api/database_sources/delete", json={"items": [{"source_file": "live_abc", "channels": ["B"]}]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["deleted_measurements"], 200)
        sources = {item["source_file"]: item for item in self.client.get("/api/database_sources").get_json()["sources"]}
        self.assertEqual(sorted(sources["live_abc"]["channels"]), ["A"])

        response = self.client.post("/api/database_sources/delete", json={"items": [{"source_file": "can_s1_0_trace.asc"}]})
        self.assertEqual(response.get_json()["removed_sources"], ["can_s1_0_trace.asc"])
        sources = self.client.get("/api/database_sources").get_json()["sources"]
        self.assertEqual([item["source_file"] for item in sources], ["live_abc"])
        self.assertEqual(self.client.post("/api/database_sources/delete", json={"items": []}).status_code, 400)

    def test_database_page_and_slim_dashboard(self):
        page = self.client.get("/database").get_data(as_text=True)
        self.assertIn('accept=".asc"', page)
        self.assertIn("databaseCatalog", page)
        dashboard = self.client.get("/dashboard/import").get_data(as_text=True)
        self.assertIn("logFilterForm", dashboard)
        self.assertNotIn("uploadForm", dashboard)


if __name__ == "__main__":
    unittest.main()
