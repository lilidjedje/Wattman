"""Analyse globale des campagnes de calibration : scores, diagnostic expert et contenu envoyé à l'IA."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "can_server"))
import calibration_global as cg  # noqa: E402


def campaign(name, offset, noise, created, level=0.3, completeness=100.0, statuses=("pass",) * 7):
    protocol = {"frequency_hz": 100, "duration_s": 60, "repetitions": 3, "pause_s": 10,
                "shunt_ohm": 0.010, "checkpoints_s": [0, 10, 20, 30, 40, 50, 60]}
    summary = {
        "offset_A": offset, "reference_limit_A": 0.0004, "reference_mean_A": level, "noise_pooled_A": noise,
        "drift_mean_A_per_min": 0.0, "completeness_pct": completeness, "runs_with_data": 3, "runs_total": 3,
        "run_mean_spread_A": 0.0002, "pass_count": statuses.count("pass"), "warning_count": statuses.count("warning"),
        "fail_count": statuses.count("fail"), "verdict": "fail" if "fail" in statuses else "pass",
    }
    analysis = {"summary": summary, "runs": [{"run_index": 1, "checkpoints": [
        {"t_s": 0, "reference_A": level, "error_A": offset, "status": statuses[0], "reference_limit_A": 0.0004}]}]}
    return {"id": name, "name": name, "protocol": protocol, "created_at": created, "updated_at": created,
            "notes": "note interne"}, analysis


class GlobalAnalysisTest(unittest.TestCase):
    def rows(self, specs):
        return [cg.campaign_metrics(c, "A", a) for c, a in (campaign(*spec) for spec in specs)]

    def test_score_orders_good_and_bad_campaigns(self):
        good, bad = self.rows([("bon", 0.0001, 0.0004, 1), ("mauvais", -0.006, 0.006, 2, 0.3, 95.0, ("fail",) * 7)])
        self.assertGreater(good["score"], 85)
        self.assertLess(bad["score"], 40)
        self.assertEqual(bad["worst_axis"], "accuracy")
        self.assertAlmostEqual(bad["derived"]["noise_lsb"], 24)

    def test_common_bias_and_noise_are_diagnosed(self):
        rows = self.rows([(f"c{i}", -0.006, 0.006, i, 0.3, 100.0, ("fail",) * 7) for i in range(4)])
        titles = [item["title"] for item in cg.expert_insights(rows, {})]
        self.assertIn("Biais systématique commun à la plupart des campagnes", titles)
        self.assertIn("Bruit nettement supérieur à celui de l'INA226", titles)

    def test_unreliable_regression_never_recommends_a_correction(self):
        rows = self.rows([("a", -0.006, 0.001, 1), ("b", 0.0001, 0.001, 2, 1.0)])
        regression = {"status": "ok", "offset_A": 0.0005, "gain_error_pct": -5.2, "r2": 0.25, "span_A": 1.0,
                      "correction": {"gain_factor": 1.0549}}
        item = next(i for i in cg.expert_insights(rows, {"A": regression}) if "offset / gain" in i["title"])
        self.assertEqual(item["level"], "warning")
        self.assertIn("N'appliquez pas", item["action"])
        self.assertIn("0,25", item["text"])  # format français

    def test_ai_payload_is_aggregated_only(self):
        rows = self.rows([("c", -0.006, 0.006, 1)])
        payload = cg.ai_payload(rows, {"A": {"status": "single_level", "points": [{"error_A": 1}]}}, [])
        text = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("note interne", text)
        self.assertNotIn("points", json.dumps(payload["regressions_multi_niveaux"]))
        self.assertEqual(payload["campagnes"][0]["campagne"], "c")


if __name__ == "__main__":
    unittest.main()
