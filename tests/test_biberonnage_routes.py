import os
import sqlite3
import tempfile
import unittest

_test_data = tempfile.TemporaryDirectory()
os.environ["ENGINEERING_APP_DATA"] = _test_data.name
from app import app, read_excel_file
from openpyxl import Workbook
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
        self.assertIn("async function prepareReportsForPrint()", page)
        self.assertIn("break-before: auto; break-inside: auto;", page)
        self.assertNotIn("break-before: page", page)
        self.assertIn(".analysis { break-inside:auto;", page)
        self.assertIn("frame.scrolling = 'no'", page)
        self.assertIn("body *::-webkit-scrollbar", page)
        self.assertNotIn("section.append(heading, frame)", page)
        self.assertIn("function createPrintReportCopies()", page)
        self.assertIn("canvas.toDataURL('image/png')", page)
        self.assertIn("grid-template-columns:minmax(0,1fr) !important", page)
        self.assertIn("height:112mm !important", page)
        self.assertIn(".pdf-customer-report > h2", page)
        self.assertNotIn("html2canvas", page)
        self.assertNotIn("jspdf", page)


if __name__ == '__main__':
    unittest.main()
