"""Re-evaluate the actual Consoveille formulas with an independent AST interpreter.

Only arithmetic and local cell references are accepted. Linked-sheet inputs use
the saved workbook values; no Excel files are changed and no eval() is used.
"""
import ast
from functools import lru_cache
import json
import math
import operator
import os
from pathlib import Path
import random
import re
import subprocess
import unittest

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter, range_boundaries

ROOT = Path(__file__).resolve().parents[1]
ROWS = [13, 17, 22, 24, 28, 32, 36, 40, 44, 49, 53, 55, 59, 64,
        69, 74, 79, 84, 86, 89, 96, 104, 107, 110, 113, 116, 119, 121]
SHEETS = {'Customer': 'Customer', 'CustomerWO': 'Customer wo unplung', 'CustomerPIE': 'Customer PIE'}
SCENARIOS = ['baseLab', 'withAlarm', 'withoutAlarmTachy', 'alarmTachy', 'baseLib']
OPERATORS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}


def evaluate_sheet(formulas, cached, changes):
    ranges = {}
    def arithmetic(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return node.value
        if isinstance(node, ast.Name) and re.fullmatch(r'[A-Z]+\d+', node.id):
            return cell(node.id)
        if isinstance(node, ast.Name) and node.id in ranges:
            return [cell(address) for address in ranges[node.id]]
        if isinstance(node, ast.BinOp) and type(node.op) in OPERATORS:
            return OPERATORS[type(node.op)](arithmetic(node.left), arithmetic(node.right))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            return arithmetic(node.operand) * (-1 if isinstance(node.op, ast.USub) else 1)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            args = [arithmetic(arg) for arg in node.args]
            if node.func.id == 'SUMPRODUCT':
                if len({len(arg) for arg in args}) != 1:
                    raise ValueError('Misaligned SUMPRODUCT ranges')
                return sum(math.prod(items) for items in zip(*args))
            flat = [item for arg in args for item in (arg if isinstance(arg, list) else [arg])]
            functions = {'SUM': sum, 'MIN': min, 'MAX': max}
            if node.func.id in functions:
                return functions[node.func.id](flat)
        raise ValueError(f'Unsupported workbook arithmetic: {ast.dump(node)}')

    @lru_cache(None)
    def cell(address):
        if address in changes:
            return changes[address]
        raw = formulas.get(address)
        if isinstance(raw, str) and raw.startswith('='):
            expression = raw[1:].replace('$', '')
            if '!' in expression:  # External source input, frozen at its saved value.
                result = cached.get(address)
                if not isinstance(result, (int, float)):
                    raise ValueError(f'Missing linked input {address}: {raw}')
                return result
            def replace_range(match):
                name = f'range_{len(ranges)}'
                left, top, right, bottom = range_boundaries(match[0])
                ranges[name] = [f'{get_column_letter(col)}{row}' for col in range(left, right + 1)
                                for row in range(top, bottom + 1)]
                return name
            expression = re.sub(r'[A-Z]+\d+:[A-Z]+\d+', replace_range, expression)
            return arithmetic(ast.parse(expression, mode='eval').body)
        if raw is None:
            return 0
        if not isinstance(raw, (int, float)):
            raise ValueError(f'Non-numeric precedent {address}: {raw}')
        return raw
    return cell


class ExcelCalculationOracle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.formulas, cls.cached = {}, {}
        for data_only, target in [(False, cls.formulas), (True, cls.cached)]:
            workbook = load_workbook(ROOT / 'Consoveille.xlsx', data_only=data_only, read_only=True)
            try:
                for report, title in SHEETS.items():
                    target[report] = {cell.coordinate: cell.value
                                      for row in workbook[title].iter_rows(max_row=121, max_col=18)
                                      for cell in row if cell.value is not None}
            finally:
                workbook.close()

    def test_customer_formulas_with_repeated_input_changes(self):
        seed = int(os.environ.get('CALC_SEED', 20261112))
        rng = random.Random(seed)
        count = int(os.environ.get('CALC_ITERATIONS', 250))
        cases, expected = [], []
        units = {'h': 1, 'min': 1/60, 's': 1/3600, 'jours': 24}
        functions = {'pcuRam': (26, 27, 'h'), 'pcuSecure': (30, 31, 's'),
                     'cdcRam': (34, 35, 'h'), 'cdcGarage': (38, 39, 'min'),
                     'cdcSecure': (42, 43, 'min'), 'fota': (57, 58, 'min'),
                     'handFree3': (66, 68, 'jours'), 'handFree48': (71, 73, 'jours'),
                     'first8': (76, 78, 'h'), 'blm': (81, 83, 'jours')}
        for iteration in range(count + 1):
            for report in SHEETS:
                options, changes = {}, {}
                width = 5 if report == 'CustomerPIE' else 4
                if iteration:
                    battery = {'capacityAh': rng.uniform(50, 120), 'startingSoc': rng.uniform(85, 95),
                               'minimumSoc': rng.uniform(40, 70)}
                    options = {'battery': battery, 'dailyAh': rng.uniform(0, 0.5),
                               'wake': {'wakePeriodHours': rng.uniform(0.5, 24), 'wakeDurationSeconds': rng.uniform(0, 90),
                                        'wakeCurrentMa': rng.uniform(0, 3000), 'wakeCellBalancingDurationSeconds': rng.uniform(0, 90),
                                        'wakeCellBalancingCurrentMa': rng.uniform(0, 5000)}, 'fixed': {}, 'sleep': {}}
                    for index in range(width):
                        col, key = chr(69 + index), SCENARIOS[index]
                        for field, row, scale in [('capacityAh', 8, 1), ('startingSoc', 10, .01), ('minimumSoc', 11, .01)]:
                            changes[f'{col}{row}'] = battery[field] * scale + self.cached[report][f'{col}{row}'] - self.cached[report][f'E{row}']
                        changes[f'{col}89'] = options['dailyAh']
                        for field, row in [('wakePeriodHours', 91), ('wakeDurationSeconds', 92), ('wakeCurrentMa', 93),
                                           ('wakeCellBalancingDurationSeconds', 94), ('wakeCellBalancingCurrentMa', 95)]:
                            changes[f'{col}{row}'] = options['wake'][field]
                        entries = {}
                        for name, (current_row, duration_row, source_unit) in functions.items():
                            unit = rng.choice(list(units))
                            current, hours = rng.uniform(0, 20), rng.uniform(0, 5)
                            entries[name] = {'current': current, 'duration': hours / units[unit], 'unit': unit}
                            changes[f'{col}{current_row}'] = current
                            changes[f'{col}{duration_row}'] = hours / units[source_unit]
                        if report != 'Customer':
                            changes.update({f'{col}{row}': 0 for row in (27, 35, 48)})
                        options['fixed'][key] = {'entries': entries}
                        aging = rng.uniform(0, .15)
                        options['sleep'][key] = {'agingSoc': aging}
                        changes[f'{col}118'] = aging / 100
                cell = evaluate_sheet(self.formulas[report], self.cached[report], changes)
                expected.append([{str(row): cell(f'{chr(69 + index)}{row}') for row in ROWS}
                                 for index in range(width)])
                cases.append({'report': report, 'options': options})
        completed = subprocess.run(['node', 'tests/customer_oracle_bridge.cjs'], cwd=ROOT,
                                   input=json.dumps({'cases': cases, 'rows': ROWS}), capture_output=True,
                                   text=True, encoding='utf-8', check=True)
        actual = json.loads(completed.stdout)
        self.assertEqual(len(actual), len(expected))
        comparisons = 0
        for case_index, (columns, references) in enumerate(zip(actual, expected)):
            self.assertEqual(len(columns), len(references))
            for index, (column, reference) in enumerate(zip(columns, references)):
                for row, value in reference.items():
                    with self.subTest(seed=seed, case=case_index, report=cases[case_index]['report'], column=index, row=row):
                        self.assertTrue(math.isclose(column['values'][row], value, rel_tol=1e-10, abs_tol=1e-10),
                                        f'{column["values"][row]} != {value}')
                    comparisons += 1
                daily, available = reference['121'], reference['86']
                self.assertAlmostEqual(column['autonomy'], max(0, available) / daily, places=9)
        print(f'Excel oracle: {comparisons} cell comparisons; {count} variations per report; seed={seed}')


if __name__ == '__main__':
    unittest.main()
