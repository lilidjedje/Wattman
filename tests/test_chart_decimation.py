"""Garanties mathématiques de la décimation d'affichage des mesures.

`decimate_chart_points` (can_server/app.py) réduit une série à `max_points`
points pour l'affichage. Propriétés vérifiées sur des séries aléatoires :
1. borne : au plus `max_points` points ;
2. sous-ensemble : chaque point affiché est un point source, inchangé ;
3. extrémités : premier et dernier points conservés ;
4. extrêmes : le minimum et le maximum globaux sont conservés ;
5. extrêmes locaux : pour chaque seau, son min et son max sont conservés,
   donc aucun pic d'un seul échantillon ne peut disparaître ;
6. ordre temporel préservé ; séries courtes renvoyées telles quelles.
"""
import os
import random
import sys
import tempfile
import unittest


class ChartDecimationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_directory = tempfile.TemporaryDirectory()
        os.environ["ENGINEERING_APP_DATA"] = cls.data_directory.name
        sys.path.insert(0, os.path.abspath("can_server"))
        import app as measurement_app

        cls.decimate = staticmethod(measurement_app.decimate_chart_points)

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("ENGINEERING_APP_DATA", None)
        cls.data_directory.cleanup()

    @staticmethod
    def series(rng, length):
        points = [{"time_s": i * 0.01, "current_A": rng.gauss(1.0, 0.2)} for i in range(length)]
        for _ in range(rng.randint(1, 5)):  # pics isolés d'un échantillon
            points[rng.randrange(length)]["current_A"] = rng.choice([1, -1]) * rng.uniform(50, 500)
        return points

    def test_properties_on_random_series(self):
        rng = random.Random(20261115)
        for _ in range(60):
            length = rng.randint(4001, 60000)
            max_points = rng.choice([200, 1000, 4000])
            source = self.series(rng, length)
            reduced = self.decimate(source, "current_A", max_points=max_points)
            ids = {id(p) for p in source}
            self.assertLessEqual(len(reduced), max_points)
            self.assertTrue(all(id(p) in ids for p in reduced), "point inventé ou copié")
            self.assertIs(reduced[0], source[0])
            self.assertIs(reduced[-1], source[-1])
            values = [p["current_A"] for p in reduced]
            self.assertEqual(max(values), max(p["current_A"] for p in source))
            self.assertEqual(min(values), min(p["current_A"] for p in source))
            times = [p["time_s"] for p in reduced]
            self.assertEqual(times, sorted(times))

    def test_every_bucket_keeps_its_local_extremes(self):
        rng = random.Random(7)
        source = self.series(rng, 25000)
        max_points = 1000
        reduced = {id(p) for p in self.decimate(source, "current_A", max_points=max_points)}
        bucket_count = max(1, (max_points - 2) // 2)
        bucket_size = max(1, (len(source) - 2 + bucket_count - 1) // bucket_count)
        for start in range(1, len(source) - 1, bucket_size):
            bucket = source[start:min(len(source) - 1, start + bucket_size)]
            self.assertIn(id(min(bucket, key=lambda p: p["current_A"])), reduced)
            self.assertIn(id(max(bucket, key=lambda p: p["current_A"])), reduced)

    def test_short_series_unchanged(self):
        source = [{"time_s": i, "current_A": float(i)} for i in range(100)]
        self.assertIs(self.decimate(source, "current_A", max_points=4000), source)


if __name__ == "__main__":
    unittest.main()
