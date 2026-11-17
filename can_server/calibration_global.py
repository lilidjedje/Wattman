"""Analyse globale des campagnes de calibration INA226 ↔ Fluke 287.

Trois couches, toutes construites sur les résultats déjà calculés par
calibration.campaign_summary (aucune mesure brute n'est relue ici) :

1. Indicateurs par campagne et par voie, score de santé 0-100 et sous-scores
   (« où ça cloche ») comparables d'une campagne à l'autre.
2. Diagnostic expert local : règles d'ingénierie appliquées à l'ensemble des
   campagnes (biais commun, gain, bruit vs fréquence, voies, tendance, plan de
   test). Fonctionne hors ligne ; aucune donnée ne quitte le poste.
3. Analyse Claude facultative : n'envoie que les indicateurs agrégés (jamais les
   échantillons) et seulement sur action explicite de l'utilisateur.
"""
from __future__ import annotations

import json
import math
import os
from statistics import median

INA226_LSB_V = 2.5e-6
METRIC_KEYS = (
    "offset_A", "error_std_A", "error_rms_A", "error_max_abs_A", "offset_u95_A",
    "reference_mean_A", "reference_limit_A", "ina_limit_A", "noise_pooled_A",
    "run_mean_spread_A", "drift_mean_A_per_min", "allan_best_tau_s", "allan_best_adev_A",
    "completeness_pct", "pass_count", "warning_count", "fail_count",
    "checkpoints_with_reference", "runs_with_data", "runs_total", "verdict",
)
# Poids du score de santé. Une composante absente est retirée et les poids renormalisés.
WEIGHTS = {"accuracy": .35, "conformity": .20, "noise": .20, "stability": .10, "completeness": .15}
AXIS_LABELS = {
    "accuracy": "Justesse (biais)", "conformity": "Conformité des relevés", "noise": "Bruit",
    "stability": "Stabilité (dérive)", "completeness": "Complétude", "repeatability": "Reproductibilité",
}


def _clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def _lsb(protocol):
    return INA226_LSB_V / float(protocol.get("shunt_ohm") or 0.010)


def _fr(value, digits=3, signed=False):
    text = f"{value:{'+' if signed else ''}.{digits}f}".replace("-", "−").replace(".", ",")
    return text


def _ma(value, signed=False):
    return "—" if value is None else f"{_fr(value * 1000, 3, signed)} mA"


def campaign_metrics(campaign, channel, analysis):
    """Ligne d'analyse globale pour une campagne et une voie."""
    protocol = campaign["protocol"]
    summary = analysis["summary"]
    metrics = {key: summary.get(key) for key in METRIC_KEYS}
    lsb = _lsb(protocol)
    limit = summary.get("reference_limit_A")
    offset = summary.get("offset_A")
    noise = summary.get("noise_pooled_A")
    drift = summary.get("drift_mean_A_per_min")
    ref = summary.get("reference_mean_A")
    checked = sum(summary.get(k) or 0 for k in ("pass_count", "warning_count", "fail_count"))

    axes = {}  # 1 = parfait, 0 = très mauvais
    if offset is not None and limit is not None:
        tolerance = max(limit, lsb)
        axes["accuracy"] = _clamp(1 - max(0.0, abs(offset) - tolerance) / (4 * tolerance))
    if checked:
        axes["conformity"] = (summary.get("pass_count", 0) + .5 * summary.get("warning_count", 0)) / checked
    if noise is not None:
        axes["noise"] = _clamp(1 - max(0.0, noise - 2 * lsb) / (20 * lsb))
    if drift is not None:
        per_run = abs(drift) * float(protocol["duration_s"]) / 60
        axes["stability"] = _clamp(1 - max(0.0, per_run - lsb) / (8 * lsb))
    if summary.get("completeness_pct") is not None and summary.get("runs_with_data"):
        axes["completeness"] = _clamp((summary["completeness_pct"] - 90) / 10)
    spread = summary.get("run_mean_spread_A")
    if spread is not None:
        axes["repeatability"] = _clamp(1 - max(0.0, spread - lsb) / (8 * max(lsb, limit or lsb)))
    weights = {k: w for k, w in WEIGHTS.items() if k in axes}
    total = sum(weights.values())
    score = round(100 * sum(axes[k] * w for k, w in weights.items()) / total) if total else None
    worst_axis = min(axes, key=axes.get) if axes else None

    return {
        "id": campaign["id"], "name": campaign["name"], "channel": channel,
        "created_at": campaign.get("created_at"), "updated_at": campaign.get("updated_at"),
        "notes": campaign.get("notes") or "",
        "protocol": {
            "frequency_hz": protocol.get("frequency_hz"), "duration_s": protocol.get("duration_s"),
            "repetitions": protocol.get("repetitions"), "pause_s": protocol.get("pause_s"),
            "shunt_ohm": protocol.get("shunt_ohm"), "checkpoints": len(protocol.get("checkpoints_s") or []),
        },
        "metrics": metrics,
        "derived": {
            "lsb_A": lsb,
            "offset_over_limit": abs(offset) / limit if offset is not None and limit else None,
            "relative_error_pct": 100 * offset / ref if offset is not None and ref and abs(ref) >= 0.01 else None,
            "noise_lsb": noise / lsb if noise is not None else None,
            "drift_per_run_A": abs(drift) * float(protocol["duration_s"]) / 60 if drift is not None else None,
        },
        "axes": axes, "score": score, "worst_axis": worst_axis,
        "recommendations": summary.get("recommendations") or [],
    }


def checkpoint_points(campaign, channel, analysis):
    points = []
    for run in analysis["runs"]:
        for cp in run.get("checkpoints", []):
            if cp.get("error_A") is None:
                continue
            points.append({"campaign_id": campaign["id"], "campaign": campaign["name"], "channel": channel,
                           "run": run["run_index"], "t_s": cp["t_s"], "reference_A": cp["reference_A"],
                           "error_A": cp["error_A"], "status": cp["status"], "limit_A": cp.get("reference_limit_A")})
    return points


def _insight(level, title, text, action=None, campaigns=None, axis=None):
    return {"level": level, "title": title, "text": text, "action": action,
            "campaigns": campaigns or [], "axis": axis}


def expert_insights(rows, regressions):
    """Diagnostic transversal : ce qui cloche le plus, ce qui fonctionne, quoi faire."""
    found = []
    measured = [r for r in rows if r["score"] is not None]
    if not measured:
        return [_insight("info", "Aucune campagne exploitable",
                         "Reliez au moins une mesure et saisissez les relevés Fluke pour lancer l'analyse globale.")]

    # 1. Campagnes les plus faibles et leur cause dominante.
    weakest = sorted(measured, key=lambda r: r["score"])[:3]
    if weakest[0]["score"] < 70:
        names = ", ".join(f"« {r['name']} » ({r['channel']}, {r['score']}/100 — {AXIS_LABELS.get(r['worst_axis'], '?').lower()})"
                          for r in weakest if r["score"] < 70)
        found.append(_insight("fail", "Campagnes les plus en difficulté", names,
                              "Ouvrez ces campagnes en premier : la cause dominante est indiquée entre parenthèses.",
                              [r["id"] for r in weakest if r["score"] < 70]))

    # 2. Axe le plus pénalisant sur l'ensemble.
    axis_means = {}
    for axis in AXIS_LABELS:
        values = [r["axes"][axis] for r in measured if axis in r["axes"]]
        if values:
            axis_means[axis] = sum(values) / len(values)
    if axis_means:
        worst = min(axis_means, key=axis_means.get)
        best = max(axis_means, key=axis_means.get)
        if axis_means[worst] < .75:
            found.append(_insight("warning", f"Point faible global : {AXIS_LABELS[worst].lower()}",
                                  f"Score moyen {axis_means[worst] * 100:.0f} % sur {len(measured)} campagne(s). "
                                  f"Point fort : {AXIS_LABELS[best].lower()} ({axis_means[best] * 100:.0f} %).", axis=worst))

    # 3. Biais commun : même signe, au-delà du Fluke, sur la majorité des campagnes.
    biased = [r for r in measured if (r["derived"]["offset_over_limit"] or 0) > 1]
    if len(biased) >= max(2, math.ceil(.6 * len(measured))):
        signs = [math.copysign(1, r["metrics"]["offset_A"]) for r in biased]
        if abs(sum(signs)) == len(signs):
            med = median(r["metrics"]["offset_A"] for r in biased)
            found.append(_insight("fail", "Biais systématique commun à la plupart des campagnes",
                                  f"{len(biased)}/{len(measured)} campagnes ont un biais de même signe au-delà de l'incertitude Fluke "
                                  f"(médiane {_ma(med, True)}). C'est une erreur de zéro ou de gain du capteur, pas un problème de banc ponctuel.",
                                  "Refaire la tare du zéro (courant nul, firmware v8+, POST /api/calibration action=zero) puis la "
                                  "référence de gain, et relancer une campagne d'offset de 60 s pour vérifier.",
                                  [r["id"] for r in biased]))

    # 4. Offset vs gain : régression multi-niveaux par voie. Une régression sur toutes
    #    les campagnes mélange souvent des calibrations différentes (avant / après tare) :
    #    on privilégie celle des campagnes récentes quand elle est plus cohérente.
    for channel, reg in regressions.items():
        recent = reg.get("recent") or {}
        chosen, scope = reg, "toutes les campagnes"
        if recent.get("status") == "ok" and (reg.get("status") != "ok" or recent["r2"] > reg["r2"]):
            chosen, scope = recent, f"les {recent['campaigns']} campagnes les plus récentes"
        if chosen.get("status") == "ok":
            gain, offset = chosen["gain_error_pct"], chosen["offset_A"]
            limits = [r["metrics"]["reference_limit_A"] for r in measured if r["channel"] == channel and r["metrics"]["reference_limit_A"]]
            lsb = next((r["derived"]["lsb_A"] for r in measured if r["channel"] == channel), 2.5e-4)
            offset_limit = max(median(limits) if limits else 0, 2 * lsb)
            gain_level = 2 if abs(gain) > 1 else 1 if abs(gain) > .3 else 0
            offset_level = 2 if abs(offset) > 4 * offset_limit else 1 if abs(offset) > offset_limit else 0
            level = ("pass", "warning", "fail")[max(gain_level, offset_level)]
            text = (f"Sur {scope} : erreur ≈ {_ma(offset, True)} {'+' if gain >= 0 else '−'} {_fr(abs(gain), 3)} % × I "
                    f"(R² {_fr(chosen['r2'], 3)}, plage {_ma(chosen['span_A'])}).")
            if chosen is reg and reg["r2"] < .8:
                level = "warning"
                text += (" Relation peu fiable : les campagnes ne partagent sans doute pas la même calibration "
                         "(avant / après tare, changement de firmware ou de montage).")
            parts = []
            if offset_level:
                parts.append(f"offset de {_ma(offset, True)} à corriger par une nouvelle tare du zéro")
            if gain_level:
                parts.append(f"gain à corriger d'un facteur {_fr(chosen['correction']['gain_factor'], 6)}")
            action = ("À faire : " + " ; ".join(parts) + ".") if parts else "Offset et gain conformes : conservez la calibration actuelle."
            if chosen is reg and reg["r2"] < .8:
                action = ("N'appliquez pas cette correction : refaites une série homogène (même firmware, même tare, "
                          "même montage) à 0 A, 100 mA, 300 mA et 1 A, puis relisez cette régression.")
            found.append(_insight(level, f"Voie {channel} : séparation offset / gain", text, action))
        elif reg.get("status") == "single_level":
            found.append(_insight("info", f"Voie {channel} : un seul niveau de courant testé",
                                  "Avec un seul niveau, un biais peut venir du zéro comme du gain : impossible de trancher.",
                                  "Ajoutez des campagnes à 0 A, 100 mA, 300 mA, 1 A et au courant maximal d'usage."))

    # 5. Bruit : niveau absolu et dépendance à la fréquence.
    noisy = [r for r in measured if (r["derived"]["noise_lsb"] or 0) > 8]
    if noisy:
        worst_noise = max(noisy, key=lambda r: r["derived"]["noise_lsb"])
        found.append(_insight("warning", "Bruit nettement supérieur à celui de l'INA226",
                              f"{len(noisy)} campagne(s) dépassent 8 LSB de bruit (max « {worst_noise['name']} » : "
                              f"{_ma(worst_noise['metrics']['noise_pooled_A'])}, {worst_noise['derived']['noise_lsb']:.0f} LSB). "
                              "Le capteur seul est à quelques LSB : le reste vient du montage.",
                              "Prises Kelvin soudées au shunt, fils de mesure torsadés et courts, une seule masse (boucle avec le "
                              "Fluke ?), éloigner l'ESP32 et le Wi-Fi des fils de puissance, essai alimentation sur batterie.",
                              [r["id"] for r in noisy], "noise"))
    by_freq = {}
    for r in measured:
        if r["metrics"]["noise_pooled_A"] is not None and r["protocol"]["frequency_hz"]:
            by_freq.setdefault(float(r["protocol"]["frequency_hz"]), []).append(r["metrics"]["noise_pooled_A"])
    if len(by_freq) >= 2:
        freqs = sorted(by_freq)
        low, high = median(by_freq[freqs[0]]), median(by_freq[freqs[-1]])
        if high > 1.5 * low:
            found.append(_insight("info", "Le bruit augmente avec la fréquence d'acquisition",
                                  f"Médiane {_ma(low)} à {freqs[0]:g} Hz contre {_ma(high)} à {freqs[-1]:g} Hz : "
                                  "au-dessus de 100 Hz le capteur ne moyenne plus en interne.",
                                  "Gardez 100 Hz pour la précision ; réservez les fréquences élevées à l'observation des transitoires.",
                                  axis="noise"))

    # 6. Comparaison des voies.
    channels = {}
    for r in measured:
        channels.setdefault(r["channel"], []).append(r)
    if len(channels) >= 2:
        medians = {ch: median(r["score"] for r in items) for ch, items in channels.items()}
        worst_ch, best_ch = min(medians, key=medians.get), max(medians, key=medians.get)
        if medians[best_ch] - medians[worst_ch] >= 15:
            found.append(_insight("warning", f"La voie {worst_ch} est en retrait",
                                  f"Score médian {medians[worst_ch]:.0f}/100 contre {medians[best_ch]:.0f}/100 pour la voie {best_ch}.",
                                  f"Comparez le câblage et le shunt de la voie {worst_ch} ; refaites sa tare et sa référence séparément."))

    # 7. Tendance dans le temps.
    dated = sorted([r for r in measured if r["created_at"]], key=lambda r: r["created_at"])
    if len(dated) >= 4:
        half = len(dated) // 2
        before = sum(r["score"] for r in dated[:half]) / half
        after = sum(r["score"] for r in dated[half:]) / (len(dated) - half)
        if after - before >= 10:
            found.append(_insight("pass", "Les campagnes récentes s'améliorent",
                                  f"Score moyen {before:.0f} → {after:.0f}/100 entre la première et la seconde moitié des campagnes.",
                                  "Les corrections récentes (firmware, tare, câblage) portent leurs fruits : figez ce montage."))
        elif before - after >= 10:
            found.append(_insight("warning", "Dégradation sur les campagnes récentes",
                                  f"Score moyen {before:.0f} → {after:.0f}/100.",
                                  "Vérifiez ce qui a changé : firmware, coefficients NVS, shunt, câblage, température du banc."))

    # 8. Complétude, dérive, reproductibilité.
    lossy = [r for r in measured if r["metrics"]["completeness_pct"] is not None and r["metrics"]["completeness_pct"] < 99 and r["metrics"]["runs_with_data"]]
    if lossy:
        found.append(_insight("warning", "Échantillons perdus",
                              f"{len(lossy)} campagne(s) sous 99 % de complétude (min "
                              f"{_fr(min(r['metrics']['completeness_pct'] for r in lossy), 1)} %).",
                              "Contrôlez i2c_errors et lost sur l'ESP32, la charge Wi-Fi et l'écran pendant l'acquisition.",
                              [r["id"] for r in lossy], "completeness"))
    drifting = [r for r in measured if r["axes"].get("stability", 1) < .6]
    if drifting:
        found.append(_insight("warning", "Dérive pendant la mesure",
                              f"{len(drifting)} campagne(s) dérivent de plus de quelques LSB sur une répétition.",
                              "Préchauffez le banc 10 min, mesurez la température du shunt, comparez avec la dérive du Fluke.",
                              [r["id"] for r in drifting], "stability"))

    # 9. Plan de test : couverture et puissance statistique.
    few_reps = [r for r in measured if int(r["protocol"]["repetitions"] or 0) < 3]
    if len(few_reps) >= max(1, len(measured) // 2):
        found.append(_insight("info", "Peu de répétitions par campagne",
                              f"{len(few_reps)}/{len(measured)} campagnes ont moins de 3 répétitions : la reproductibilité n'est pas mesurable.",
                              "Passez à 3 répétitions de 60 s avec pause, au même niveau de courant."))

    # 10. Ce qui fonctionne.
    good = [r for r in measured if r["score"] >= 85]
    if good:
        freqs = sorted({f"{r['protocol']['frequency_hz']:g} Hz" for r in good if r["protocol"]["frequency_hz"]})
        found.append(_insight("pass", "Ce qui fonctionne",
                              f"{len(good)} campagne(s) à 85/100 ou plus ({', '.join(r['name'] for r in good[:4])}"
                              f"{'…' if len(good) > 4 else ''}). Réglages communs : {', '.join(freqs) or '—'}.",
                              "Servez-vous en comme référence de montage et de protocole.", [r["id"] for r in good]))
    order = {"fail": 0, "warning": 1, "info": 2, "pass": 3}
    return sorted(found, key=lambda item: order[item["level"]])


# ---------------------------------------------------------------------------
# Analyse Claude (facultative)
# ---------------------------------------------------------------------------
AI_MODEL = "claude-opus-5-5"
AI_SCHEMA = {
    "type": "object",
    "properties": {
        "synthese": {"type": "string"},
        "problemes": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "titre": {"type": "string"},
                "gravite": {"type": "string", "enum": ["critique", "majeure", "mineure"]},
                "constat": {"type": "string"},
                "cause_probable": {"type": "string"},
                "campagnes": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["titre", "gravite", "constat", "cause_probable", "campagnes"],
            "additionalProperties": False,
        }},
        "points_forts": {"type": "array", "items": {"type": "string"}},
        "plan_amelioration": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "action": {"type": "string"},
                "detail": {"type": "string"},
                "gain_attendu": {"type": "string"},
                "priorite": {"type": "integer"},
            },
            "required": ["action", "detail", "gain_attendu", "priorite"],
            "additionalProperties": False,
        }},
        "prochaines_campagnes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["synthese", "problemes", "points_forts", "plan_amelioration", "prochaines_campagnes"],
    "additionalProperties": False,
}
AI_SYSTEM = (
    "Tu es ingénieur métrologie senior, spécialiste de la mesure de courant par shunt et INA226 (ADC 16 bits, "
    "LSB tension shunt 2,5 µV, offset max 10 µV) comparée à un multimètre Fluke 287 de référence. "
    "Tu reçois les indicateurs agrégés de toutes les campagnes de calibration d'un banc ESP32 + INA226 : "
    "protocole, biais INA − Fluke, dispersion, bruit, dérive, Allan, complétude, verdicts, régressions "
    "multi-niveaux et le diagnostic d'un moteur de règles local. Compare les campagnes entre elles, identifie "
    "où les résultats se dégradent et pourquoi, distingue offset, gain, bruit de montage et limites du capteur, "
    "et propose un plan d'amélioration concret et priorisé (matériel, firmware, protocole). "
    "Appuie chaque affirmation sur les chiffres fournis ; si une donnée manque, dis-le au lieu de supposer. "
    "Réponds en français, de façon concise et technique. Les valeurs sont en ampères sauf mention contraire."
)


def ai_payload(rows, regressions, insights):
    """Indicateurs agrégés uniquement : aucune mesure brute, aucune note libre."""
    def compact(row):
        return {"campagne": row["name"], "voie": row["channel"], "score": row["score"],
                "axes": {k: round(v, 3) for k, v in row["axes"].items()},
                "protocole": row["protocol"],
                "indicateurs": {k: v for k, v in row["metrics"].items() if v is not None},
                "derives": {k: v for k, v in row["derived"].items() if v is not None}}
    return {"campagnes": [compact(r) for r in rows],
            "regressions_multi_niveaux": {ch: {k: v for k, v in reg.items() if k != "points"} for ch, reg in regressions.items()},
            "diagnostic_local": [{"niveau": i["level"], "titre": i["title"], "constat": i["text"]} for i in insights]}


def ai_status():
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return {"available": False, "reason": "Le paquet Python « anthropic » n'est pas installé (pip install anthropic)."}
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        return {"available": False, "reason": "Aucune clé API : définissez ANTHROPIC_API_KEY avant de lancer l'application."}
    return {"available": True, "model": AI_MODEL}


def run_ai_analysis(payload):
    """Appelle Claude avec une sortie JSON structurée. Lève RuntimeError avec un message lisible."""
    status = ai_status()
    if not status["available"]:
        raise RuntimeError(status["reason"])
    import anthropic
    client = anthropic.Anthropic()
    try:
        # Sortie structurée garantie ; repli serveur automatique si le modèle décline la requête.
        response = client.beta.messages.create(
            model=AI_MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "high", "format": {"type": "json_schema", "schema": AI_SCHEMA}},
            system=AI_SYSTEM,
            messages=[{"role": "user", "content":
                       "Voici les données agrégées des campagnes (JSON). Analyse-les et produis le rapport demandé.\n\n"
                       + json.dumps(payload, ensure_ascii=False, sort_keys=True)}],
        )
    except anthropic.AuthenticationError as error:
        raise RuntimeError("Clé API refusée par Anthropic.") from error
    except anthropic.RateLimitError as error:
        raise RuntimeError("Limite de requêtes atteinte : réessayez dans une minute.") from error
    except anthropic.APIStatusError as error:
        raise RuntimeError(f"Erreur de l'API Claude ({error.status_code}) : {error.message}") from error
    except anthropic.APIConnectionError as error:
        raise RuntimeError("API Claude injoignable : vérifiez la connexion réseau ou le proxy.") from error
    if response.stop_reason == "refusal":
        raise RuntimeError("L'analyse a été déclinée par le modèle.")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Réponse tronquée : trop de campagnes pour une seule analyse.")
    text = next((block.text for block in response.content if block.type == "text"), "")
    result = json.loads(text)
    result["model"] = response.model
    return result
