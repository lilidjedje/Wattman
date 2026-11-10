import copy
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from synthesis_excel import dm_values, number


def stored_column():
    """Representative older saved profile: inputs are strings, results are numbers."""
    entries = {key: {'current': '1,5', 'duration': '192'}
               for key in ('pcuRam', 'cdcRam', 'ivc3')}
    entries.update({
        'cellBalancing': {'current': '200', 'duration': '15',
                          'extra': {'periodMin': '480', 'balancingDays': '90'}},
        'transport': {'current': '0,72', 'duration': '10'},
    })
    return {
        'scenario': {'key': 'withoutAlarmTachy'},
        'autonomy': 12, 'capacity': 60, 'startSoc': '90', 'minSoc': '70',
        'gross': 12, 'vehicleCount': 1, 'vehicleUnit': .08, 'vehicleTotal': .08,
        'available': 10, 'instantaneous': '1 500', 'sleepCurrentEnergy': .036,
        'wakePeriod': 8, 'wakeDuration': 2, 'wakeCurrent': 536,
        'balancingDuration': 60, 'balancingCurrent': 4359, 'technicalWake': .22,
        'sleep': {'alarm': '1,2', 'sansEbdu': '0,3', 'agingSoc': '0,08',
                  'twt': {'single': {'ivcCurrent': '150', 'durationSeconds': '30'}}},
        'alarmEnergy': .0288, 'sansEbduEnergy': .0072, 'twtSingleEnergy': .001,
        'agingEnergy': .048, 'dailyTotal': .341,
        'fixed': {'entries': entries},
        'fixedEnergies': {'cellBalancing': .225, 'transport': .1728,
                          'pcuRam': .288, 'cdcRam': .288, 'ivc3': .288},
    }


class ExcelNumbersTest(unittest.TestCase):
    def test_saved_text_inputs_are_converted_before_arithmetic(self):
        column = stored_column()
        original = copy.deepcopy(column)
        values = dm_values(column)
        self.assertEqual(column, original)
        self.assertAlmostEqual(values[22], .225 / 90)
        self.assertAlmostEqual(values[40], .72 / 1000 * 24)
        self.assertEqual(values[10], .9)
        self.assertEqual(values[11], .7)
        self.assertEqual(values[46], 1.5)
        self.assertEqual(values[89], .0008)
        self.assertEqual(values[71], 150)
        self.assertTrue(all(isinstance(v, (int, float)) and math.isfinite(v)
                            for v in values.values()))

    def test_zero_balancing_duration_and_deleted_functions(self):
        column = stored_column()
        column['fixed']['entries']['cellBalancing']['extra']['balancingDays'] = '0'
        column['fixedEnergies']['cellBalancing'] = 0
        self.assertEqual(dm_values(column)[22], 0)
        column['deletedFixed'] = ['cellBalancing', 'transport']
        column['deletedSleep'] = ['twt', 'alarm', 'aging']
        values = dm_values(column)
        for row in (19, 20, 21, 22, 23, 24, 39, 40, 41, 42, 64, 65, 71, 74, 84, 89, 90):
            self.assertEqual(values[row], 0)

    def test_french_numbers_null_soc_and_invalid_values(self):
        for value in ('1 234,50', '1\u00a0234,50', '1\u202f234,50', '1234.50'):
            self.assertEqual(number(value), 1234.5)
        self.assertIsNone(number(None))  # Some SOC timeline positions are empty.
        self.assertEqual(number(''), 0)
        for value in ('invalide', 'NaN', 'Infinity', [], {}):
            with self.assertRaises(ValueError):
                number(value)


if __name__ == '__main__':
    unittest.main()
