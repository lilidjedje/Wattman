"""Regression tests for the reference ADAPTATIONS line in the real export."""
import os
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from openpyxl import load_workbook

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

class DcdcAdaptationsExportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder=tempfile.TemporaryDirectory()
        os.environ['ENGINEERING_APP_DATA']=cls.folder.name
        from app import app, export_dcdc_template_excel
        cls.application=app
        cls.export=staticmethod(export_dcdc_template_excel)

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def workbook(self,devices):
        with self.application.test_request_context('/export_dcdc_template_excel',method='POST',json={'devices':devices,'synthesis':{},'project':{}}):
            response=self.export()
            self.assertFalse(isinstance(response,tuple),str(response))
            response.direct_passthrough=False
            return load_workbook(BytesIO(response.get_data()))

    def test_changed_current_and_profiles_are_kept_once(self):
        profiles={'winter':[20]*5,'midseason':[30]*5,'summer':[40]*5}
        wltc={'cycle1':[50]*7,'cycle2':[60]*6,'cycle3':[70]*6}
        workbook=self.workbook([{'name':'ADAPTATIONS','current':'2,5','lower':1,'upper':0,'dcdcProfiles':profiles,'wltcProfiles':wltc}])
        for index,col,first_profile,expected in [(2,7,8,20),(4,9,10,50)]:
            sheet=workbook.worksheets[index]
            matches=[row for row in range(1,sheet.max_row+1) if sheet.cell(row,2).value=='ADAPTATIONS']
            self.assertEqual(len(matches),1)
            self.assertEqual(sheet.cell(matches[0],col).value,2.5)
            self.assertEqual(sheet.cell(matches[0],first_profile).value,expected)
        workbook.close()

    def test_missing_adaptations_stays_visible_with_zero_current(self):
        workbook=self.workbook([])
        for index,col in [(2,7),(4,9)]:
            sheet=workbook.worksheets[index]
            rows=[row for row in range(1,sheet.max_row+1) if sheet.cell(row,2).value=='ADAPTATIONS']
            self.assertEqual(len(rows),1)
            self.assertEqual(sheet.cell(rows[0],col).value,0)
            self.assertFalse(sheet.row_dimensions[rows[0]].hidden)
        workbook.close()

if __name__=='__main__':unittest.main()
