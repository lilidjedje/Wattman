"""Analytic integrals for measured autonomy, clipping, profiles and missing data."""
import math
import os
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'can_server'))
from autonomy_analysis import build_autonomy


def sample(t, current, channel='A', source='one'):
    return {'timestamp': t, 'current_A': current, 'channel': channel,
            'source_file': source, 'frequency_Hz': 10}


class AutonomyIntegrationTest(unittest.TestCase):
    def test_linear_current_has_exact_analytic_integral_on_clipped_ranges(self):
        rng = random.Random(int(os.environ.get('CALC_SEED', 20261112)))
        for iteration in range(int(os.environ.get('CALC_ITERATIONS', 250))):
            origin = 1700000000.
            initial, slope = rng.uniform(.001, 1), rng.uniform(0, .02)
            # Dense acquisition, with irregular clipping boundaries between samples.
            rows = [sample(origin + i / 10, initial + slope * i / 10) for i in range(101)]
            start, end = rng.uniform(0, 4), rng.uniform(6, 10)
            capacity, nominal = rng.uniform(1, 30), rng.uniform(.001, .1)
            result = build_autonomy(rows, ['A'], [{'id': 'ecu', 'nominal_A': nominal}], origin,
                                    start / 86400, end / 86400, capacity, lambda d, t: 1, lambda d: [])
            actual = result['channels'][0]
            expected = (initial * (end - start) + slope * (end**2 - start**2) / 2) / 3600
            with self.subTest(iteration=iteration):
                self.assertTrue(math.isclose(actual['measured_energy_Ah'], expected, rel_tol=2e-7))
                self.assertAlmostEqual(actual['covered_s'], end - start, places=6)
                self.assertAlmostEqual(actual['theoretical_energy_Ah'], nominal * (end - start) / 3600)
                self.assertTrue(math.isclose(actual['days'], capacity / (expected * 86400 / (end - start)), rel_tol=2e-7))
                self.assertAlmostEqual(actual['theoretical_days'], capacity / (nominal * 24))

    def test_profile_changes_split_energy_and_channels_remain_independent(self):
        rows = [sample(i / 10, .01, ch) for ch in ['A', 'B'] for i in range(101)]
        result = build_autonomy(rows, ['A', 'B'], [{'nominal_A': .02}], 0, 0, 10 / 86400, 12,
                                lambda d, t: 1 if t < 4 / 86400 else 0,
                                lambda d: [(4 / 86400, 0)])
        for channel in result['channels']:
            self.assertAlmostEqual(channel['measured_energy_Ah'], .01 * 10 / 3600)
            self.assertAlmostEqual(channel['theoretical_energy_Ah'], .02 * 4 / 3600)
            self.assertEqual(sum(part['samples'] for part in channel['intervals']), 101)

    def test_missing_stretches_are_not_integrated(self):
        rows = [sample(i / 10, 1) for i in range(11)] + [sample(100 + i / 10, 1) for i in range(11)]
        result = build_autonomy(rows, ['A', 'B'], [], 0, 0, 101 / 86400, 12, lambda d, t: 1, lambda d: [])
        a, b = result['channels']
        self.assertAlmostEqual(a['covered_s'], 2)
        self.assertAlmostEqual(a['measured_energy_Ah'], 2 / 3600)
        self.assertTrue(a['partial'])
        self.assertIsNone(b['days'])
        self.assertIsNone(b['daily_consumption_Ah'])
        self.assertEqual(b['covered_s'], 0)


if __name__ == '__main__':
    unittest.main()
