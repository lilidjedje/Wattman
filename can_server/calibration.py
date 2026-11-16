"""Rubrique Calibration : comparaison INA226 / multimètre de référence Fluke 287.

Une campagne décrit le protocole (voie, fréquence, durée, répétitions, pause,
instants de relevé). Chaque répétition est reliée à un enregistrement de la base
de mesures (source_file + décalage de départ) et porte les relevés du Fluke :
courant à chaque instant de contrôle, MIN et MAX, nombre d'échantillons relevé.

L'analyse calcule, sans modifier les mesures :
- complétude et régularité de l'échantillonnage ;
- statistiques du signal (moyenne, bruit, crête à crête, percentiles) ;
- dérive (pente de régression) ;
- erreur INA − référence à chaque instant, comparée à l'incertitude du Fluke 287
  (spécifications constructeur) et aux limites INA226 non calibrées ;
- écart-type d'Allan pour choisir la durée de moyennage ;
- Bland-Altman, histogrammes, intervalles d'échantillonnage ;
- synthèse de campagne et régression multi-niveaux (offset et gain).
"""
import csv
import io
import json
import math
import time
import uuid

import numpy as np
from flask import Response, abort, g, jsonify, render_template, request

from database import get_db_connection, init_db
from database_catalog import describe_sources

# Fluke 287, courant continu : (calibre A, résolution A, % lecture, digits).
# Spécifications à 1 an, 18–28 °C (guide 287/289, table « DC Current »).
FLUKE_287_DC_CURRENT = [
    (500e-6, 0.01e-6, 0.075, 20),
    (5000e-6, 0.1e-6, 0.075, 2),
    (0.050, 0.001e-3, 0.05, 10),
    (0.400, 0.01e-3, 0.15, 2),
    (5.0, 0.1e-3, 0.3, 10),
    (10.0, 1e-3, 0.3, 2),
]
FLUKE_TEMP_COEFF_NOTE = "Hors 18–28 °C : ajouter 0,1 × la précision spécifiée par °C."

# INA226 (fiche TI) : LSB tension shunt 2,5 µV, offset max ±10 µV, erreur de gain max ±0,1 %.
INA226_LSB_V = 2.5e-6
INA226_OFFSET_MAX_V = 10e-6
INA226_GAIN_ERROR_MAX_PCT = 0.1

DEFAULT_PROTOCOL = {
    "channel": "A",
    "frequency_hz": 100.0,
    "duration_s": 60.0,
    "repetitions": 3,
    "pause_s": 30.0,
    "checkpoints_s": [0, 20, 40, 60],
    "window_s": 1.0,
    "smoothing_s": 0.5,
    "shunt_ohm": 0.010,
    "shunt_tolerance_pct": 1.0,
    "reference_instrument": "Fluke 287",
}

MAX_RUN_SAMPLES = 2_000_000
CHART_POINTS = 3000


# ---------------------------------------------------------------------------
# Base de données
# ---------------------------------------------------------------------------

def init_calibration_tables(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS calibration_campaigns (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            created_by TEXT,
            protocol_json TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT ''
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS calibration_runs (
            id TEXT PRIMARY KEY,
            campaign_id TEXT NOT NULL REFERENCES calibration_campaigns(id) ON DELETE CASCADE,
            run_index INTEGER NOT NULL,
            source_file TEXT,
            start_offset_s REAL NOT NULL DEFAULT 0,
            samples_reported INTEGER,
            reference_json TEXT NOT NULL DEFAULT '{}',
            fluke_min_A REAL,
            fluke_max_A REAL,
            fluke_range_A REAL,
            ambient_c REAL,
            notes TEXT NOT NULL DEFAULT '',
            updated_at REAL NOT NULL,
            UNIQUE(campaign_id, run_index)
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_calibration_project ON calibration_campaigns(project_id, updated_at)')


def connection():
    init_db()
    conn = get_db_connection()
    init_calibration_tables(conn)
    return conn


# ---------------------------------------------------------------------------
# Incertitudes de référence
# ---------------------------------------------------------------------------

def fluke_range_for(current_a, forced_range=None):
    """Calibre du Fluke 287 pour une lecture.

    forced_range désigne la borne d'entrée câblée : 0,4 A = borne mA/µA (calibres
    500 µA, 5 000 µA, 50 mA, 400 mA) ; 10 A = borne A (calibres 5 A et 10 A). Le
    multimètre choisit ensuite automatiquement le plus petit calibre de cette borne.
    """
    magnitude = abs(current_a)
    specs = FLUKE_287_DC_CURRENT
    if forced_range:
        specs = [spec for spec in FLUKE_287_DC_CURRENT if (spec[0] <= 0.4) == (forced_range <= 0.4 + 1e-12)]
    for spec in specs:
        if magnitude <= spec[0]:
            return spec
    return specs[-1]


def fluke_uncertainty(current_a, forced_range=None):
    """Limite d'erreur du Fluke 287 (A) : ±(% lecture + digits × résolution)."""
    rng, resolution, pct, digits = fluke_range_for(current_a, forced_range)
    return {
        "range_A": rng,
        "resolution_A": resolution,
        "limit_A": abs(current_a) * pct / 100 + digits * resolution,
        "formula": f"±({pct} % + {digits} dgt)",
    }


def ina_limits(current_a, protocol):
    """Limites INA226 non calibré : offset + gain + tolérance du shunt."""
    shunt = float(protocol.get("shunt_ohm") or 0.010)
    tolerance = float(protocol.get("shunt_tolerance_pct") or 0)
    offset = INA226_OFFSET_MAX_V / shunt
    gain = abs(current_a) * (INA226_GAIN_ERROR_MAX_PCT + tolerance) / 100
    return {"lsb_A": INA226_LSB_V / shunt, "offset_A": offset, "limit_A": offset + gain}


# ---------------------------------------------------------------------------
# Outils statistiques
# ---------------------------------------------------------------------------

def finite(value):
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def linear_fit(x, y):
    if len(x) < 2 or np.ptp(x) == 0:
        return None
    slope, intercept = np.polyfit(x, y, 1)
    predicted = slope * x + intercept
    ss_res = float(np.sum((y - predicted) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    dof = len(x) - 2
    slope_se = None
    if dof > 0:
        sxx = float(np.sum((x - np.mean(x)) ** 2))
        slope_se = math.sqrt(ss_res / dof / sxx) if sxx > 0 else None
    return {
        "slope": float(slope),
        "intercept": float(intercept),
        "r2": 1 - ss_res / ss_tot if ss_tot > 0 else 1.0,
        "slope_se": slope_se,
    }


def allan_deviation(values, rate_hz):
    """Écart-type d'Allan avec recouvrement, sur des τ espacés logarithmiquement."""
    n = len(values)
    if n < 8 or not rate_hz:
        return []
    cumulative = np.concatenate(([0.0], np.cumsum(values)))
    factors = np.unique(np.logspace(0, math.log10(max(1, n // 3)), 40).astype(int))
    points = []
    for m in factors:
        if 2 * m >= n:
            break
        averages = (cumulative[m:] - cumulative[:-m]) / m
        differences = averages[m:] - averages[:-m]
        if len(differences) == 0:
            continue
        adev = math.sqrt(0.5 * float(np.mean(differences ** 2)))
        points.append({"tau_s": m / rate_hz, "adev_A": adev, "samples": int(m)})
    return points


def moving_average(values, width):
    if width <= 1 or len(values) < width:
        return values.copy()
    kernel = np.ones(width) / width
    smoothed = np.convolve(values, kernel, mode="same")
    edge = width // 2
    smoothed[:edge] = values[:edge]
    if edge:
        smoothed[-edge:] = values[-edge:]
    return smoothed


def decimate(t, values, limit=CHART_POINTS):
    """Conserve le min et le max de chaque tranche pour ne pas masquer les pics."""
    n = len(t)
    if n <= limit:
        return [[round(float(a), 4), float(b)] for a, b in zip(t, values)]
    buckets = max(1, limit // 2)
    edges = np.linspace(0, n, buckets + 1).astype(int)
    out = []
    for start, end in zip(edges[:-1], edges[1:]):
        if end <= start:
            continue
        chunk = values[start:end]
        low, high = start + int(np.argmin(chunk)), start + int(np.argmax(chunk))
        for index in sorted({low, high}):
            out.append([round(float(t[index]), 4), float(values[index])])
    return out


def histogram(values, bins=40):
    if len(values) == 0:
        return []
    low, high = float(np.min(values)), float(np.max(values))
    if low == high:
        return [{"from": low, "to": high, "count": int(len(values))}]
    counts, edges = np.histogram(values, bins=bins)
    return [{"from": float(a), "to": float(b), "count": int(c)} for a, b, c in zip(edges[:-1], edges[1:], counts)]


# ---------------------------------------------------------------------------
# Analyse
# ---------------------------------------------------------------------------

def load_run_samples(conn, protocol, run):
    if not run.get("source_file"):
        return np.array([]), np.array([]), None
    first = conn.execute(
        "SELECT MIN(timestamp) FROM measurements WHERE source_file = ? AND channel = ?",
        (run["source_file"], protocol["channel"]),
    ).fetchone()[0]
    if first is None:
        return np.array([]), np.array([]), None
    start = first + float(run.get("start_offset_s") or 0)
    end = start + float(protocol["duration_s"])
    rows = conn.execute(
        """SELECT timestamp, current_A FROM measurements
           WHERE source_file = ? AND channel = ? AND timestamp >= ? AND timestamp <= ?
           ORDER BY timestamp LIMIT ?""",
        (run["source_file"], protocol["channel"], start, end + 1e-9, MAX_RUN_SAMPLES),
    ).fetchall()
    t = np.array([row[0] - start for row in rows], dtype=float)
    current = np.array([row[1] for row in rows], dtype=float)
    return t, current, start


def protocol_channels(protocol):
    """Canaux couverts par une campagne : « AB » = A et B, chacun avec son Fluke."""
    return ["A", "B"] if protocol.get("channel") == "AB" else [protocol.get("channel") or "A"]


def channel_run(run, channel, protocol):
    """Vue d'une répétition pour un canal : relevés Fluke propres au canal."""
    if protocol.get("channel") != "AB":
        return run
    data = ((run.get("reference") or {}).get("channels") or {}).get(channel) or {}
    return {**run, "reference": data.get("points") or {}, "fluke_min_A": data.get("min"),
            "fluke_max_A": data.get("max"), "fluke_range_A": data.get("range")}


def checkpoint_reference(run, checkpoint):
    references = run.get("reference") or {}
    return finite(references.get(str(checkpoint)) if str(checkpoint) in references else references.get(checkpoint))


def classify(error, reference_limit, ina_limit):
    if error is None:
        return "missing"
    if abs(error) <= reference_limit:
        return "pass"
    if abs(error) <= reference_limit + ina_limit:
        return "warning"
    return "fail"


def analyse_run(conn, protocol, run):
    t, current, start = load_run_samples(conn, protocol, run)
    rate = float(protocol["frequency_hz"])
    duration = float(protocol["duration_s"])
    expected = int(round(duration * rate))
    n = len(current)
    result = {
        "id": run["id"],
        "run_index": run["run_index"],
        "source_file": run.get("source_file"),
        "start_timestamp": start,
        "samples": n,
        "samples_expected": expected,
        "samples_reported": run.get("samples_reported"),
        "has_data": n > 0,
    }
    if n == 0:
        result["checkpoints"] = [
            {"t_s": cp, "reference_A": checkpoint_reference(run, cp), "status": "missing"}
            for cp in protocol["checkpoints_s"]
        ]
        return result

    intervals = np.diff(t) if n > 1 else np.array([])
    nominal_dt = 1 / rate
    gaps = intervals[intervals > 1.5 * nominal_dt] if len(intervals) else intervals
    span = float(t[-1] - t[0]) if n > 1 else 0.0
    mean = float(np.mean(current))
    std = float(np.std(current, ddof=1)) if n > 1 else 0.0
    smoothing = max(1, int(round(float(protocol.get("smoothing_s") or 0) * rate)))
    smoothed = moving_average(current, smoothing)
    fit = linear_fit(t, current)
    lsb = INA226_LSB_V / float(protocol.get("shunt_ohm") or 0.010)

    result.update({
        "completeness_pct": 100 * n / expected if expected else None,
        "reported_vs_db": (run["samples_reported"] - n) if run.get("samples_reported") is not None else None,
        "reported_completeness_pct": (100 * run["samples_reported"] / expected) if run.get("samples_reported") is not None and expected else None,
        "lost_samples": max(0, expected - n),
        "effective_rate_hz": (n - 1) / span if span > 0 else None,
        "dt_mean_ms": float(np.mean(intervals) * 1000) if len(intervals) else None,
        "dt_std_ms": float(np.std(intervals) * 1000) if len(intervals) else None,
        "dt_max_ms": float(np.max(intervals) * 1000) if len(intervals) else None,
        "gap_count": int(len(gaps)),
        "gap_missing_samples": int(np.sum(np.round(gaps / nominal_dt) - 1)) if len(gaps) else 0,
        "first_t_s": float(t[0]),
        "last_t_s": float(t[-1]),
        "mean_A": mean,
        "median_A": float(np.median(current)),
        "std_A": std,
        "sem_A": std / math.sqrt(n),
        "min_A": float(np.min(current)),
        "max_A": float(np.max(current)),
        "p2p_A": float(np.ptp(current)),
        "p01_A": float(np.percentile(current, 0.5)),
        "p99_A": float(np.percentile(current, 99.5)),
        "smoothed_min_A": float(np.min(smoothed)),
        "smoothed_max_A": float(np.max(smoothed)),
        "smoothing_samples": smoothing,
        "drift_A_per_min": fit["slope"] * 60 if fit else None,
        "drift_se_A_per_min": fit["slope_se"] * 60 if fit and fit["slope_se"] is not None else None,
        "drift_r2": fit["r2"] if fit else None,
        "quantization_levels": int(len(np.unique(np.round(current / lsb)))),
        "noise_lsb": std / lsb if lsb else None,
    })

    half = float(protocol.get("window_s") or 1.0) / 2
    checkpoints, errors = [], []
    for cp in protocol["checkpoints_s"]:
        lo, hi = max(0.0, cp - half), min(duration, cp + half)
        if hi - lo < half:
            lo, hi = max(0.0, cp - 2 * half), min(duration, cp + 2 * half)
        mask = (t >= lo) & (t <= hi)
        window = current[mask]
        reference = checkpoint_reference(run, cp)
        item = {"t_s": cp, "window": [lo, hi], "reference_A": reference, "samples": int(window.size)}
        if window.size:
            ina_mean = float(np.mean(window))
            window_std = float(np.std(window, ddof=1)) if window.size > 1 else 0.0
            item.update({
                "ina_mean_A": ina_mean,
                "ina_std_A": window_std,
                "ina_u95_A": 2 * window_std / math.sqrt(window.size),
            })
            if reference is not None:
                ref_u = fluke_uncertainty(reference, run.get("fluke_range_A"))
                ina_u = ina_limits(reference, protocol)
                error = ina_mean - reference
                item.update({
                    "error_A": error,
                    "error_pct": 100 * error / reference if reference else None,
                    "reference_limit_A": ref_u["limit_A"],
                    "reference_range_A": ref_u["range_A"],
                    "reference_formula": ref_u["formula"],
                    "ina_limit_A": ina_u["limit_A"],
                    "normalized_error": error / math.hypot(ref_u["limit_A"], item["ina_u95_A"]) if ref_u["limit_A"] or item["ina_u95_A"] else None,
                    "status": classify(error, ref_u["limit_A"], ina_u["limit_A"]),
                })
                errors.append(error)
        item.setdefault("status", "missing")
        checkpoints.append(item)
    result["checkpoints"] = checkpoints

    references = [c["reference_A"] for c in checkpoints if c["reference_A"] is not None]
    result["reference_mean_A"] = float(np.mean(references)) if references else None
    result["reference_drift_A"] = (references[-1] - references[0]) if len(references) > 1 else None
    result["error_mean_A"] = float(np.mean(errors)) if errors else None
    result["error_max_abs_A"] = float(np.max(np.abs(errors))) if errors else None
    result["global_error_A"] = mean - result["reference_mean_A"] if references else None

    extremes = []
    for key, fluke_key in (("min", "fluke_min_A"), ("max", "fluke_max_A")):
        reference = finite(run.get(fluke_key))
        raw = result[f"{key}_A"]
        smooth = result[f"smoothed_{key}_A"]
        extremes.append({
            "kind": key,
            "reference_A": reference,
            "ina_raw_A": raw,
            "ina_smoothed_A": smooth,
            "error_raw_A": raw - reference if reference is not None else None,
            "error_smoothed_A": smooth - reference if reference is not None else None,
            "reference_limit_A": fluke_uncertainty(reference, run.get("fluke_range_A"))["limit_A"] if reference is not None else None,
        })
    result["extremes"] = extremes

    result["allan"] = allan_deviation(current, rate)
    result["histogram"] = histogram(current)
    result["dt_histogram"] = histogram(intervals * 1000, 30) if len(intervals) else []
    result["series"] = decimate(t, current)
    result["series_smoothed"] = decimate(t, smoothed)
    return result


def campaign_summary(protocol, runs):
    tagged = [(run["run_index"], cp) for run in runs for cp in run.get("checkpoints", []) if cp.get("error_A") is not None]
    points = [cp for _, cp in tagged]
    analysed = [run for run in runs if run.get("has_data")]
    summary = {
        "runs_total": len(runs),
        "runs_with_data": len(analysed),
        "checkpoints_with_reference": len(points),
        "samples_expected_per_run": int(round(float(protocol["duration_s"]) * float(protocol["frequency_hz"]))),
    }
    summary["samples_expected_total"] = summary["samples_expected_per_run"] * int(protocol["repetitions"])
    summary["samples_total"] = sum(run["samples"] for run in runs)
    reported = [run["samples_reported"] for run in runs if run.get("samples_reported") is not None]
    summary["samples_reported_total"] = sum(reported) if reported else None
    summary["completeness_pct"] = (100 * summary["samples_total"] / summary["samples_expected_total"]
                                   if summary["samples_expected_total"] else None)
    if analysed:
        stds = np.array([run["std_A"] for run in analysed])
        counts = np.array([run["samples"] for run in analysed])
        means = np.array([run["mean_A"] for run in analysed])
        summary["noise_pooled_A"] = float(math.sqrt(np.sum((counts - 1) * stds ** 2) / max(1, np.sum(counts - 1))))
        summary["run_mean_spread_A"] = float(np.std(means, ddof=1)) if len(means) > 1 else None
        drifts = [run["drift_A_per_min"] for run in analysed if run.get("drift_A_per_min") is not None]
        summary["drift_mean_A_per_min"] = float(np.mean(drifts)) if drifts else None
        best = []
        for run in analysed:
            if run["allan"]:
                minimum = min(run["allan"], key=lambda p: p["adev_A"])
                best.append(minimum)
        if best:
            summary["allan_best_tau_s"] = float(np.median([p["tau_s"] for p in best]))
            summary["allan_best_adev_A"] = float(np.median([p["adev_A"] for p in best]))
    if points:
        errors = np.array([p["error_A"] for p in points])
        summary["offset_A"] = float(np.mean(errors))
        summary["error_std_A"] = float(np.std(errors, ddof=1)) if len(errors) > 1 else 0.0
        summary["error_rms_A"] = float(math.sqrt(np.mean(errors ** 2)))
        summary["error_max_abs_A"] = float(np.max(np.abs(errors)))
        summary["offset_u95_A"] = (2 * summary["error_std_A"] / math.sqrt(len(errors))) if len(errors) > 1 else None
        summary["reference_limit_A"] = float(np.mean([p["reference_limit_A"] for p in points]))
        summary["ina_limit_A"] = float(np.mean([p["ina_limit_A"] for p in points]))
        summary["reference_mean_A"] = float(np.mean([p["reference_A"] for p in points]))
        summary["pass_count"] = sum(p["status"] == "pass" for p in points)
        summary["warning_count"] = sum(p["status"] == "warning" for p in points)
        summary["fail_count"] = sum(p["status"] == "fail" for p in points)
        summary["bland_altman"] = {
            "bias_A": summary["offset_A"],
            "loa_low_A": summary["offset_A"] - 1.96 * summary["error_std_A"],
            "loa_high_A": summary["offset_A"] + 1.96 * summary["error_std_A"],
            "points": [{"mean_A": (p["reference_A"] + p["ina_mean_A"]) / 2, "diff_A": p["error_A"],
                        "run": index, "t_s": p["t_s"]} for index, p in tagged],
        }
        if summary["error_max_abs_A"] <= summary["reference_limit_A"]:
            summary["verdict"] = "pass"
        elif summary["fail_count"] == 0:
            summary["verdict"] = "warning"
        else:
            summary["verdict"] = "fail"
    else:
        summary["verdict"] = "missing"
    summary["recommendations"] = recommendations(protocol, runs, summary)
    return summary


def fmt_ma(value):
    return f"{value * 1000:.3f} mA"


def recommendations(protocol, runs, summary):
    tips = []
    lsb = INA226_LSB_V / float(protocol.get("shunt_ohm") or 0.010)
    if summary["runs_with_data"] < int(protocol["repetitions"]):
        tips.append(("info", "Répétitions incomplètes",
                     f"{summary['runs_with_data']} répétition(s) reliée(s) à la base sur {protocol['repetitions']} prévues. "
                     "Associez chaque répétition à son enregistrement pour une analyse de reproductibilité."))
    completeness = summary.get("completeness_pct")
    if completeness is not None and summary["runs_with_data"] and completeness < 99:
        tips.append(("warning", "Échantillons perdus",
                     f"Complétude {completeness:.1f} % ({summary['samples_total']} / {summary['samples_expected_total']}). "
                     "Vérifiez les compteurs i2c_errors / lost de l'ESP32, la charge Wi-Fi et l'écran OLED pendant l'acquisition. "
                     "Les trous ne biaisent pas la moyenne mais réduisent la résolution temporelle des min/max."))
    for run in runs:
        if run.get("reported_vs_db"):
            tips.append(("warning", f"Répétition {run['run_index']} : comptage incohérent",
                         f"Nombre relevé {run['samples_reported']} contre {run['samples']} en base ({run['reported_vs_db']:+d}). "
                         "Vérifiez la fenêtre (décalage de départ) ou l'import."))
        if run.get("dt_std_ms") and run["dt_std_ms"] > 0.2 * 1000 / float(protocol["frequency_hz"]):
            tips.append(("info", f"Répétition {run['run_index']} : gigue d'échantillonnage",
                         f"Écart-type des intervalles {run['dt_std_ms']:.2f} ms. L'horodatage côté PC peut ajouter une gigue ; "
                         "un horodatage à la source (ESP32) est préférable pour les analyses temporelles."))
    offset = summary.get("offset_A")
    if offset is not None:
        limit = summary["reference_limit_A"]
        u95 = summary.get("offset_u95_A") or 0
        if abs(offset) > limit + u95:
            tips.append(("fail", "Erreur systématique (offset) significative",
                         f"Biais moyen {fmt_ma(offset)} au-delà de l'incertitude du Fluke ({fmt_ma(limit)}). "
                         f"Correction indicative : soustraire {fmt_ma(offset)} au niveau {fmt_ma(summary['reference_mean_A'])}. "
                         "À un seul niveau de courant, l'offset et le gain ne sont pas séparables : refaites le zéro (courant nul) "
                         "puis la référence, ou mesurez au moins 3 niveaux et utilisez la régression multi-niveaux."))
        else:
            tips.append(("pass", "Biais compatible avec la référence",
                         f"Biais moyen {fmt_ma(offset)} ≤ incertitude Fluke {fmt_ma(limit)} (+ {fmt_ma(u95)} statistique). "
                         "Le Fluke ne permet pas de distinguer une erreur plus petite : un étalon plus précis serait nécessaire."))
    noise = summary.get("noise_pooled_A")
    if noise is not None:
        if noise < 0.5 * lsb:
            tips.append(("info", "Mesure limitée par la résolution",
                         f"Bruit {fmt_ma(noise)} inférieur au LSB ({fmt_ma(lsb)}) : la mesure est quantifiée. "
                         "Moyenner n'améliore la résolution que s'il y a du bruit ; un shunt de valeur plus élevée ou une gamme dédiée "
                         "aux faibles courants est nécessaire pour gagner en résolution."))
        best_tau = summary.get("allan_best_tau_s")
        if best_tau:
            samples = int(round(best_tau * float(protocol["frequency_hz"])))
            tips.append(("info", "Durée de moyennage optimale (Allan)",
                         f"Le minimum de l'écart-type d'Allan est atteint vers τ ≈ {best_tau:.2f} s ({samples} échantillons), "
                         f"σ ≈ {fmt_ma(summary['allan_best_adev_A'])}. Au-delà, la dérive domine : moyenner plus longtemps n'aide plus. "
                         "Utilisez ce τ comme fenêtre de lissage pour approcher l'affichage intégré du multimètre."))
    drift = summary.get("drift_mean_A_per_min")
    if drift is not None:
        per_run = abs(drift) * float(protocol["duration_s"]) / 60
        if per_run > max(lsb, 2 * (summary.get("noise_pooled_A") or 0) / math.sqrt(max(1, summary["samples_expected_per_run"]))):
            ref_drifts = [run["reference_drift_A"] for run in runs if run.get("reference_drift_A") is not None]
            ref_text = f" Le Fluke varie de {fmt_ma(float(np.mean(ref_drifts)))} sur la même durée." if ref_drifts else ""
            tips.append(("warning", "Dérive pendant la mesure",
                         f"Pente moyenne {fmt_ma(drift)}/min.{ref_text} Si la référence est stable mais pas l'INA, suspectez "
                         "l'échauffement du shunt ou de l'INA (offset thermique) : laissez stabiliser le banc avant la mesure, "
                         "et comparez à 0 s et 60 s."))
    spread = summary.get("run_mean_spread_A")
    if spread is not None and offset is not None and spread > max(lsb, summary["reference_limit_A"]):
        tips.append(("warning", "Reproductibilité entre répétitions",
                     f"Les moyennes des répétitions varient de {fmt_ma(spread)} (écart-type). "
                     "Vérifiez la stabilité de la source de courant et la reprise thermique pendant les pauses."))
    return [{"level": level, "title": title, "text": text} for level, title, text in tips]


def multilevel_regression(campaign_results):
    """Régression erreur = a + b × I_ref sur toutes les campagnes de la même voie."""
    points = []
    for campaign in campaign_results:
        for run in campaign["runs"]:
            for cp in run.get("checkpoints", []):
                if cp.get("error_A") is not None:
                    points.append({
                        "campaign": campaign["name"],
                        "campaign_id": campaign["id"],
                        "reference_A": cp["reference_A"],
                        "error_A": cp["error_A"],
                        "ina_A": cp["ina_mean_A"],
                    })
    result = {"points": points}
    if len(points) < 3:
        result["status"] = "insufficient"
        return result
    references = np.array([p["reference_A"] for p in points])
    errors = np.array([p["error_A"] for p in points])
    span = float(np.ptp(references))
    fit = linear_fit(references, errors)
    if fit is None or span < max(0.05, 0.1 * float(np.max(np.abs(references)))):
        result["status"] = "single_level"
        return result
    gain_error = fit["slope"]
    result.update({
        "status": "ok",
        "offset_A": fit["intercept"],
        "gain_error_pct": 100 * gain_error,
        "r2": fit["r2"],
        "span_A": span,
        "correction": {
            "formula": "I_corrigé = (I_INA − offset) / (1 + erreur_gain)",
            "offset_A": fit["intercept"],
            "gain_factor": 1 / (1 + gain_error),
        },
    })
    return result


# ---------------------------------------------------------------------------
# Sérialisation
# ---------------------------------------------------------------------------

def parse_shunt(value):
    """Valeur en Ω, ou code de shunt : R100 = 0,100 Ω, R010 = 0,010 Ω, 2R5 = 2,5 Ω, 10m = 0,010 Ω."""
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(" ", "").replace(",", ".").replace("Ω", "").upper()
    if "R" in text:
        whole, _, decimals = text.partition("R")
        if not (whole + decimals).isdigit():
            raise ValueError("Code de shunt invalide (ex. R100, R010, R002).")
        return float(f"{whole or '0'}.{decimals or '0'}")
    if text.endswith("M"):
        return float(text[:-1]) / 1000
    return float(text)


def parse_protocol(payload, base=None):
    protocol = dict(base or DEFAULT_PROTOCOL)
    source = payload or {}
    if "channel" in source:
        if source["channel"] not in ("A", "B", "AB"):
            raise ValueError("Voie invalide (A, B ou AB).")
        protocol["channel"] = source["channel"]
    numeric = {
        "frequency_hz": (1, 10000), "duration_s": (1, 86400), "pause_s": (0, 86400),
        "window_s": (0.01, 600), "smoothing_s": (0, 600), "shunt_ohm": (1e-5, 1000),
        "shunt_tolerance_pct": (0, 100),
    }
    for key, (low, high) in numeric.items():
        if key in source and source[key] not in (None, ""):
            value = parse_shunt(source[key]) if key == "shunt_ohm" else float(source[key])
            if not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f"Valeur hors limites pour {key}.")
            protocol[key] = value
    if "repetitions" in source:
        repetitions = int(source["repetitions"])
        if not 1 <= repetitions <= 50:
            raise ValueError("Le nombre de répétitions doit être compris entre 1 et 50.")
        protocol["repetitions"] = repetitions
    if "checkpoints_s" in source:
        raw = source["checkpoints_s"]
        if isinstance(raw, str):
            raw = [item for item in raw.replace(";", ",").split(",") if item.strip()]
        checkpoints = sorted({float(item) for item in raw})
        if not checkpoints or any(not math.isfinite(c) or c < 0 for c in checkpoints):
            raise ValueError("Instants de contrôle invalides.")
        checkpoints = [int(c) if c.is_integer() else c for c in checkpoints]
        protocol["checkpoints_s"] = checkpoints
    if any(c > protocol["duration_s"] for c in protocol["checkpoints_s"]):
        raise ValueError("Un instant de contrôle dépasse la durée de mesure.")
    if "reference_instrument" in source:
        protocol["reference_instrument"] = str(source["reference_instrument"])[:80]
    return protocol


def run_row(row):
    item = dict(row)
    item["reference"] = json.loads(item.pop("reference_json") or "{}")
    return item


def campaign_row(row):
    item = dict(row)
    item["protocol"] = {**DEFAULT_PROTOCOL, **json.loads(item.pop("protocol_json"))}
    return item


def optional_float(value):
    if value in (None, ""):
        return None
    if isinstance(value, str):
        value = value.replace(",", ".").strip()
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Valeur numérique invalide.")
    return number


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def register_calibration(app, project_id_provider, project_provider):
    def require_admin(api=True):
        # Rubrique ouverte à tous les comptes : l'authentification est déjà
        # imposée par le garde global de l'application.
        return None

    def load_campaign(conn, campaign_id):
        row = conn.execute(
            "SELECT * FROM calibration_campaigns WHERE id = ? AND project_id = ?",
            (campaign_id, project_id_provider()),
        ).fetchone()
        if row is None:
            abort(404)
        campaign = campaign_row(row)
        campaign["runs"] = [run_row(r) for r in conn.execute(
            "SELECT * FROM calibration_runs WHERE campaign_id = ? ORDER BY run_index", (campaign_id,)
        )]
        return campaign

    def analyse_campaign(conn, campaign):
        protocol = campaign["protocol"]
        channels = protocol_channels(protocol)
        runs_by_index = {run["run_index"]: run for run in campaign["runs"]}
        by_channel = {}
        for channel in channels:
            channel_protocol = {**protocol, "channel": channel}
            analysed = []
            for index in range(1, int(protocol["repetitions"]) + 1):
                run = runs_by_index.get(index) or {"id": None, "run_index": index, "reference": {}}
                analysed.append(analyse_run(conn, channel_protocol, channel_run(run, channel, protocol)))
            by_channel[channel] = {"runs": analysed, "summary": campaign_summary(channel_protocol, analysed)}
        first = by_channel[channels[0]]
        return {
            "id": campaign["id"],
            "name": campaign["name"],
            "protocol": protocol,
            "channels": channels,
            "by_channel": by_channel,
            "runs": first["runs"],
            "summary": first["summary"],
        }

    @app.get("/calibration")
    def calibration_page():
        denied = require_admin(api=False)
        if denied:
            return denied
        return render_template(
            "calibration.html",
            project=project_provider(),
            defaults=DEFAULT_PROTOCOL,
            fluke_spec=[
                {"range_A": r, "resolution_A": res, "pct": pct, "digits": d}
                for r, res, pct, d in FLUKE_287_DC_CURRENT
            ],
            fluke_note=FLUKE_TEMP_COEFF_NOTE,
        )

    @app.get("/api/calibration/sources")
    def calibration_sources():
        denied = require_admin()
        if denied:
            return denied
        conn = connection()
        try:
            return jsonify(sources=describe_sources(conn, limit=500))
        finally:
            conn.close()

    @app.get("/api/calibration/segments")
    def calibration_segments():
        """Découpe un enregistrement en répétitions d'après les pauses."""
        denied = require_admin()
        if denied:
            return denied
        source = request.args.get("source_file", "")
        channel = request.args.get("channel", "A")
        try:
            min_gap = float(request.args.get("min_gap_s", 5))
        except ValueError:
            return jsonify({"error": "Pause minimale invalide."}), 400
        conn = connection()
        try:
            rows = conn.execute(
                "SELECT timestamp FROM measurements WHERE source_file = ? AND channel = ? ORDER BY timestamp LIMIT ?",
                (source, channel, MAX_RUN_SAMPLES),
            ).fetchall()
        finally:
            conn.close()
        if not rows:
            return jsonify(segments=[])
        stamps = np.array([row[0] for row in rows])
        breaks = np.where(np.diff(stamps) > min_gap)[0]
        starts = np.concatenate(([0], breaks + 1))
        ends = np.concatenate((breaks, [len(stamps) - 1]))
        segments = [{
            "start_offset_s": float(stamps[s] - stamps[0]),
            "duration_s": float(stamps[e] - stamps[s]),
            "samples": int(e - s + 1),
        } for s, e in zip(starts, ends)]
        return jsonify(segments=segments)

    @app.get("/api/calibration/campaigns")
    def calibration_campaigns():
        denied = require_admin()
        if denied:
            return denied
        conn = connection()
        try:
            rows = conn.execute(
                """SELECT c.*, (SELECT COUNT(*) FROM calibration_runs r
                                WHERE r.campaign_id = c.id AND r.source_file IS NOT NULL) AS linked_runs
                   FROM calibration_campaigns c WHERE project_id = ? ORDER BY updated_at DESC""",
                (project_id_provider(),),
            ).fetchall()
            return jsonify(campaigns=[campaign_row(row) for row in rows])
        finally:
            conn.close()

    @app.post("/api/calibration/campaigns")
    def create_calibration_campaign():
        denied = require_admin()
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        try:
            protocol = parse_protocol(payload.get("protocol"))
        except (TypeError, ValueError) as error:
            return jsonify({"error": str(error)}), 400
        name = str(payload.get("name") or "").strip()[:120] or time.strftime("Calibration voie %s — %d/%m/%Y %H:%M") % protocol["channel"]
        now = time.time()
        campaign_id = uuid.uuid4().hex
        account = getattr(g, "account", None) or {}
        conn = connection()
        try:
            conn.execute(
                """INSERT INTO calibration_campaigns(id, project_id, name, created_at, updated_at, created_by, protocol_json, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (campaign_id, project_id_provider(), name, now, now, account.get("email"),
                 json.dumps(protocol), str(payload.get("notes") or "")[:4000]),
            )
            conn.commit()
            return jsonify(campaign=load_campaign(conn, campaign_id)), 201
        finally:
            conn.close()

    @app.get("/api/calibration/campaigns/<campaign_id>")
    def get_calibration_campaign(campaign_id):
        denied = require_admin()
        if denied:
            return denied
        conn = connection()
        try:
            return jsonify(campaign=load_campaign(conn, campaign_id))
        finally:
            conn.close()

    @app.put("/api/calibration/campaigns/<campaign_id>")
    def update_calibration_campaign(campaign_id):
        denied = require_admin()
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        conn = connection()
        try:
            campaign = load_campaign(conn, campaign_id)
            try:
                protocol = parse_protocol(payload.get("protocol") or {}, campaign["protocol"])
            except (TypeError, ValueError) as error:
                return jsonify({"error": str(error)}), 400
            name = str(payload.get("name") or campaign["name"]).strip()[:120]
            notes = str(payload.get("notes", campaign["notes"]) or "")[:4000]
            conn.execute(
                "UPDATE calibration_campaigns SET name = ?, notes = ?, protocol_json = ?, updated_at = ? WHERE id = ?",
                (name, notes, json.dumps(protocol), time.time(), campaign_id),
            )
            conn.execute("DELETE FROM calibration_runs WHERE campaign_id = ? AND run_index > ?",
                         (campaign_id, protocol["repetitions"]))
            conn.commit()
            return jsonify(campaign=load_campaign(conn, campaign_id))
        finally:
            conn.close()

    @app.delete("/api/calibration/campaigns/<campaign_id>")
    def delete_calibration_campaign(campaign_id):
        denied = require_admin()
        if denied:
            return denied
        conn = connection()
        try:
            load_campaign(conn, campaign_id)
            conn.execute("DELETE FROM calibration_runs WHERE campaign_id = ?", (campaign_id,))
            conn.execute("DELETE FROM calibration_campaigns WHERE id = ?", (campaign_id,))
            conn.commit()
            return jsonify(status="deleted")
        finally:
            conn.close()

    @app.put("/api/calibration/campaigns/<campaign_id>/runs/<int:run_index>")
    def save_calibration_run(campaign_id, run_index):
        denied = require_admin()
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        conn = connection()
        try:
            campaign = load_campaign(conn, campaign_id)
            if not 1 <= run_index <= int(campaign["protocol"]["repetitions"]):
                return jsonify({"error": "Répétition hors protocole."}), 400
            def parse_points(raw):
                points = {}
                for key, value in (raw or {}).items():
                    number = optional_float(value)
                    if number is not None:
                        points[str(int(float(key)) if float(key).is_integer() else float(key))] = number
                return points

            def parse_range(value):
                fluke_range = optional_float(value)
                if fluke_range is not None and not any(math.isclose(fluke_range, s[0]) for s in FLUKE_287_DC_CURRENT):
                    raise ValueError("Borne Fluke inconnue.")
                return fluke_range

            try:
                multi = campaign["protocol"].get("channel") == "AB"
                if multi:
                    per_channel = {}
                    for channel in ("A", "B"):
                        data = (payload.get("channels") or {}).get(channel) or {}
                        per_channel[channel] = {
                            "points": parse_points(data.get("reference")),
                            "min": optional_float(data.get("fluke_min_A")),
                            "max": optional_float(data.get("fluke_max_A")),
                            "range": parse_range(data.get("fluke_range_A")),
                        }
                    references = {"channels": per_channel}
                else:
                    references = parse_points(payload.get("reference"))
                samples_reported = payload.get("samples_reported")
                samples_reported = None if samples_reported in (None, "") else int(samples_reported)
                if samples_reported is not None and samples_reported < 0:
                    raise ValueError("Nombre d'échantillons invalide.")
                fluke_range = None if multi else parse_range(payload.get("fluke_range_A"))
                values = (
                    (payload.get("source_file") or None),
                    optional_float(payload.get("start_offset_s")) or 0.0,
                    samples_reported,
                    json.dumps(references),
                    None if multi else optional_float(payload.get("fluke_min_A")),
                    None if multi else optional_float(payload.get("fluke_max_A")),
                    fluke_range,
                    optional_float(payload.get("ambient_c")),
                    str(payload.get("notes") or "")[:2000],
                )
            except (TypeError, ValueError) as error:
                return jsonify({"error": str(error) or "Valeur invalide."}), 400
            existing = conn.execute(
                "SELECT id FROM calibration_runs WHERE campaign_id = ? AND run_index = ?", (campaign_id, run_index)
            ).fetchone()
            run_id = existing[0] if existing else uuid.uuid4().hex
            conn.execute(
                """INSERT INTO calibration_runs(id, campaign_id, run_index, source_file, start_offset_s, samples_reported,
                       reference_json, fluke_min_A, fluke_max_A, fluke_range_A, ambient_c, notes, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(campaign_id, run_index) DO UPDATE SET
                       source_file = excluded.source_file, start_offset_s = excluded.start_offset_s,
                       samples_reported = excluded.samples_reported, reference_json = excluded.reference_json,
                       fluke_min_A = excluded.fluke_min_A, fluke_max_A = excluded.fluke_max_A,
                       fluke_range_A = excluded.fluke_range_A, ambient_c = excluded.ambient_c,
                       notes = excluded.notes, updated_at = excluded.updated_at""",
                (run_id, campaign_id, run_index, *values, time.time()),
            )
            conn.execute("UPDATE calibration_campaigns SET updated_at = ? WHERE id = ?", (time.time(), campaign_id))
            conn.commit()
            return jsonify(campaign=load_campaign(conn, campaign_id))
        finally:
            conn.close()

    @app.get("/api/calibration/campaigns/<campaign_id>/analysis")
    def calibration_analysis(campaign_id):
        denied = require_admin()
        if denied:
            return denied
        conn = connection()
        try:
            return jsonify(analysis=analyse_campaign(conn, load_campaign(conn, campaign_id)))
        finally:
            conn.close()

    @app.get("/api/calibration/overview")
    def calibration_overview():
        denied = require_admin()
        if denied:
            return denied
        channel = request.args.get("channel", "A")
        conn = connection()
        try:
            ids = [row[0] for row in conn.execute(
                "SELECT id FROM calibration_campaigns WHERE project_id = ? ORDER BY created_at", (project_id_provider(),)
            )]
            results = []
            for campaign_id in ids:
                campaign = load_campaign(conn, campaign_id)
                if channel not in protocol_channels(campaign["protocol"]):
                    continue
                full = analyse_campaign(conn, campaign)
                analysis = {"id": full["id"], "name": full["name"], **full["by_channel"][channel]}
                for run in analysis["runs"]:
                    for key in ("series", "series_smoothed", "histogram", "dt_histogram", "allan"):
                        run.pop(key, None)
                results.append(analysis)
            return jsonify(
                channel=channel,
                campaigns=[{"id": c["id"], "name": c["name"], "summary": {k: v for k, v in c["summary"].items() if k != "bland_altman"}}
                           for c in results],
                regression=multilevel_regression(results),
            )
        finally:
            conn.close()

    @app.get("/api/calibration/campaigns/<campaign_id>/export.csv")
    def calibration_export(campaign_id):
        denied = require_admin()
        if denied:
            return denied
        conn = connection()
        try:
            analysis = analyse_campaign(conn, load_campaign(conn, campaign_id))
        finally:
            conn.close()
        buffer = io.StringIO()
        writer = csv.writer(buffer, delimiter=";")
        writer.writerow(["Campagne", analysis["name"]])
        writer.writerow(["Protocole", json.dumps(analysis["protocol"], ensure_ascii=False)])
        writer.writerow([])
        writer.writerow(["Canal", "Répétition", "Source", "Échantillons base", "Attendus", "Relevés", "Complétude %",
                         "Fréquence effective Hz", "Moyenne A", "Écart-type A", "Min A", "Max A",
                         "Crête-crête A", "Dérive A/min", "Fluke min A", "Fluke max A"])
        for channel, run in ((c, r) for c in analysis["channels"] for r in analysis["by_channel"][c]["runs"]):
            extremes = {e["kind"]: e for e in run.get("extremes", [])}
            writer.writerow([channel, run["run_index"], run.get("source_file") or "", run["samples"], run["samples_expected"],
                             run.get("samples_reported") or "", run.get("completeness_pct"), run.get("effective_rate_hz"),
                             run.get("mean_A"), run.get("std_A"), run.get("min_A"), run.get("max_A"), run.get("p2p_A"),
                             run.get("drift_A_per_min"),
                             (extremes.get("min") or {}).get("reference_A"), (extremes.get("max") or {}).get("reference_A")])
        writer.writerow([])
        writer.writerow(["Canal", "Répétition", "Instant s", "Référence A", "INA moyenne A", "INA écart-type A", "Échantillons",
                         "Erreur A", "Erreur %", "Limite Fluke A", "Limite INA226 A", "Statut"])
        for channel, run in ((c, r) for c in analysis["channels"] for r in analysis["by_channel"][c]["runs"]):
            for cp in run["checkpoints"]:
                writer.writerow([channel, run["run_index"], cp["t_s"], cp.get("reference_A"), cp.get("ina_mean_A"),
                                 cp.get("ina_std_A"), cp.get("samples"), cp.get("error_A"), cp.get("error_pct"),
                                 cp.get("reference_limit_A"), cp.get("ina_limit_A"), cp.get("status")])
        filename = f"calibration_{campaign_id[:8]}.csv"
        return Response("﻿" + buffer.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": f"attachment; filename={filename}"})
