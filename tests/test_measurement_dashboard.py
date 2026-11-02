import io
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch


class MeasurementDashboardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_directory = tempfile.TemporaryDirectory()
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
        module = self.module
        module.active_measurement.clear()
        snapshot = {
            "project": {"id": "validation-project", "name": "Validation"},
            "analysis_config": {
                "dcdc_output_current_A": 200,
                "battery_capacity_Ah": 60,
                "starting_soc_percent": 90,
                "minimum_soc_percent": 70,
            },
            "biberonnage_analyses": [
                {
                    "id": "tt-opt",
                    "name": "TT Opt mesuré",
                    "result": {
                        "capacityAh": 80,
                        "startSoc": 90,
                        "demandSoc": 76,
                        "targetSoc": 90,
                    },
                },
            ],
            "devices": [
                {
                    "id": "d1",
                    "kind": "dcdc",
                    "name": "ECU 1",
                    "nominal_A": 40,
                    "scenarios": {
                        "Winter < 5°C": [
                            {"label": "P1", "start_s": 0, "end_s": 10, "expected_A": 40}
                        ]
                    },
                },
                {
                    "id": "d2",
                    "kind": "dcdc",
                    "name": "ECU 2",
                    "nominal_A": 30,
                    "scenarios": {
                        "Winter < 5°C": [
                            {"label": "P1", "start_s": 0, "end_s": 10, "expected_A": 30}
                        ]
                    },
                },
                {
                    "id": "s1",
                    "kind": "sleep",
                    "mode": "DM1",
                    "name": "ECU veille — DM1",
                    "nominal_A": 0.01,
                    "day_profiles": {"0": 1, "0.3": 0, "1": 1, "1.5": 0},
                    "scenarios": {},
                },
                {
                    "id": "c1",
                    "kind": "sleep",
                    "mode": "Customer Mode",
                    "name": "ECU veille — Customer",
                    "nominal_A": 0.006,
                    "day_profiles": {"0": 0, "0.5": 1},
                    "scenarios": {},
                },
            ],
        }
        module.write_json_file(module.THEORY_FILE, snapshot)
        module.write_json_file(module.SESSIONS_FILE, [])
        module.init_db()
        database = module.get_db_connection()
        database.execute("DELETE FROM measurements")
        database.execute("DELETE FROM measurements_summary_1m")
        database.execute("DELETE FROM imported_can_files")
        database.execute("DELETE FROM saved_dashboards")
        database.commit()
        database.close()
        module.save_measurement_session({
            "id": "test-session",
            "status": "completed",
            "started_at": 1000,
            "ended_at": 1010,
            "requested_duration_s": 10,
            "actual_duration_s": 10,
            "frequency_hz": 1000,
            "actual_frequency_hz": 997,
            "channels": ["A", "B"],
            "project": snapshot["project"],
            "project_id": "validation-project",
        })
        database = module.get_db_connection()
        for timestamp in range(1000, 1011):
            database.execute(
                "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,lost_count,source_file) VALUES(?,?,?,?,?,?)",
                (timestamp, "A", 50, 997, 0, "test"),
            )
            database.execute(
                "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,lost_count,source_file) VALUES(?,?,?,?,?,?)",
                (timestamp, "B", 60, 997, 0, "test"),
            )
        database.commit()
        database.close()

    def configure(self, analysis_type, temperature, device_ids):
        return self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": analysis_type,
            "temperature_c": temperature,
            "device_ids": device_ids,
        })

    def test_dcdc_all_devices_and_real_measurement(self):
        self.assertEqual(self.configure("dcdc", -7, ["d1", "d2"]).status_code, 200)
        report = self.client.get("/api/dashboard_report?session_id=test-session").get_json()
        self.assertTrue(report["has_data"])
        self.assertTrue(report["analysis"]["all_selected"])
        self.assertEqual(report["measurement"]["peak_current_A"], 110)
        self.assertEqual(report["measurement"]["actual_frequency_hz"], 997)
        self.assertEqual(
            [
                (channel["channel"], channel["address"], channel["samples"])
                for channel in report["measurement"]["channels"]
            ],
            [("A", "0x40", 11), ("B", "0x41", 11)],
        )
        self.assertEqual(report["measurement"]["channels"][0]["average_current_A"], 50)
        self.assertEqual(report["measurement"]["channels"][1]["average_current_A"], 60)
        self.assertEqual(report["sizing"]["status"], "pass")
        self.assertEqual(
            [
                (
                    channel["channel"],
                    channel["used_current_A"],
                    channel["remaining_current_A"],
                    channel["status"],
                )
                for channel in report["sizing"]["channels"]
            ],
            [("A", 50, 150, "pass"), ("B", 60, 140, "pass")],
        )
        self.assertEqual(report["analysis"]["profile_duration_s"], 10)
        self.assertEqual(len(report["measurement"]["series"][0]["points"]), 11)
        first_interval = report["analysis"]["intervals"][0]
        self.assertEqual(first_interval["label"], "0 - 5 min")
        self.assertEqual(first_interval["theoretical_A"], 70)
        self.assertEqual(first_interval["measured_average_A"], 110)
        self.assertEqual(first_interval["measured_average_channel_A"], 50)
        self.assertEqual(first_interval["measured_average_channel_B"], 60)
        self.assertEqual(first_interval["samples"], 22)
        self.assertEqual(first_interval["status"], "missing")
        first_device = report["analysis"]["selected_devices"][0]["intervals"][0]
        self.assertEqual(first_device["expected_A"], 40)
        self.assertAlmostEqual(first_device["measured_allocated_A"], 110 * 40 / 70)
        self.assertEqual(first_device["status"], "missing")

    def test_sleep_autonomy_uses_selected_days_and_binary_profiles(self):
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "dm1",
            "start_day": 0,
            "end_day": 2,
            "device_ids": ["s1"],
            "dashboard_channels": ["A", "B"],
        })
        self.assertEqual(response.status_code, 200)
        report = self.client.get("/api/dashboard_report?session_id=test-session").get_json()
        self.assertTrue(all(item["days"] > 0 for item in report["autonomy"]["channels"]))
        self.assertEqual(report["analysis"]["capacity_factor"], 1)
        self.assertEqual(report["analysis"]["start_day"], 0)
        self.assertEqual(report["analysis"]["end_day"], 2)
        self.assertEqual(len(report["analysis"]["intervals"]), 5)
        self.assertEqual(
            [interval["theoretical_A"] for interval in report["analysis"]["intervals"]],
            [0.01, 0, 0, 0.01, 0],
        )
        self.assertTrue(all(
            abs(item["theoretical_daily_consumption_Ah"] - 0.24) < 1e-9
            for item in report["autonomy"]["channels"]
        ))
        self.assertTrue(all(item["status"] == "worse" for item in report["autonomy"]["channels"]))
        self.assertTrue(all(item["measured_energy_Ah"] > item["theoretical_energy_Ah"] for item in report["autonomy"]["channels"]))
        intervals = report["analysis"]["intervals"]
        self.assertEqual(intervals[0]["samples_channel_A"], 11)
        self.assertEqual(intervals[0]["samples_channel_B"], 11)
        self.assertTrue(all(item["samples_channel_A"] == 0 for item in intervals[1:]))
        self.assertTrue(all(item["samples_channel_B"] == 0 for item in intervals[1:]))
        self.assertTrue(all(item["status_channel_A"] == "no_data" for item in intervals[1:]))
        self.assertTrue(all(item["status_channel_B"] == "no_data" for item in intervals[1:]))
        self.assertTrue(all(item["status"] == "fail" for item in report["analysis"]["duration_checks"]))
        self.assertTrue(all(item["expected_s"] == 2 * 86400 for item in report["analysis"]["duration_checks"]))

    def test_customer_mode_uses_customer_profiles_and_selected_channel(self):
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "customer",
            "start_day": 0,
            "end_day": 1,
            "device_ids": ["c1"],
            "dashboard_channels": ["B"],
        })
        self.assertEqual(response.status_code, 200)
        report = self.client.get("/api/dashboard_report?session_id=test-session").get_json()
        self.assertEqual(report["analysis"]["dashboard_channels"], ["B"])
        self.assertEqual([item["expected_A"] for item in report["autonomy"]["channels"][0]["intervals"]], [0, 0.006])
        self.assertEqual(report["autonomy"]["channels"][0]["channel"], "B")
        self.assertEqual(report["analysis"]["duration_checks"][0]["status"], "fail")
        self.assertEqual(report["analysis"]["duration_checks"][0]["expected_s"], 86400)

    def test_sleep_autonomy_integrates_real_elapsed_time_and_flags_profile_excess(self):
        origin = 1_700_000_000
        end_day = 10 / 86400
        change_day = 5 / 86400
        rows = [
            {
                "timestamp": origin + second,
                "channel": "A",
                "current_A": 0.002 + min(second, 5) * 0.0004,
                "frequency_Hz": 1,
                "source_file": "sample",
            }
            for second in range(11)
        ]
        device = {
            "id": "sleep-ecu",
            "name": "ECU veille",
            "nominal_A": 0.006,
            "day_profiles": {"0": 0, str(change_day): 1},
        }

        result = self.module.build_autonomy(
            rows,
            ["A"],
            [device],
            origin,
            0,
            end_day,
            1,
            self.module.day_profile_value,
            self.module.day_profile_points,
        )
        channel = result["channels"][0]

        self.assertAlmostEqual(channel["covered_s"], 10)
        self.assertAlmostEqual(channel["daily_consumption_Ah"], 0.084)
        self.assertAlmostEqual(channel["theoretical_daily_consumption_Ah"], 0.072)
        self.assertAlmostEqual(channel["days"], 1 / 0.084)
        self.assertAlmostEqual(channel["theoretical_days"], 1 / 0.072)
        self.assertAlmostEqual(channel["difference_days"], 1 / 0.084 - 1 / 0.072)
        self.assertEqual([interval["expected_A"] for interval in channel["intervals"]], [0, 0.006])
        self.assertAlmostEqual(channel["intervals"][0]["average_A"], 0.003)
        self.assertEqual(len(channel["anomalies"]), 1)
        self.assertEqual(channel["anomalies"][0]["exceedances"], 5)
        self.assertEqual(channel["anomalies"][0]["first_anomaly_at"], origin)

    def test_autonomy_day_ranges_are_validated(self):
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "dm1",
            "start_day": 20,
            "end_day": 91,
            "device_ids": ["s1"],
        })
        self.assertEqual(response.status_code, 400)
        customer_response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "customer",
            "start_day": 0,
            "end_day": 31,
            "device_ids": ["s1"],
        })
        self.assertEqual(customer_response.status_code, 400)

    def test_dashboard_channel_selection_filters_report(self):
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "dcdc",
            "temperature_c": 20,
            "device_ids": ["d1", "d2"],
            "dashboard_channels": ["A"],
        })
        self.assertEqual(response.status_code, 200)
        report = self.client.get("/api/dashboard_report?session_id=test-session").get_json()
        self.assertEqual(report["analysis"]["dashboard_channels"], ["A"])
        self.assertEqual(
            [channel["channel"] for channel in report["measurement"]["channels"]],
            ["A"],
        )
        self.assertEqual(
            [series["channel"] for series in report["measurement"]["series"]],
            ["A"],
        )
        self.assertEqual(report["measurement"]["average_current_A"], 50)
        self.assertEqual(report["measurement"]["peak_current_A"], 50)
        first_interval = report["analysis"]["intervals"][0]
        self.assertEqual(first_interval["samples_channel_A"], 11)
        self.assertEqual(first_interval["samples_channel_B"], 0)

    def test_explorer_archive_keeps_raw_database_and_filters_after_restart(self):
        import subprocess
        conn = self.module.get_db_connection()
        expected = [tuple(row) for row in conn.execute('SELECT * FROM measurements ORDER BY id')]
        conn.close()
        state = {"filters": [["channel", "AB"], ["unit", "mA"], ["limit", "100"]],
                 "form": [["channel", "AB"], ["unit", "mA"], ["limit", "100"]],
                 "pages": {"A": 1, "B": 0}}
        result = self.client.post('/api/save_dashboard', json={
            'view': 'explorer', 'name': 'Frozen complete database', 'explorer_state': state})
        self.assertEqual(result.status_code, 200, result.json)
        archive = result.json['dashboard']['id']
        self.assertIn('/dashboard/import?', result.json['dashboard']['url'])
        conn = self.module.get_db_connection()
        row = conn.execute('SELECT * FROM saved_dashboards WHERE id=?', (archive,)).fetchone()
        self.assertEqual(json.loads(row['view_json'])['explorer'], state)
        import sqlite3
        frozen = sqlite3.connect(':memory:')
        frozen.deserialize(row['database_snapshot'])
        self.assertEqual(frozen.execute('SELECT * FROM measurements ORDER BY id').fetchall(), expected)
        frozen.close()
        conn.execute('DELETE FROM measurements')
        conn.commit()
        conn.close()
        script = """
import sys
sys.path.insert(0, 'can_server')
import app
client = app.app.test_client()
archive = sys.argv[1]
catalog = client.get('/api/log_catalog?saved_dashboard_id=' + archive)
assert catalog.status_code == 200
assert sum(row['samples'] for row in catalog.json['sources']) == int(sys.argv[2])
assert archive in client.get('/').get_data(as_text=True)
page = client.get('/dashboard/import?saved_dashboard_id=' + archive)
assert page.status_code == 200
assert 'Frozen complete database' in page.get_data(as_text=True)
"""
        subprocess.run([sys.executable, '-c', script, archive, str(len(expected))], check=True,
                       env=os.environ.copy(), capture_output=True, text=True)
        self.module.write_json_file(self.module.THEORY_FILE, {'project': {'id': 'other'}})
        self.assertEqual(self.client.get('/api/log_catalog?saved_dashboard_id=' + archive).status_code, 404)

    def test_dashboard_can_be_saved_and_opened_from_history(self):
        self.assertEqual(self.configure("dcdc", 20, ["d1", "d2"]).status_code, 200)
        response = self.client.post("/api/save_dashboard", json={
            "session_id": "test-session",
            "name": "Validation DCDC enregistrée",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["dashboard"]["source"], "digital")
        archive_id = response.get_json()["dashboard"]["id"]
        session = next(
            item for item in self.module.measurement_sessions()
            if item["id"] == "test-session"
        )
        self.assertNotIn("dashboard_saved", session)
        home = self.client.get("/").get_data(as_text=True)
        self.assertIn("Historique des dashboards enregistrés", home)
        self.assertIn("Validation DCDC enregistrée", home)
        self.assertIn(f"/dashboard?saved_dashboard_id={archive_id}", home)
        saved_report = self.client.get(
            f"/api/dashboard_report?saved_dashboard_id={archive_id}"
        ).get_json()
        self.assertEqual(saved_report["analysis"]["dashboard_channels"], ["A", "B"])
        self.assertEqual(saved_report["measurement"]["peak_current_A"], 110)
        self.assertEqual(saved_report["saved_dashboard"]["name"], "Validation DCDC enregistrée")
        database = self.module.get_db_connection()
        database.execute("DELETE FROM measurements WHERE source_file = 'test'")
        database.commit()
        database.close()
        archived_report_after_purge = self.client.get(
            f"/api/dashboard_report?saved_dashboard_id={archive_id}"
        ).get_json()
        self.assertEqual(archived_report_after_purge["measurement"]["peak_current_A"], 110)

    def test_numeric_and_can_dashboards_share_project_history_and_archive(self):
        self.assertEqual(self.configure("dcdc", 20, ["d1", "d2"]).status_code, 200)
        digital = self.client.post("/api/save_dashboard", json={
            "session_id": "test-session",
            "name": "Même campagne",
        }).get_json()
        self.module.save_measurement_session({
            "id": "can-session",
            "status": "imported",
            "acquisition_mode": "can",
            "started_at": 3000,
            "ended_at": 3010,
            "channels": ["A", "B"],
            "source_files": ["can-independent-source"],
            "analysis": {"type": "dcdc", "label": "DCDC Sizing"},
            "project": {"id": "validation-project", "name": "Validation"},
            "project_id": "validation-project",
        })
        database = self.module.get_db_connection()
        for timestamp in range(3000, 3011):
            database.execute(
                "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,lost_count,source_file) VALUES(?,?,?,?,?,?)",
                (timestamp, "A", 52, 1000, 0, "can-independent-source"),
            )
            database.execute(
                "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,lost_count,source_file) VALUES(?,?,?,?,?,?)",
                (timestamp, "B", 62, 1000, 0, "can-independent-source"),
            )
        database.commit()
        database.close()
        can = self.client.post("/api/save_dashboard", json={
            "session_id": "can-session",
            "name": "Même campagne",
        }).get_json()
        self.assertEqual(digital["dashboard"]["source"], "digital")
        self.assertEqual(can["dashboard"]["source"], "can")
        home = self.client.get("/").get_data(as_text=True)
        self.assertIn(f"/dashboard?saved_dashboard_id={digital['dashboard']['id']}", home)
        self.assertIn(f"/dashboard?saved_dashboard_id={can['dashboard']['id']}", home)
        self.assertIn("Valeurs numériques", home)
        self.assertIn("Mesure CAN", home)
        self.assertEqual(home.count("Même campagne"), 2)

    def test_dashboard_archives_are_scoped_to_the_active_project(self):
        self.assertEqual(self.configure("dcdc", 20, ["d1", "d2"]).status_code, 200)
        self.client.post("/api/save_dashboard", json={
            "session_id": "test-session",
            "name": "Dashboard du projet A",
        })
        self.module.write_json_file(
            self.module.THEORY_FILE,
            {"project": {"id": "other-project", "name": "Autre projet"}, "devices": []},
        )
        home = self.client.get("/").get_data(as_text=True)
        self.assertIn("Aucun dashboard enregistré pour ce projet", home)
        self.assertNotIn("Dashboard du projet A", home)

    def test_new_measurement_preserves_saved_and_unsaved_measurements(self):
        self.assertEqual(self.configure("dcdc", 20, ["d1", "d2"]).status_code, 200)
        self.client.post("/api/save_dashboard", json={
            "session_id": "test-session",
            "name": "Dashboard conservé",
        })
        self.module.save_measurement_session({
            "id": "temporary-session",
            "status": "completed",
            "started_at": 2000,
            "ended_at": 2001,
            "channels": ["A"],
            "source_files": ["temporary-source"],
        })
        database = self.module.get_db_connection()
        database.execute(
            "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,lost_count,source_file) VALUES(?,?,?,?,?,?)",
            (2000, "A", 1, 10, 0, "temporary-source"),
        )
        database.commit()
        database.close()
        deleted = self.module.discard_unsaved_sessions()
        self.assertEqual(deleted["sessions"], 0)
        self.assertEqual(
            [item["id"] for item in self.module.measurement_sessions()],
            ["temporary-session", "test-session"],
        )
        database = self.module.get_db_connection()
        self.assertEqual(
            database.execute(
                "SELECT COUNT(*) FROM measurements WHERE source_file = 'temporary-source'"
            ).fetchone()[0],
            1,
        )
        self.assertEqual(
            database.execute(
                "SELECT COUNT(*) FROM measurements WHERE source_file = 'test'"
            ).fetchone()[0],
            22,
        )
        database.close()

    def test_biberonnage_uses_channel_tables_like_other_dashboards(self):
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "biberonnage",
            "device_ids": ["s1"],
            "biberonnage_id": "tt-opt",
            "biberonnage_days": 30,
        })
        self.assertEqual(response.status_code, 200)
        report = self.client.get("/api/dashboard_report?session_id=test-session").get_json()
        self.assertEqual(len(report["analysis"]["intervals"]), 1)
        interval = report["analysis"]["intervals"][0]
        self.assertEqual(interval["label"], "0 à 10 s")
        self.assertEqual(interval["measured_average_channel_A"], 50)
        self.assertEqual(interval["measured_average_channel_B"], 60)
        self.assertEqual(
            len(report["analysis"]["selected_devices"][0]["intervals"]),
            1,
        )
        feeding = report["feeding"]
        self.assertEqual(feeding["name"], "TT Opt mesuré")
        self.assertEqual(feeding["duration_days"], 30)
        self.assertEqual(feeding["battery_capacity_Ah"], 80)
        self.assertEqual([item["channel"] for item in feeding["channels"]], ["A", "B"])
        self.assertAlmostEqual(feeding["channels"][0]["transferred_Ah"], 50 * 10 / 3600)
        self.assertAlmostEqual(feeding["channels"][1]["transferred_Ah"], 60 * 10 / 3600)
        self.assertAlmostEqual(feeding["channels"][0]["energy_Wh"], 50 * 10 / 3600 * 14.5)
        self.assertAlmostEqual(feeding["channels"][1]["energy_Wh"], 60 * 10 / 3600 * 14.5)
        self.assertAlmostEqual(feeding["channels"][0]["theoretical_Ah"], 0.01 * 10 / 3600)
        self.assertAlmostEqual(feeding["channels"][1]["theoretical_Ah"], 0.01 * 10 / 3600)
        self.assertAlmostEqual(
            feeding["channels"][0]["ending_soc_percent"],
            90 - (50 * 10 / 3600) / 80 * 100,
        )
        self.assertAlmostEqual(
            feeding["channels"][1]["theoretical_ending_soc_percent"],
            90 - (0.01 * 10 / 3600) / 80 * 100,
        )
        self.assertAlmostEqual(
            feeding["channels"][0]["difference_Ah"],
            (50 - 0.01) * 10 / 3600,
        )
        self.assertIsNone(report["measurement"]["energy_Ah"])
        self.assertNotIn("total_transferred_Ah", feeding)
        self.assertNotIn("total_cost_ef_Wh", feeding)
        self.assertTrue(all(item["status"] == "fail" for item in report["analysis"]["duration_checks"]))

    def test_biberonnage_checks_every_current_for_low_and_high_anomalies(self):
        database = self.module.get_db_connection()
        for timestamp in range(1000, 1011):
            current = [0, 0.01, 0.02][(timestamp - 1000) % 3]
            database.execute(
                "UPDATE measurements SET current_A = ? WHERE timestamp = ? AND channel = 'A'",
                (current, timestamp),
            )
        database.commit()
        database.close()
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "biberonnage",
            "device_ids": ["s1"],
            "biberonnage_id": "tt-opt",
            "biberonnage_days": 90,
            "dashboard_channels": ["A"],
        })
        self.assertEqual(response.status_code, 200)
        report = self.client.get("/api/dashboard_report?session_id=test-session").get_json()
        self.assertEqual(report["analysis"]["biberonnage_days"], 90)
        self.assertEqual(report["analysis"]["dashboard_channels"], ["A"])
        self.assertEqual(report["feeding"]["duration_days"], 90)
        channel = report["feeding"]["channels"][0]
        self.assertEqual(channel["channel"], "A")
        self.assertEqual(channel["anomaly_sample_count"], 7)
        self.assertEqual(
            {
                direction: sum(item["sample_count"] for item in channel["anomalies"] if item["direction"] == direction)
                for direction in ("too_low", "too_high")
            },
            {"too_low": 4, "too_high": 3},
        )
        self.assertEqual(report["analysis"]["duration_checks"][0]["expected_s"], 90 * 86400)
        self.assertEqual(report["analysis"]["duration_checks"][0]["status"], "fail")

    def test_biberonnage_anomaly_ranges_split_at_acquisition_gaps(self):
        database = self.module.get_db_connection()
        database.execute(
            "UPDATE measurements SET timestamp = timestamp + 100 "
            "WHERE channel = 'A' AND timestamp >= 1005"
        )
        database.commit()
        database.close()
        session = self.module.measurement_sessions()[0]
        session["ended_at"] = 1110
        session["actual_duration_s"] = 110
        self.module.save_measurement_session(session)
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "biberonnage",
            "device_ids": ["s1"],
            "biberonnage_id": "tt-opt",
            "biberonnage_days": 30,
            "dashboard_channels": ["A"],
        })
        self.assertEqual(response.status_code, 200)
        report = self.client.get("/api/dashboard_report?session_id=test-session").get_json()
        anomalies = report["feeding"]["channels"][0]["anomalies"]
        self.assertEqual(len(anomalies), 2)
        self.assertEqual(
            [(item["first_timestamp"], item["last_timestamp"]) for item in anomalies],
            [(1000, 1004), (1105, 1110)],
        )

    def test_biberonnage_duration_rejects_values_other_than_30_or_90_days(self):
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "biberonnage",
            "device_ids": ["s1"],
            "biberonnage_id": "tt-opt",
            "biberonnage_days": 42,
        })
        self.assertEqual(response.status_code, 400)

    def test_biberonnage_device_tables_follow_minute_periods(self):
        session = next(
            item for item in self.module.measurement_sessions()
            if item["id"] == "test-session"
        )
        session["ended_at"] = 1130
        session["requested_duration_s"] = 130
        session["actual_duration_s"] = 130
        self.module.save_measurement_session(session)
        database = self.module.get_db_connection()
        for timestamp in (1060, 1120, 1130):
            database.execute(
                "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,lost_count,source_file) VALUES(?,?,?,?,?,?)",
                (timestamp, "A", 50, 997, 0, "test"),
            )
            database.execute(
                "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,lost_count,source_file) VALUES(?,?,?,?,?,?)",
                (timestamp, "B", 60, 997, 0, "test"),
            )
        database.commit()
        database.close()
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": "test-session",
            "analysis_type": "biberonnage",
            "device_ids": ["s1"],
            "biberonnage_id": "tt-opt",
        })
        self.assertEqual(response.status_code, 200)
        report = self.client.get("/api/dashboard_report?session_id=test-session").get_json()
        self.assertEqual(
            [item["label"] for item in report["analysis"]["intervals"]],
            ["0 à 1 min", "1 à 2 min", "2 à 2,17 min"],
        )
        self.assertEqual(
            len(report["analysis"]["selected_devices"][0]["intervals"]),
            3,
        )

    def test_acquisition_and_dashboard_setup_pages(self):
        home = self.client.get("/").get_data(as_text=True)
        self.assertIn("CAN Measurement Workstation", home)
        self.assertIn("Sélectionnez le mode de mesure", home)
        self.assertIn("esp32_mesure", home)
        self.assertIn("fréquence, de durée et de canaux se règlent dans l’application", home)
        self.assertIn('data-measurement-mode="digital"', home)
        self.assertIn('data-measurement-mode="can"', home)
        self.assertIn("Ouvrir l’acquisition", home)
        self.assertIn("Ouvrir le dashboard", home)
        self.assertIn("CANalyzer", home)

        digital = self.client.get("/measurement?mode=digital").get_data(as_text=True)
        self.assertIn("Fréquence d’acquisition réelle", digital)
        self.assertIn("ESP32-C3", digital)
        self.assertIn('max="1000"', digital)
        self.assertIn("Durée de mesure", digital)
        self.assertIn("Arrêter canal A", digital)
        self.assertIn("Arrêter canal B", digital)
        self.assertIn('name="acquisition_mode" value="digital"', digital)
        self.assertIn("CAN contourné", digital)
        self.assertIn('id="currentA"', digital)
        self.assertIn('id="currentB"', digital)
        self.assertIn("courants des voies INA226 s’afficheront ci-dessous en direct", digital)
        self.assertIn("dashboard sera disponible après la mesure", digital)
        self.assertNotIn("Nature de la mesure", digital)
        self.assertNotIn("Tolérance de conformité", digital)

        can = self.client.get("/measurement?mode=can").get_data(as_text=True)
        self.assertIn('name="acquisition_mode" value="can"', can)
        self.assertIn("Acquisition CAN pour CANalyzer", can)
        self.assertIn("Les deux voies INA226 sont émises sur le bus CAN", can)
        self.assertIn("Activez l’enregistrement dans CANalyzer", can)

        import_page = self.client.get("/dashboard/import").get_data(as_text=True)
        self.assertIn("Importer et décoder les logs CAN", import_page)
        self.assertIn('accept=".asc"', import_page)
        self.assertIn("Réinitialiser la base de données", import_page)
        self.assertIn("Continuer vers les options du dashboard", import_page)
        self.assertIn("Fréquence canal A", import_page)
        self.assertIn("Fréquence canal B", import_page)
        self.assertIn("Durée canal A", import_page)
        self.assertIn("Durée canal B", import_page)
        self.assertNotIn("<span>Fréquence réelle</span>", import_page)
        self.assertNotIn("<span>Durée du log</span>", import_page)

        setup = self.client.get("/dashboard/setup?session_id=test-session").get_data(as_text=True)
        for mode in ("DCDC Sizing", "Veille DM1", "Veille DM2", "Customer Mode", "Biberonnage", "WLTC"):
            self.assertIn(mode, setup)
        self.assertIn("Tout sélectionner", setup)
        self.assertIn("Tout désélectionner", setup)
        self.assertIn("Canal A uniquement", setup)
        self.assertIn("Canal B uniquement", setup)
        self.assertIn("Les deux canaux A et B", setup)
        self.assertIn("dashboard_channels", setup)
        self.assertIn("Jour de départ", setup)
        self.assertIn("Jour de fin", setup)
        self.assertIn("profils binaires 0/1", setup)
        self.assertIn("Biberonnage à analyser", setup)
        self.assertIn("Durée du biberonnage à analyser", setup)
        self.assertIn('id="feedingDays"', setup)

        dashboard = self.client.get("/dashboard?session_id=test-session").get_data(as_text=True)
        self.assertIn("chartTimeUnit", dashboard)
        self.assertIn("chartCurrentUnit", dashboard)
        self.assertIn("? 'mA' : 'A'", dashboard)
        self.assertIn("INA226 A (0x40)", dashboard)
        self.assertIn("INA226 B (0x41)", dashboard)
        self.assertIn('data-stop-channel="A"', dashboard)
        self.assertIn('data-stop-channel="B"', dashboard)
        self.assertNotIn('id="intervalTables"', dashboard)
        self.assertIn('id="sizingChannelMargins"', dashboard)
        self.assertIn("Verdict et marge DCDC output", dashboard)
        self.assertIn("restant avant la limite", dashboard)
        self.assertIn("Courant de veille théorique et mesuré", dashboard)
        self.assertIn("AUTONOMIE MOINS BONNE", dashboard)
        self.assertIn("Enregistrer le dashboard", dashboard)
        self.assertIn("feedingChannelSummaries", dashboard)
        self.assertIn("Courants CAN anormaux", dashboard)
        self.assertIn("Biberonnage ${feeding.duration_days} jours", dashboard)
        self.assertNotIn("feedingSocChart", dashboard)
        self.assertNotIn("feedingPieChart", dashboard)
        self.assertIn('id="analysisDurationWarning"', dashboard)
        self.assertNotIn("Énergie cumulée INA226", dashboard)
        self.assertNotIn('id="feedingPanel"', dashboard)
        self.assertIn('id="saveDashboardDialog"', dashboard)
        self.assertNotIn("window.prompt", dashboard)
        self.assertNotIn("Consommation mesurée profilée", dashboard)
        self.assertNotIn("Capacité utile", dashboard)
        self.assertNotIn("metric('Intervalles conformes'", dashboard)
        self.assertNotIn("hidden: isSizing", dashboard)

    def test_analysis_logs_entry_opens_workstation_home(self):
        response = self.client.post(
            "/import-theory",
            data={"theory_snapshot": json.dumps({"project": {}, "devices": []})},
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/")

    def test_large_theory_snapshot_does_not_trigger_413(self):
        snapshot = {
            "project": {"name": "Projet volumineux"},
            "devices": [
                {
                    "id": "large-device",
                    "name": "ECU avec profils détaillés",
                    "profile_payload": "x" * 700_000,
                },
            ],
        }
        response = self.client.post(
            "/import-theory",
            data={"theory_snapshot": json.dumps(snapshot)},
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/")
        self.assertEqual(
            self.module.theory_snapshot()["project"]["name"],
            "Projet volumineux",
        )

    def test_dashboard_entry_opens_database_import_for_selected_modes(self):
        can_response = self.client.get("/dashboard/open?mode=can")
        self.assertEqual(can_response.status_code, 302)
        self.assertEqual(can_response.headers["Location"], "/dashboard/import")

        digital_without_measurement = self.client.get("/dashboard/open?mode=digital")
        self.assertEqual(digital_without_measurement.status_code, 302)
        self.assertEqual(
            digital_without_measurement.headers["Location"],
            "/dashboard/import",
        )

        self.module.save_measurement_session({
            "id": "digital-completed",
            "status": "completed",
            "acquisition_mode": "digital",
            "started_at": 1000,
            "ended_at": 1010,
            "channels": ["A", "B"],
        })
        digital_response = self.client.get("/dashboard/open?mode=digital")
        self.assertEqual(digital_response.status_code, 302)
        self.assertEqual(
            digital_response.headers["Location"],
            "/dashboard/import",
        )
        import_response = self.client.get(digital_response.headers["Location"])
        self.assertEqual(import_response.status_code, 200)
        self.assertIn("Importer et décoder les logs CAN", import_response.get_data(as_text=True))

    def test_dashboard_is_available_offline_without_selecting_acquisition_mode(self):
        from html.parser import HTMLParser

        class Buttons(HTMLParser):
            def __init__(self):
                super().__init__()
                self.buttons = {}

            def handle_starttag(self, tag, attributes):
                attributes = dict(attributes)
                if tag == 'a' and attributes.get('id'):
                    self.buttons[attributes['id']] = attributes

        with patch.object(self.module, 'ensure_esp32_network', side_effect=AssertionError('Offline consultation must not connect Wi-Fi')), \
             patch.object(self.module, 'esp32_request', side_effect=AssertionError('Offline consultation must not contact hardware')):
            home = self.client.get('/')
            parser = Buttons()
            parser.feed(home.get_data(as_text=True))
            button = parser.buttons['dashboardButton']
            self.assertNotIn('disabled-link', button.get('class', ''))
            self.assertNotIn('aria-disabled', button)
            self.assertEqual(button['href'], '/dashboard/open')
            self.assertEqual(self.client.get(button['href'], follow_redirects=True).status_code, 200)
            self.assertEqual(self.client.get('/api/database_status').status_code, 200)
            self.assertEqual(self.client.get('/dashboard/setup?session_id=test-session').status_code, 200)
            self.assertEqual(self.client.get('/api/dashboard_report?session_id=test-session').status_code, 200)

    def test_oled_failure_does_not_connect_wifi_or_block_local_reports(self):
        from urllib.error import URLError
        with patch.object(self.module, 'ESP32_SIMULATOR', False), \
             patch.object(self.module, 'ensure_esp32_network', side_effect=AssertionError('Optional OLED must not connect Wi-Fi')), \
             patch.object(self.module, 'urlopen', side_effect=URLError('OLED and ESP32 disconnected')) as request:
            response = self.client.post('/api/esp_display', json={'state': 'welcome'})
            self.assertEqual(response.status_code, 502)
            self.assertEqual(request.call_args.kwargs['timeout'], .5)
            self.assertEqual(self.client.get('/api/dashboard_report?session_id=test-session').status_code, 200)

            session = self.module.measurement_sessions()[0]
            session.update(status='running', acquisition_mode='digital')
            self.module.active_measurement.update(session)
            self.module.save_measurement_session(session)
            report = self.client.get('/api/dashboard_report?session_id=test-session')
            self.assertEqual(report.status_code, 200)
            self.assertTrue(report.get_json()['has_data'])
            self.assertEqual(request.call_args.kwargs['timeout'], .5)

    def test_real_frequency_is_averaged_from_active_ina226(self):
        frequency = self.module.actual_frequency_from_status({
            "frequency": 1000,
            "sensors": {
                "A": {"running": True, "samples": 990, "frequency": 990},
                "B": {"running": True, "samples": 1000, "frequency": 1000},
            },
        })
        self.assertEqual(frequency, 995)

    def test_chart_decimation_preserves_extremes_and_limits_payload(self):
        points = [
            {"time_s": index / 1000, "current_A": 25 if index == 4321 else -12 if index == 6789 else 0.2}
            for index in range(12000)
        ]
        reduced = self.module.decimate_chart_points(points, "current_A", max_points=4000)
        self.assertLessEqual(len(reduced), 4002)
        self.assertEqual(reduced[0], points[0])
        self.assertEqual(reduced[-1], points[-1])
        self.assertIn(25, [point["current_A"] for point in reduced])
        self.assertIn(-12, [point["current_A"] for point in reduced])

    def test_c3_firmware_bypasses_can_in_digital_mode(self):
        firmware_path = os.path.join(
            "can_server", "esp32C3-multi-INA226", "esp32C3-multi-INA226.ino"
        )
        with open(firmware_path, encoding="utf-8") as firmware:
            source = firmware.read()
        self.assertIn("if (!digitalStreamMode && !initializeCan(requestedOscillatorMHz))", source)
        self.assertIn("canReady = CAN.setMode(MCP_NORMAL) == CAN_OK", source)
        self.assertIn("if (digitalStreamMode && !transportReady)", source)
        self.assertNotIn("initializeCan(16)", source)
        self.assertIn("if (streamClient) streamClient.stop()", source)
        self.assertIn("if (digitalStreamMode && !streamConnected)", source)
        self.assertIn('requestedMode != "can" && requestedMode != "digital"', source)
        self.assertIn("CAN obligatoire : MCP2515 indisponible", source)
        web_loop = source.index("for (;;) {", source.index("void taskWeb"))
        http_handler = source.index("server.handleClient();", web_loop)
        tcp_accept = source.index("if (streamServer.hasClient())", web_loop)
        self.assertLess(http_handler, tcp_accept)
        self.assertIn('xTaskCreate(taskWeb, "taskWeb", 8192', source)

    def test_oled_workflow_api_validates_and_forwards_display_states(self):
        states = ("welcome", "digital_selected", "can_selected")
        with patch.object(
            self.module,
            "esp32_request",
            return_value={"status": "success"},
        ) as esp_request:
            for state in states:
                response = self.client.post("/api/esp_display", json={"state": state})
                self.assertEqual(response.status_code, 200)

            invalid = self.client.post("/api/esp_display", json={"state": "not-a-screen"})
            self.assertEqual(invalid.status_code, 400)

        self.assertEqual(esp_request.call_count, len(states))
        for call, state in zip(esp_request.call_args_list, states):
            self.assertEqual(call.args, ("GET", "/api/display", {"state": state}))

    def test_oled_workflow_is_connected_to_workstation_and_acquisition_pages(self):
        home = self.client.get("/").get_data(as_text=True)
        measurement = self.client.get("/measurement?mode=digital").get_data(as_text=True)
        self.assertIn("sendOledState('welcome')", home)
        self.assertIn("digital_selected", home)
        self.assertIn("showSelectedModeOnOled();", measurement)
        self.assertIn("Activez l’enregistrement sur CANalyzer", measurement)

    def test_oled_refresh_does_not_change_timer_driven_acquisition(self):
        firmware_path = os.path.join(
            "can_server", "esp32C3-multi-INA226", "esp32C3-multi-INA226.ino"
        )
        with open(firmware_path, encoding="utf-8") as firmware:
            source = firmware.read()
        oled_task = source[source.index("void taskOled"):source.index("volatile uint32_t acqCountA")]
        self.assertIn('oled.drawString(0, slot, padded)', oled_task)
        self.assertIn("pdMS_TO_TICKS(1000)", oled_task)
        self.assertNotIn("readINA226ShuntRaw", oled_task)
        self.assertIn("esp_timer_start_periodic(acqTimer, 1000000ULL / timerFrequency)", source)
        self.assertIn('server.on("/api/display", HTTP_GET, handleApiDisplay)', source)

    def test_can_choice_opens_asc_import_without_starting_measurement(self):
        response = self.client.post(
            "/api/control_esp_acquisition",
            data={
                "acquisition_mode": "can",
                "freq": "100",
                "dureeValeur": "2",
                "dureeUnite": "s",
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["session"]["acquisition_mode"], "can")
        self.assertEqual(payload["session"]["source_files"], [])
        self.assertEqual(payload["next_url"], "/dashboard/import")
        self.assertIn("CANalyzer", payload["message"])
        self.client.post(
            "/api/control_esp_acquisition",
            data={"action": "stop", "sensor": "ALL"},
        )

    def test_can_start_forwards_physical_crystal_and_reports_unconfirmed_tx(self):
        status = {
            "running": True,
            "sensors": {},
            "can": {"ready": True, "oscillator_mhz": 16, "tx_ok": 0, "tx_errors": 1},
        }
        with patch.object(self.module, "esp32_request", return_value=status) as esp_request:
            response = self.client.post("/api/control_esp_acquisition", data={
                "acquisition_mode": "can", "oscillator_mhz": "16",
                "freq": "100", "dureeValeur": "2", "dureeUnite": "s",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(esp_request.call_args.args[:2], ("POST", "/api/acquisition/start"))
        self.assertEqual(esp_request.call_args.args[2]["oscillator_mhz"], 16)
        self.assertEqual(esp_request.call_args.args[2]["mode"], "can")
        payload = response.get_json()
        self.assertEqual(payload["session"]["status"], "running")
        self.assertEqual(payload["acquisition"]["can"]["tx_errors"], 1)
        self.assertIn("Activez l’enregistrement sur CANalyzer", payload["message"])

    def test_invalid_can_crystal_never_reaches_device(self):
        with patch.object(self.module, "esp32_request") as esp_request:
            response = self.client.post("/api/control_esp_acquisition", data={
                "acquisition_mode": "can", "oscillator_mhz": "12",
                "freq": "100", "dureeValeur": "2", "dureeUnite": "s",
            })
        self.assertEqual(response.status_code, 400)
        esp_request.assert_not_called()

    def test_digital_measurement_creates_direct_dashboard_session(self):
        response = self.client.post(
            "/api/control_esp_acquisition",
            data={
                "acquisition_mode": "digital",
                "freq": "100",
                "dureeValeur": "2",
                "dureeUnite": "s",
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["session"]["acquisition_mode"], "digital")
        self.assertTrue(payload["session"]["source_files"][0].startswith("live_"))
        self.assertIn("/dashboard/setup?session_id=", payload["next_url"])
        setup = self.client.get(payload["next_url"]).get_data(as_text=True)
        self.assertIn("Retour à l’acquisition", setup)
        self.client.post(
            "/api/control_esp_acquisition",
            data={"action": "stop", "sensor": "ALL"},
        )

    def test_digital_start_appends_without_discarding_prior_can_or_digital_samples(self):
        database = self.module.get_db_connection()
        database.execute("INSERT INTO measurements(timestamp,channel,current_A,source_file) VALUES(2000,'B',.25,'old-digital')")
        database.commit()
        database.close()
        before = self.client.get('/api/database_status').get_json()['measurement_count']
        response = self.client.post('/api/control_esp_acquisition', data={
            'acquisition_mode':'digital', 'freq':'1000', 'dureeValeur':'1',
            'dureeUnite':'s', 'export_unit':'A',
        })
        self.assertEqual(response.status_code,200)
        session = response.get_json()['session']
        self.assertEqual(session['export_unit'],'A')
        self.assertTrue(session['excel_export_directory'].endswith(session['id']))
        self.assertEqual(self.client.get('/api/database_status').get_json()['measurement_count'],before)
        self.assertTrue(any(item['id']=='test-session' for item in self.module.measurement_sessions()))
        self.client.post('/api/control_esp_acquisition',data={'action':'stop','sensor':'ALL'})

    def test_channels_accept_independent_frequency_and_duration(self):
        response = self.client.post(
            "/api/control_esp_acquisition",
            data={
                "acquisition_mode": "digital",
                "activeA": "1",
                "activeB": "1",
                "freqA": "750",
                "freqB": "250",
                "dureeValeurA": "2",
                "dureeUniteA": "s",
                "dureeValeurB": "1",
                "dureeUniteB": "m",
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        settings = payload["session"]["channel_settings"]
        self.assertEqual(settings["A"]["requested_frequency_hz"], 750)
        self.assertEqual(settings["B"]["requested_frequency_hz"], 250)
        self.assertEqual(settings["A"]["requested_duration_s"], 2)
        self.assertEqual(settings["B"]["requested_duration_s"], 60)
        self.assertEqual(payload["acquisition"]["sensors"]["A"]["duration"], 2)
        self.assertEqual(payload["acquisition"]["sensors"]["B"]["duration"], 60)
        stop_a = self.client.post(
            "/api/control_esp_acquisition",
            data={"action": "stop", "sensor": "A"},
        )
        self.assertEqual(stop_a.status_code, 200)
        stopped_a = stop_a.get_json()
        self.assertFalse(stopped_a["acquisition"]["sensors"]["A"]["running"])
        self.assertTrue(stopped_a["acquisition"]["sensors"]["B"]["running"])
        self.assertEqual(stopped_a["session"]["status"], "running")
        self.assertFalse(stopped_a["session"]["channel_settings"]["A"]["running"])
        self.assertTrue(stopped_a["session"]["channel_settings"]["B"]["running"])
        self.assertIn("canal B continue", stopped_a["message"])

        stop_b = self.client.post(
            "/api/control_esp_acquisition",
            data={"action": "stop", "sensor": "B"},
        )
        self.assertEqual(stop_b.status_code, 200)
        self.assertFalse(stop_b.get_json()["acquisition"]["running"])
        self.assertEqual(stop_b.get_json()["session"]["status"], "stopped")

    def test_digital_dashboard_updates_live_and_survives_early_stop(self):
        response = self.client.post(
            "/api/control_esp_acquisition",
            data={
                "acquisition_mode": "digital",
                "activeA": "1",
                "activeB": "1",
                "freqA": "100",
                "freqB": "10",
                "dureeValeurA": "10",
                "dureeUniteA": "s",
                "dureeValeurB": "10",
                "dureeUniteB": "m",
            },
        )
        self.assertEqual(response.status_code, 200)
        session = response.get_json()["session"]
        session["started_at"] -= 3
        with self.module.measurement_lock:
            self.module.active_measurement["started_at"] = session["started_at"]
            self.module.save_measurement_session(dict(self.module.active_measurement))
        with self.module.simulator_lock:
            self.module.simulator_state["started_at"] -= 3

        database = self.module.get_db_connection()
        for offset in (1, 2, 3):
            database.execute(
                "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,lost_count,source_file) VALUES(?,?,?,?,?,?)",
                (session["started_at"] + offset, "A", 0.1 * offset, 100, 0, session["source_files"][0]),
            )
            database.execute(
                "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,lost_count,source_file) VALUES(?,?,?,?,?,?)",
                (session["started_at"] + offset, "B", 0.2 * offset, 10, 0, session["source_files"][0]),
            )
        database.commit()
        database.close()

        report = self.client.get(
            f"/api/dashboard_report?session_id={session['id']}"
        ).get_json()
        self.assertTrue(report["has_data"])
        channels = {
            item["channel"]: item for item in report["measurement"]["channels"]
        }
        self.assertEqual(channels["A"]["requested_duration_s"], 10)
        self.assertEqual(channels["B"]["requested_duration_s"], 600)
        self.assertGreaterEqual(channels["A"]["actual_duration_s"], 3)
        self.assertGreaterEqual(channels["B"]["actual_duration_s"], 3)

        dashboard = self.client.get(
            f"/dashboard?session_id={session['id']}"
        ).get_data(as_text=True)
        self.assertIn("window.setTimeout(loadReport, 1000)", dashboard)
        self.assertIn("Mesure en cours : attente des premiers", dashboard)

        stopped = self.client.post(
            "/api/control_esp_acquisition",
            data={"action": "stop", "sensor": "ALL"},
        )
        self.assertEqual(stopped.status_code, 200)
        stopped_report = self.client.get(
            f"/api/dashboard_report?session_id={session['id']}"
        ).get_json()
        self.assertTrue(stopped_report["has_data"])
        self.assertEqual(stopped_report["session"]["status"], "stopped")

    def test_log_analysis_also_opens_dashboard_setup(self):
        response = self.client.post("/api/create_analysis_session", json={
            "start_ts": 1000,
            "end_ts": 1010,
            "channels": ["A", "B"],
        })
        self.assertEqual(response.status_code, 200)
        self.assertIn("/dashboard/setup?", response.get_json()["dashboard_url"])

    def test_asc_import_decodes_can_and_creates_dashboard_session(self):
        asc = "\n".join([
            "date 28/07/2026 10:00:00",
            "0.000000 1 101 Rx d 4 E8 03 00 00",
            "0.000000 1 103 Rx d 4 E3 03 00 00",
            "0.100000 1 100 Rx d 4 00 00 C0 3F",
            "0.100000 1 102 Rx d 4 00 00 20 40",
            "0.300000 1 100 Rx d 4 00 00 00 40",
            "0.500000 1 102 Rx d 4 00 00 40 40",
        ]).encode("utf-8")
        response = self.client.post(
            "/api/upload_and_ingest_measures",
            data={"files": (io.BytesIO(asc), "mesure-can.asc")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["measurements_count"], 4)
        self.assertEqual(payload["channels"], ["A", "B"])
        self.assertEqual(payload["actual_frequency_hz"], 998)
        self.assertEqual(payload["channel_settings"]["A"]["actual_frequency_hz"], 1000)
        self.assertEqual(payload["channel_settings"]["B"]["actual_frequency_hz"], 995)
        self.assertAlmostEqual(payload["channel_settings"]["A"]["actual_duration_s"], 0.2, places=6)
        self.assertAlmostEqual(payload["channel_settings"]["B"]["actual_duration_s"], 0.4, places=6)
        file_settings = payload["files_processed"][0]["channel_settings"]
        self.assertEqual(file_settings["A"]["actual_frequency_hz"], 1000)
        self.assertEqual(file_settings["B"]["actual_frequency_hz"], 995)
        self.assertAlmostEqual(file_settings["A"]["actual_duration_s"], 0.2, places=6)
        self.assertAlmostEqual(file_settings["B"]["actual_duration_s"], 0.4, places=6)
        self.assertIn("/dashboard/setup?session_id=", payload["dashboard_setup_url"])
        self.assertEqual(payload["session"]["status"], "imported")
        self.assertEqual(payload["session"]["acquisition_mode"], "can")
        self.assertEqual(payload["session"]["uploaded_filenames"], ["mesure-can.asc"])
        self.assertTrue(payload["session"]["source_files"][0].endswith("_mesure-can.asc"))
        status = self.client.get("/api/database_status").get_json()
        self.assertEqual(status["dashboard_scope"], "database")
        database_session_id = status["dashboard_setup_url"].split("session_id=", 1)[1]
        self.assertTrue(database_session_id.startswith("database-"))
        setup = self.client.get(status["dashboard_setup_url"]).get_data(as_text=True)
        self.assertIn("Préparer le dashboard", setup)
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": database_session_id,
            "analysis_type": "dcdc",
            "temperature_c": 20,
            "device_ids": ["d1", "d2"],
            "dashboard_channels": ["A", "B"],
        })
        self.assertEqual(response.status_code, 200)
        report = self.client.get(
            f"/api/dashboard_report?session_id={database_session_id}"
        ).get_json()
        self.assertEqual(
            [channel["samples"] for channel in report["measurement"]["channels"]],
            [13, 13],
        )
        self.assertEqual(report["session"]["database_wide"], True)

    def test_database_dashboard_is_rebuilt_after_session_metadata_is_lost(self):
        database = self.module.get_db_connection()
        database.execute(
            "INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,source_file) VALUES(2000,'A',.5,50,'retained.asc')"
        )
        database.commit()
        database.close()
        self.module.write_json_file(self.module.SESSIONS_FILE, [])

        status = self.client.get("/api/database_status").get_json()
        self.assertEqual(status["measurement_count"], 23)
        self.assertIn("database-", status["dashboard_setup_url"])
        session_id = status["dashboard_setup_url"].split("session_id=", 1)[1]
        setup = self.client.get(status["dashboard_setup_url"]).get_data(as_text=True)
        self.assertIn('value="AB"', setup)
        response = self.client.post("/api/configure_dashboard", json={
            "session_id": session_id,
            "analysis_type": "dcdc",
            "temperature_c": 20,
            "device_ids": ["d1", "d2"],
        })
        self.assertEqual(response.status_code, 200)
        report = self.client.get(
            f"/api/dashboard_report?session_id={session_id}"
        ).get_json()
        self.assertEqual(report["measurement"]["channels"][0]["samples"], 12)

    def test_sizing_single_raw_peak_and_missing_minutes_per_channel(self):
        session = self.module.measurement_sessions()[0]
        session.update(ended_at=1300, actual_duration_s=300, requested_duration_s=300)
        self.module.save_measurement_session(session)
        conn = self.module.get_db_connection()
        conn.execute('DELETE FROM measurements')
        samples = [(1000 + i / 10, 'A', 80 if i == 1234 else 70, 10, 'short.asc') for i in range(3000)]
        samples += [(1000 + i / 10, 'B', 70, 10, 'short.asc') for i in range(1800)]
        conn.executemany('INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,source_file) VALUES(?,?,?,?,?)', samples)
        conn.commit()
        conn.close()
        for mode in ['dcdc', 'wltc']:
            response = self.client.post('/api/configure_dashboard', json={
                'session_id': 'test-session', 'analysis_type': mode, 'temperature_c': -7,
                'device_ids': ['d1', 'd2'], 'start_minute': 0, 'end_minute': 6,
            })
            self.assertEqual(response.status_code, 200)  # The requested view can exceed the ASC duration.
            report = self.client.get('/api/dashboard_report?session_id=test-session').get_json()
            intervals = report['analysis']['intervals']
            spike_interval = next(item for item in intervals if item['start_s'] <= 123.4 < item['end_s'])
            self.assertEqual(spike_interval['sample_checks']['A']['status'], 'fail')
            self.assertEqual(spike_interval['sample_checks']['A']['exceedances'], 1)
            self.assertEqual(spike_interval['sample_checks']['B']['exceedances'], 0)
            self.assertLess(spike_interval['measured_average_channel_A'], 71)
            last = intervals[-1]
            self.assertTrue(last['sample_checks']['A']['missing_ranges'])
            self.assertTrue(last['sample_checks']['B']['missing_ranges'])
            self.assertEqual(report['analysis']['end_minute'], 6)
        conn = self.module.get_db_connection()
        conn.execute("UPDATE measurements SET current_A=79.9 WHERE channel='A' AND current_A=80")
        conn.commit()
        conn.close()
        self.client.post('/api/configure_dashboard', json={
            'session_id': 'test-session', 'analysis_type': 'dcdc', 'temperature_c': -7,
            'device_ids': ['d1', 'd2'], 'end_minute': 6,
        })
        report = self.client.get('/api/dashboard_report?session_id=test-session').get_json()
        checks = report['analysis']['intervals'][0]['sample_checks']
        self.assertEqual(checks['A']['status'], 'pass')
        self.assertEqual(checks['B']['status'], 'missing')

    def test_peak_exactly_at_selected_end_is_checked(self):
        result = self.module.compare_interval(
            [{'time_s': 60, 'current_A': 80}], 70, [(0, 60)], 0, 60, include_end=True,
        )
        self.assertEqual(result['samples'], 1)
        self.assertEqual(result['exceedances'], 1)
        self.assertEqual(result['status'], 'fail')

    def test_asc_durations_follow_log_axis_despite_repeated_time_sync(self):
        asc = b'date 01/11/2026 10:00:00\n0.0 1 100 Rx d 4 00 00 80 3F\n0.0 1 102 Rx d 4 00 00 80 3F\n0.1 1 105 Rx d 4 00 10 00 69\n119.9 1 102 Rx d 4 00 00 80 3F\n120.0 1 105 Rx d 4 00 20 00 69\n299.9 1 100 Rx d 4 00 00 80 3F\n'
        data = self.client.post('/api/upload_and_ingest_measures', data={'files': (io.BytesIO(asc), 'duration.asc')}).get_json()
        self.assertAlmostEqual(data['channel_settings']['A']['actual_duration_s'], 299.9, places=5)
        self.assertAlmostEqual(data['channel_settings']['B']['actual_duration_s'], 119.9, places=5)

    def test_sizing_and_wltc_minute_windows_filter_actual_measurements(self):
        session = self.module.measurement_sessions()[0]
        session.update(ended_at=1600, actual_duration_s=600, requested_duration_s=600)
        self.module.save_measurement_session(session)
        conn = self.module.get_db_connection()
        conn.execute('DELETE FROM measurements')
        conn.executemany('INSERT INTO measurements(timestamp,channel,current_A,frequency_Hz,source_file) VALUES(?,?,?,?,?)', [
            (1000, 'A', 999, 1000, 'window.asc'),
            (1120, 'A', 20, 1000, 'window.asc'),
            (1180, 'A', 30, 1000, 'window.asc'),
            (1240, 'A', 40, 1000, 'window.asc'),
            (1300, 'A', 999, 1000, 'window.asc'),
        ])
        conn.commit()
        conn.close()
        for mode in ['dcdc', 'wltc']:
            response = self.client.post('/api/configure_dashboard', json={
                'session_id': 'test-session', 'analysis_type': mode,
                'temperature_c': 20, 'device_ids': ['d1'],
                'start_minute': 2, 'end_minute': 4,
            })
            self.assertEqual(response.status_code, 200)
            report = self.client.get('/api/dashboard_report?session_id=test-session').get_json()
            self.assertEqual(report['analysis']['start_minute'], 2)
            self.assertEqual(report['analysis']['end_minute'], 4)
            self.assertEqual(report['measurement']['channels'][0]['samples'], 3)
            self.assertEqual(report['measurement']['channels'][0]['actual_duration_s'], 120)
            self.assertEqual(report['measurement']['channels'][0]['peak_current_A'], 40)
            self.assertEqual([p['time_s'] for p in report['measurement']['series'][0]['points'] if p['current_A'] is not None], [120, 180, 240])
            self.assertIsNone(report['feeding'])
            for start, end in [(-1, 4), (4, 2), ('nan', 4), (2, 'inf')]:
                response = self.client.post('/api/configure_dashboard', json={
                    'session_id': 'test-session', 'analysis_type': mode,
                    'temperature_c': 20, 'device_ids': ['d1'],
                    'start_minute': start, 'end_minute': end,
                })
                self.assertEqual(response.status_code, 400)

    def test_database_channel_durations_and_frequencies_are_independent(self):
        conn = self.module.get_db_connection()
        conn.execute("DELETE FROM measurements WHERE channel='B' AND timestamp > 1004")
        conn.execute("UPDATE measurements SET frequency_Hz=250 WHERE channel='B'")
        conn.commit()
        conn.close()
        settings = self.client.get('/api/database_status').get_json()['channel_settings']
        self.assertEqual(settings['A']['actual_duration_s'], 10)
        self.assertEqual(settings['A']['actual_frequency_hz'], 997)
        self.assertEqual(settings['B']['actual_duration_s'], 4)
        self.assertEqual(settings['B']['actual_frequency_hz'], 250)
        page = self.client.get('/dashboard/import').get_data(as_text=True)
        self.assertIn('id="fileResultsA"', page)
        self.assertIn('id="fileResultsB"', page)
        self.assertNotIn('id="databaseDuration"', page)

    def test_log_explorer_optional_filters_and_microamp_units(self):
        from datetime import datetime
        start = datetime(2026, 10, 31, 23, 59, 59).timestamp()
        conn = self.module.get_db_connection()
        conn.execute('DELETE FROM measurements')
        conn.executemany('INSERT INTO measurements(timestamp,channel,current_A,source_file) VALUES(?,?,?,?)', [
            (start + .123456, 'A', .00002, 'first.asc'),
            (start + .123456, 'B', .002, 'first.asc'),
            (start + 2.234567, 'A', -.003, 'second.asc'),
            (start + 2.345678, 'B', 10, 'second.asc'),
        ])
        conn.commit()
        conn.close()
        all_rows = self.client.get('/api/log_explore').get_json()['rows']
        self.assertEqual(len(all_rows), 4)
        data = self.client.get('/api/log_explore?channel=A&threshold=19&unit=uA&graph=1').get_json()
        self.assertEqual(len(data['rows']), 1)
        self.assertAlmostEqual(data['rows'][0]['timestamp'], start + .123456, places=6)
        self.assertEqual(data['matched_samples'], 1)
        data = self.client.get('/api/log_explore?threshold=1&unit=mA&absolute=1').get_json()
        self.assertEqual(len(data['rows']), 3)
        data = self.client.get('/api/log_explore?day=2026-11-01&channel=A&source=second.asc').get_json()
        self.assertEqual(len(data['rows']), 1)
        data = self.client.get(f'/api/log_explore?start={start}&end={start+.123456}').get_json()
        self.assertEqual(len(data['rows']), 2)
        self.assertEqual(len(self.client.get('/api/log_catalog').get_json()['days']), 2)
        for query in ['start=nan', 'start=2&end=1', 'unit=kA&threshold=1', 'threshold=inf', 'channel=C', 'day=oops', 'after_ts=1']:
            self.assertEqual(self.client.get('/api/log_explore?' + query).status_code, 400, query)

    def test_log_explorer_keyset_and_peak_preserving_graph(self):
        conn = self.module.get_db_connection()
        conn.execute('DELETE FROM measurements')
        samples = [(1700000000 + i / 3000, channel, 999 if i == 1234 else .1, 'fast.asc')
                   for i in range(6000) for channel in ['A', 'B']]
        conn.executemany('INSERT INTO measurements(timestamp,channel,current_A,source_file) VALUES(?,?,?,?)', samples)
        conn.commit()
        conn.close()
        seen, cursor = [], ''
        while True:
            data = self.client.get('/api/log_explore?limit=500' + cursor).get_json()
            seen.extend(row['id'] for row in data['rows'])
            if not data['has_more']:
                break
            cursor = f"&after_ts={data['next']['timestamp']}&after_id={data['next']['id']}"
        self.assertEqual(len(seen), 12000)
        self.assertEqual(len(set(seen)), 12000)
        data = self.client.get('/api/log_explore?graph=1').get_json()
        self.assertLessEqual(len(data['series']), 2002)
        self.assertEqual(data['matched_samples'], 12000)
        self.assertEqual(max(row['maximum'] for row in data['series']), 999)
        self.assertEqual({row['channel'] for row in data['series']}, {'A', 'B'})

    def test_native_import_streams_without_read_all_and_preserves_prior_logs(self):
        from werkzeug.datastructures import FileStorage
        from datetime import datetime
        class Stream(io.BytesIO):
            def read(self, *args):
                raise AssertionError('Whole file must not be loaded')
        asc = b'date 01/11/2026 10:00:00\n0.123456 1 100 Rx d 4 00 00 80 3F\n'
        for name in ['day1.asc', 'day2.asc']:
            with self.module.app.test_request_context('/api/upload_and_ingest_measures', method='POST'):
                response = self.module.upload_and_ingest_measures([FileStorage(stream=Stream(asc), filename=name)])
                self.assertEqual(response.status_code, 200)
                self.assertAlmostEqual(response.get_json()['started_at'], datetime(2026, 11, 1, 10).timestamp() + .123456, places=6)
        self.assertEqual(len(self.client.get('/api/log_explore').get_json()['rows']), 24)

    def test_real_canalyzer_files_include_empty_log_and_channel_durations(self):
        from pathlib import Path
        paths = sorted(Path("test_asc").glob("*.asc"))
        self.client.post("/api/purge_database")
        with patch.object(self.module, "backup_to_sharepoint_local_mount"):
            response = self.client.post("/api/upload_and_ingest_measures", data={
                "files": [(io.BytesIO(p.read_bytes()), p.name) for p in paths]
            })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["files_count"], 4)
        self.assertEqual(data["files_processed"][1]["measurements"], 0)
        main = data["files_processed"][3]["channel_settings"]
        self.assertAlmostEqual(main["A"]["actual_duration_s"], 300, delta=0.1)
        self.assertAlmostEqual(main["B"]["actual_duration_s"], 600, delta=0.1)
        self.assertFalse(data["files_processed"][3]["timestamp_warning"])
        source = data["files_processed"][3]["source_file"]
        for channel in ("A", "B"):
            settings = main[channel]
            rows = self.client.get('/api/log_explore', query_string={
                'source': source, 'channel': channel, 'start': settings['ended_at'] + .001,
            }).get_json()
            self.assertEqual(rows['rows'], [])
            self.assertFalse(rows['has_more'])
        after_a = main['A']['ended_at'] + .001
        continuing_b = self.client.get('/api/log_explore', query_string={
            'source': source, 'channel': 'B', 'start': after_a,
        }).get_json()
        self.assertTrue(continuing_b['rows'])
        self.assertEqual(continuing_b['period']['end'], main['B']['ended_at'])

        for file, path in zip(data["files_processed"], paths):
            self.assertEqual(file["size_bytes"], path.stat().st_size)
            for settings in file["channel_settings"].values():
                self.assertAlmostEqual(settings["actual_frequency_hz"], 100, delta=1)
                self.assertAlmostEqual(settings["ended_at"] - settings["started_at"], settings["actual_duration_s"], places=6)
        from datetime import datetime
        first = data["files_processed"][2]["channel_settings"]["A"]
        self.assertAlmostEqual(first["started_at"], datetime(2026, 11, 2, 11, 5, 9, 577000).timestamp() + .000863, places=5)
        self.assertAlmostEqual(first["actual_duration_s"], 2.143936, places=5)

        status = self.client.get("/api/database_status").get_json()
        self.assertEqual(status["file_count"], 4)
        for channel, count, duration in [("A", 31215, 312.108452), ("B", 61139, 612.093945)]:
            settings = status["channel_settings"][channel]
            self.assertEqual(settings["measurements"], count)
            self.assertAlmostEqual(settings["actual_duration_s"], duration, places=4)
            self.assertAlmostEqual(data["channel_settings"][channel]["actual_duration_s"], duration, places=4)
        self.client.post("/api/purge_database")
        self.assertEqual(self.client.get("/api/database_status").get_json()["file_count"], 0)

    def test_explorer_channels_stop_independently_in_either_order(self):
        conn = self.module.get_db_connection()
        conn.execute("DELETE FROM measurements")
        for short, long in [('A', 'B'), ('B', 'A')]:
            conn.execute("DELETE FROM measurements")
            conn.executemany('INSERT INTO measurements(timestamp,channel,current_A,source_file) VALUES(?,?,?,?)', [
                (1000, short, 1, 'stop.asc'), (1300, short, 1, 'stop.asc'),
                (1000, long, 2, 'stop.asc'), (1301, long, 2, 'stop.asc'), (1600, long, 2, 'stop.asc'),
            ])
            conn.commit()
            stopped = self.client.get('/api/log_explore', query_string={'channel': short, 'start': 1300.001}).get_json()
            self.assertEqual(stopped['rows'], [])
            running = self.client.get('/api/log_explore', query_string={'channel': long, 'start': 1300.001, 'limit': 1}).get_json()
            self.assertEqual([row['channel'] for row in running['rows']], [long])
            self.assertEqual(running['period']['end'], 1600)
            cursor = running['next']
            last = self.client.get('/api/log_explore', query_string={'channel': long, 'start': 1300.001, 'limit': 1, 'after_ts': cursor['timestamp'], 'after_id': cursor['id']}).get_json()
            self.assertEqual(last['rows'][0]['timestamp'], 1600)
            self.assertFalse(last['has_more'])
        conn.close()
        with self.module.app.test_request_context():
            page = self.module.render_template('log_explorer.html')
        for channel in ('A', 'B'):
            self.assertIn(f'id="logRows{channel}"', page)
            self.assertIn(f'id="logNext{channel}"', page)

    def test_explorer_direct_pages_count_filtered_channels_independently(self):
        from datetime import datetime
        origin = datetime(2026, 11, 2, 10).timestamp()
        conn = self.module.get_db_connection()
        for channel, count in [('A', 1003), ('B', 401)]:
            conn.executemany('INSERT INTO measurements(timestamp,channel,current_A,source_file) VALUES(?,?,?,?)',
                             [(origin + index / 1000, channel, index / 1000, 'pages.asc') for index in range(count)])
        conn.commit()
        conn.close()

        for channel, count, pages, tail in [('A', 1003, 11, 3), ('B', 401, 5, 1)]:
            for page in [pages, 2, 1, 999999]:
                response = self.client.get('/api/log_explore', query_string={
                    'source': 'pages.asc', 'channel': channel, 'limit': 100, 'page': page})
                self.assertEqual(response.status_code, 200)
                data = response.get_json()
                actual_page = min(page, pages)
                self.assertEqual((data['total_samples'], data['total_pages'], data['page']), (count, pages, actual_page))
                self.assertEqual(len(data['rows']), tail if actual_page == pages else 100)
                self.assertEqual(data['rows'][0]['timestamp'], origin + (actual_page - 1) / 10)
                self.assertEqual({row['channel'] for row in data['rows']}, {channel})
                self.assertEqual(data['has_more'], actual_page < pages)

        filters = {'source': 'pages.asc', 'channel': 'A', 'limit': 100, 'page': 6,
                   'day': '2026-11-02', 'unit': 'mA', 'threshold': 500, 'operator': 'gte'}
        data = self.client.get('/api/log_explore', query_string=filters).get_json()
        self.assertEqual((data['total_samples'], data['total_pages'], len(data['rows'])), (503, 6, 3))
        self.assertEqual(data['rows'][0]['timestamp'], origin + 1)
        data = self.client.get('/api/log_explore', query_string={**filters, 'threshold': 2000}).get_json()
        self.assertEqual((data['total_samples'], data['total_pages'], data['page'], data['rows']), (0, 0, 0, []))
        for page in ['0', '-1', '1.5', 'abc']:
            self.assertEqual(self.client.get('/api/log_explore', query_string={'page': page}).status_code, 400)

    def test_explorer_page_boundaries_preserve_equal_timestamps(self):
        conn = self.module.get_db_connection()
        conn.executemany('INSERT INTO measurements(timestamp,channel,current_A,source_file) VALUES(?,?,?,?)',
                         [(1000, 'A', index, 'identical.asc') for index in range(250)])
        conn.commit()
        conn.close()
        ids = []
        for page in (1, 2, 3):
            data = self.client.get('/api/log_explore', query_string={
                'source': 'identical.asc', 'channel': 'A', 'limit': 100, 'page': page}).get_json()
            ids.extend(row['id'] for row in data['rows'])
        self.assertEqual(len(ids), 250)
        self.assertEqual(len(set(ids)), 250)
        self.assertEqual(ids, sorted(ids))

    def test_database_reset_clears_measurements_and_sessions(self):
        self.client.post("/api/save_dashboard", json={
            "session_id": "test-session",
            "name": "Dashboard à supprimer avec la base",
        })
        response = self.client.post("/api/purge_database")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertGreater(payload["deleted_measurements"], 0)
        status = self.client.get("/api/database_status").get_json()
        self.assertEqual(status["measurement_count"], 0)
        self.assertIsNone(status["latest_session_id"])
        self.assertEqual(self.module.measurement_sessions(), [])
        conn = self.module.get_db_connection()
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM saved_dashboards").fetchone()[0], 0)
        conn.close()

    def test_wltc_intervals_use_profile_windows(self):
        intervals = self.module.analysis_interval_definitions("wltc")
        self.assertEqual(
            [(item["start_s"], item["end_s"]) for item in intervals],
            [(0, 100), (100.8, 240), (240, 420), (420, 489.6), (735, 1500), (1500, 1800)],
        )


if __name__ == "__main__":
    unittest.main()
