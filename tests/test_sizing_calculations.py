"""Recalculate exported SUMPRODUCTs and Ah balances, including row expansion."""
from io import BytesIO
import os
from pathlib import Path
import random
import sys
import unittest

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sizing_excel import build_sizing_excel, WINDOWS
from test_excel_calculation_oracle import evaluate_sheet


class SizingCalculationsTest(unittest.TestCase):
    def test_exported_formulas_survive_small_and_overflowing_device_lists(self):
        rng = random.Random(int(os.environ.get('CALC_SEED', 20261112)))
        comparisons = 0
        for module in ('dcdc', 'wltc'):
            limit = 120 if module == 'dcdc' else 60
            for count in (0, 1, limit - 1, limit, limit + 1, limit + 20):
                devices = [{'name': f'ECU {i}', 'current': rng.uniform(0, 10),
                            'lower': rng.randrange(2), 'upper': rng.randrange(2),
                            'dcdcProfiles' if module == 'dcdc' else 'wltcProfiles': {
                                profile: [rng.uniform(0, 100) for _ in periods]
                                for profile, periods in WINDOWS[module].items()}}
                           for i in range(count)]
                raw = build_sizing_excel({'module': module, 'devices': devices}, ROOT)
                workbook = load_workbook(BytesIO(raw.getvalue() if hasattr(raw, 'getvalue') else raw))
                try:
                    sheet = workbook.worksheets[0]
                    formulas = {c.coordinate: c.value for row in sheet for c in row if c.value is not None}
                    cell = evaluate_sheet(formulas, {}, {})
                    # DCDC always adds the zero-current ADAPTATIONS equipment.
                    shift = max(0, count + (module == 'dcdc') - limit)
                    base, upper = ((137, 136) if module == 'dcdc' else (83, 82))
                    starts = [11, 17, 24] if module == 'dcdc' else [11, 18, 24]
                    for profile_index, (profile, windows) in enumerate(WINDOWS[module].items()):
                        for index, (left, right) in enumerate(windows):
                            from openpyxl.utils import get_column_letter
                            letter = get_column_letter(starts[profile_index] + index)
                            for bound, total, energy in [('lower', base, 144 if module == 'dcdc' else 90),
                                                         ('upper', upper, 142 if module == 'dcdc' else 88)]:
                                expected = sum(d[bound] * d['current'] * d['dcdcProfiles' if module == 'dcdc' else 'wltcProfiles'][profile][index] / 100
                                               for d in devices)
                                with self.subTest(module=module, count=count, profile=profile, index=index, bound=bound):
                                    self.assertAlmostEqual(cell(f'{letter}{total + shift}'), expected, places=9)
                                    self.assertAlmostEqual(cell(f'{letter}{energy + shift}'), (250 - expected) * (right - left) / 60, places=9)
                                comparisons += 2
                    self.assertEqual(len(workbook.worksheets[1]._charts), 3)
                finally:
                    workbook.close()
        print(f'Sizing export: {comparisons} formula comparisons, 12 generated workbooks')


if __name__ == '__main__':
    unittest.main()
