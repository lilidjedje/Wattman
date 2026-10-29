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
        snapshot = {
            "project": {"name": "Validation"},
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
            ],
        }
        module.write_json_file(module.THEORY_FILE, snapshot)
        module.write_json_file(module.SESSIONS_FILE, [])
        module.init_db()
        database = module.get_db_connection()
        database.execute("DELETE FROM measurements")
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
        self.assertEqual(first_interval["status"], "fail")
        first_device = report["analysis"]["selected_devices"][0]["intervals"][0]
        self.assertEqual(first_device["expected_A"], 40)
        self.assertAlmostEqual(first_device["measured_allocated_A"], 110 * 40 / 70)
        self.assertEqual(first_device["status"], "fail")

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
        self.assertGreater(report["autonomy"]["days"], 0)
        self.assertEqual(report["analysis"]["capacity_factor"], 1)
        self.assertEqual(report["analysis"]["start_day"], 0)
        self.assertEqual(report["analysis"]["end_day"], 2)
        self.assertEqual(len(report["analysis"]["intervals"]), 4)
        self.assertEqual(
            [interval["theoretical_A"] for interval in report["analysis"]["intervals"]],
            [0.01, 0, 0.01, 0],
        )
        self.assertAlmostEqual(report["autonomy"]["theoretical_daily_consumption_Ah"], 0.096)
        self.assertEqual(report["autonomy"]["status"], "worse")
        self.assertGreater(report["autonomy"]["excess_range_Ah"], 0)
        intervals = report["analysis"]["intervals"]
        self.assertEqual(intervals[0]["samples_channel_A"], 11)
        self.assertEqual(intervals[0]["samples_channel_B"], 11)
        self.assertTrue(all(item["samples_channel_A"] == 0 for item in intervals[1:]))
        self.assertTrue(all(item["samples_channel_B"] == 0 for item in intervals[1:]))
        self.assertTrue(all(item["status_channel_A"] == "no_data" for item in intervals[1:]))
        self.assertTrue(all(item["status_channel_B"] == "no_data" for item in intervals[1:]))

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

    def test_dashboard_can_be_saved_and_opened_from_history(self):
        self.assertEqual(self.configure("dcdc", 20, ["d1", "d2"]).status_code, 200)
        response = self.client.post("/api/save_dashboard", json={
            "session_id": "test-session",
            "name": "Validation DCDC enregistrée",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["dashboard"]["source"], "digital")
        session = next(
            item for item in self.module.measurement_sessions()
            if item["id"] == "test-session"
        )
        self.assertTrue(session["dashboard_saved"])
        self.assertEqual(session["dashboard_source"], "digital")
        self.assertEqual(session["dashboard_name"], "Validation DCDC enregistrée")
        home = self.client.get("/").get_data(as_text=True)
        self.assertIn("Historique des dashboards enregistrés", home)
        self.assertIn("Dashboards en valeurs numériques", home)
        self.assertIn("Dashboards issus du CAN", home)
        self.assertIn("Validation DCDC enregistrée", home)
        self.assertIn("/dashboard?session_id=test-session", home)

    def test_numeric_and_can_dashboard_histories_are_independent(self):
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
        })
        can = self.client.post("/api/save_dashboard", json={
            "session_id": "can-session",
            "name": "Même campagne",
        }).get_json()
        self.assertEqual(digital["dashboard"]["source"], "digital")
        self.assertEqual(can["dashboard"]["source"], "can")
        home = self.client.get("/").get_data(as_text=True)
        self.assertIn("/dashboard?session_id=test-session", home)
        self.assertIn("/dashboard?session_id=can-session", home)
        self.assertEqual(home.count("Même campagne"), 2)

    def test_new_measurement_cleanup_preserves_only_saved_dashboards(self):
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
        self.assertEqual(deleted["sessions"], 1)
        self.assertEqual(
            [item["id"] for item in self.module.measurement_sessions()],
            ["test-session"],
        )
        database = self.module.get_db_connection()
        self.assertEqual(
            database.execute(
                "SELECT COUNT(*) FROM measurements WHERE source_file = 'temporary-source'"
            ).fetchone()[0],
            0,
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
        self.assertEqual(feeding["battery_capacity_Ah"], 80)
        self.assertAlmostEqual(feeding["channels"][0]["transferred_Ah"], 50 * 10 / 3600)
        self.assertAlmostEqual(feeding["channels"][1]["transferred_Ah"], 60 * 10 / 3600)
        self.assertAlmostEqual(feeding["total_transferred_Ah"], 110 * 10 / 3600)
        self.assertAlmostEqual(feeding["total_cost_ef_Wh"], 110 * 10 / 3600 * 14.5)
        self.assertAlmostEqual(feeding["theoretical_energy_Ah"], 0.01 * 10 / 3600)
        self.assertAlmostEqual(feeding["theoretical_cost_ef_Wh"], 0.01 * 10 / 3600 * 14.5)
        self.assertAlmostEqual(
            feeding["ending_soc_percent"],
            90 - (110 * 10 / 3600) / 80 * 100,
        )
        self.assertAlmostEqual(
            feeding["theoretical_ending_soc_percent"],
            90 - (0.01 * 10 / 3600) / 80 * 100,
        )
        self.assertAlmostEqual(
            feeding["energy_difference_Ah"],
            (110 - 0.01) * 10 / 3600,
        )
        for channel in feeding["channels"]:
            self.assertIn("theoretical_soc_points", channel)
            self.assertIn("soc_points", channel)
            self.assertIn("battery_need_percent", channel)
            self.assertIn("energy_lost_percent", channel)
        self.assertEqual(feeding["number_of_measurements"], 1)

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
        self.assertIn("dashboard sera disponible après la mesure", digital)
        self.assertNotIn("Nature de la mesure", digital)
        self.assertNotIn("Tolérance de conformité", digital)

        can = self.client.get("/measurement?mode=can").get_data(as_text=True)
        self.assertIn('name="acquisition_mode" value="can"', can)
        self.assertIn("Acquisition CAN pour CANalyzer", can)
        self.assertIn("Les deux voies INA226 sont émises sur le bus CAN", can)

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
        self.assertIn("Autonomie théorique comparée", dashboard)
        self.assertIn("Consommation journalière avec profils ECU 0/1", dashboard)
        self.assertIn("AUTONOMIE MOINS BONNE", dashboard)
        self.assertIn("Enregistrer le dashboard", dashboard)
        self.assertIn("feedingChannelSummaries", dashboard)
        self.assertIn("Évolution du %SOC batterie", dashboard)
        self.assertIn("Bilan énergétique", dashboard)
        self.assertIn("Répartition coût EF", dashboard)
        self.assertIn("%Batt12V", dashboard)
        self.assertIn("% énergie perdue", dashboard)
        self.assertIn("feedingSocChart", dashboard)
        self.assertIn("feedingPieChart", dashboard)
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

    def test_dashboard_entry_depends_on_selected_measurement_mode(self):
        can_response = self.client.get("/dashboard/open?mode=can")
        self.assertEqual(can_response.status_code, 302)
        self.assertEqual(can_response.headers["Location"], "/dashboard/import")

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
            "/dashboard/setup?session_id=digital-completed",
        )

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
        self.assertIn("attente", payload["message"])

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

    def test_database_reset_clears_measurements_and_sessions(self):
        response = self.client.post("/api/purge_database")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertGreater(payload["deleted_measurements"], 0)
        status = self.client.get("/api/database_status").get_json()
        self.assertEqual(status["measurement_count"], 0)
        self.assertIsNone(status["latest_session_id"])
        self.assertEqual(self.module.measurement_sessions(), [])

    def test_wltc_intervals_use_profile_windows(self):
        intervals = self.module.analysis_interval_definitions("wltc")
        self.assertEqual(
            [(item["start_s"], item["end_s"]) for item in intervals],
            [(0, 100), (100.8, 240), (240, 420), (420, 489.6), (735, 1500), (1500, 1800)],
        )


if __name__ == "__main__":
    unittest.main()
