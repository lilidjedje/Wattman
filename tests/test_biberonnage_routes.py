import os
import sqlite3
import tempfile
import unittest
import zipfile
from io import BytesIO

_test_data = tempfile.TemporaryDirectory()
os.environ["ENGINEERING_APP_DATA"] = _test_data.name
from app import app, read_excel_file
from openpyxl import Workbook, load_workbook
from openpyxl.styles import PatternFill


class BiberonnageRoutesTest(unittest.TestCase):
    def test_excel_import_omits_completely_empty_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "components.xlsx")
            workbook = Workbook()
            worksheet = workbook.active
            worksheet.title = "Device List"
            worksheet.append(["Device Name", "Current Category", "Current (A)", "Sleep Current (mA)"])
            worksheet.append(["H component", "H", 12, None])
            worksheet.append(["S component", "S", None, 25])
            worksheet.append([None, None, None, None])
            worksheet.cell(row=100, column=1).fill = PatternFill("solid", fgColor="FFFFFF")
            workbook.save(path)
            workbook.close()

            data = read_excel_file(path)["Device List"]

        self.assertEqual(data["row_count"], 2)
        self.assertEqual([row["Device Name"] for row in data["data"]], ["H component", "S component"])

    def test_duration_selection(self):
        client = app.test_client()
        connection = sqlite3.connect(app.extensions["account_database_path"])
        connection.execute("DELETE FROM accounts")
        connection.commit()
        connection.close()
        setup = client.post(
            "/api/auth/setup",
            json={
                "email": "lilicontact07@gmail.com",
                "firstName": "Test",
                "lastName": "Admin",
                "password": "test-admin-password",
            },
        )
        self.assertEqual(setup.status_code, 200, setup.get_json())
        selection = client.get('/biberonnage').get_data(as_text=True)
        self.assertIn('/biberonnage?days=30', selection)
        self.assertIn('/biberonnage?days=90', selection)
        for days in (30, 90):
            for route in ('/biberonnage', '/biberonnage/resultats'):
                response = client.get(f'{route}?days={days}')
                self.assertEqual(response.status_code, 200)
                self.assertIn(f'const DURATION_DAYS = {days};', response.get_data(as_text=True))
        invalid = client.get('/biberonnage/resultats?days=42').get_data(as_text=True)
        self.assertIn('const DURATION_DAYS = 30;', invalid)

    def test_synthesis_pdf_action_waits_for_preview_and_uses_a4_cover(self):
        client = app.test_client()
        connection = sqlite3.connect(app.extensions["account_database_path"])
        connection.execute("DELETE FROM accounts")
        connection.commit()
        connection.close()
        client.post(
            "/api/auth/setup",
            json={
                "email": "lilicontact07@gmail.com",
                "firstName": "Test",
                "lastName": "Admin",
                "password": "test-admin-password",
            },
        )

        response = client.get("/export_synthesis_pdf")
        page = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        for report in ("DCDC Sizing", "WLTC", "DM1", "DM2", "Customer Mode", "Biberonnage"):
            self.assertIn(report, page)
        self.assertIn("Afficher la synthèse", page)
        self.assertIn("Modifier la sélection", page)
        self.assertIn('class="report-actions hidden" id="report-actions"', page)
        self.assertIn('id="generate-pdf" disabled', page)
        self.assertIn('id="project-cover"', page)
        self.assertIn('@page { size: A4 portrait;', page)
        self.assertIn("body :is(.topbar, .profile, .profile-heading", page)
        self.assertIn("background:#fff !important", page)
        self.assertIn("fetch('/generate_synthesis_pdf'", page)
        self.assertIn("JSON.stringify(collectSynthesisPayload())", page)
        self.assertIn("break-before: auto; break-inside: auto;", page)
        self.assertNotIn("break-before: page", page)
        self.assertIn(".analysis { break-inside:auto;", page)
        self.assertIn("frame.scrolling = 'no'", page)
        self.assertIn("body *::-webkit-scrollbar", page)
        self.assertNotIn("section.append(heading, frame)", page)
        self.assertIn("grid-template-columns:minmax(0,1fr) !important", page)
        self.assertNotIn("html2canvas", page)
        self.assertNotIn("jspdf", page)

    def test_synthesis_excel_bundle_preserves_reference_sheets_and_selected_results(self):
        client = app.test_client()
        connection = sqlite3.connect(app.extensions["account_database_path"])
        connection.execute("DELETE FROM accounts")
        connection.commit()
        connection.close()
        client.post(
            "/api/auth/setup",
            json={
                "email": "lilicontact07@gmail.com",
                "firstName": "Test",
                "lastName": "Admin",
                "password": "test-admin-password",
            },
        )

        response = client.post(
            "/export_synthesis_excel_bundle",
            json={
                "modules": ["dcdc", "wltc", "customer"],
                "project": {"name": "Projet test"},
                "synthesis": {
                    "dcdc": {"winter": [{"time": 0, "base": 2, "upper": 3, "dcdcOutput": 250}]},
                    "wltc": {"cycle1": [{"time": 0, "base": 4, "upper": 5, "dcdcOutput": 250}]},
                },
                "devices": [{
                    "name": "Équipement de test",
                    "current": 9,
                    "lower": 1,
                    "upper": 0,
                    "dcdcProfiles": {"winter": [0.5], "midseason": [], "summer": []},
                    "wltcProfiles": {"cycle1": [], "cycle2": [], "cycle3": []},
                }],
                "reports": [
                    {"module": "dcdc", "title": "DCDC Sizing", "text": "DCDC"},
                    {"module": "wltc", "title": "WLTC -7 °C", "text": "WLTC"},
                    {
                        "module": "customer", "title": "Customer Mode",
                        "selection": {"profiles": ["Customer"], "scenarios": ["baseLab"]},
                        "data": {"profiles": [{"id": "Customer", "columns": [{
                            "key": "baseLab", "label": "Base LAB", "autonomy": 10,
                            "rows": {str(row): 72 if row == 8 else 0 for row in range(1, 122)},
                        }]}]},
                    },
                ],
            },
        )

        self.assertEqual(response.status_code, 200, response.get_json())
        with zipfile.ZipFile(BytesIO(response.data)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"DCDC_1_principal.xlsx", "WLTC_2_principal.xlsx", "Consoveille_Synthese.xlsx"},
            )
            dcdc = load_workbook(BytesIO(archive.read("DCDC_1_principal.xlsx")))
            wltc = load_workbook(BytesIO(archive.read("WLTC_2_principal.xlsx")))
            consoveille = load_workbook(BytesIO(archive.read("Consoveille_Synthese.xlsx")))

        self.assertTrue(all(worksheet.sheet_state == "visible" for worksheet in dcdc.worksheets))
        self.assertEqual(dcdc["Bilan DCDC"].sheet_state, "visible")
        self.assertEqual(dcdc["Bilan -7°C"].sheet_state, "visible")
        self.assertEqual(len(dcdc["Graph"]._charts), 3)
        self.assertEqual(dcdc["Bilan DCDC"]["C2"].value, "Projet test")
        equipment_row = next(
            row for row in range(1, dcdc["Bilan DCDC"].max_row + 1)
            if dcdc["Bilan DCDC"].cell(row, 2).value == "Équipement de test"
        )
        self.assertEqual(dcdc["Bilan DCDC"].cell(equipment_row, 7).value, 9)
        self.assertEqual(dcdc["Bilan DCDC"].cell(equipment_row, 8).value, 0.5)
        self.assertEqual(dcdc["Bilan DCDC"]["H92"].value, 3)
        self.assertEqual(dcdc["Bilan -7°C"]["J94"].value, 5)
        self.assertEqual(wltc.active.title, 'Bilan -7°C')
        self.assertEqual(wltc["Bilan -7°C"]["J94"].value, 5)
        self.assertEqual(consoveille["Logistic Mode"].sheet_state, "veryHidden")
        self.assertEqual(consoveille["Customer PIE"].sheet_state, "veryHidden")
        self.assertEqual(consoveille["Customer Mode"].sheet_state, "veryHidden")
        self.assertEqual(consoveille["Customer Mode projet"].sheet_state, "visible")
        self.assertEqual(consoveille["Mounting Mode"].sheet_state, "veryHidden")
        self.assertEqual(consoveille["Customer"]["E6"].value, 10)
        self.assertEqual(consoveille["Customer"]["E8"].value, 72)
        self.assertTrue(consoveille["Customer"].column_dimensions['F'].hidden)
        self.assertFalse(any(name.startswith('Wattman ') for name in consoveille.sheetnames))
        dcdc.close()
        wltc.close()
        consoveille.close()


if __name__ == '__main__':
    unittest.main()
