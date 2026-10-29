import unittest
from app import app


class BiberonnageRoutesTest(unittest.TestCase):
    def test_duration_selection(self):
        client = app.test_client()
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


if __name__ == '__main__':
    unittest.main()
