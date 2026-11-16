"""Catalogue lisible de la base de mesures et suppression sélective.

Chaque enregistrement (source_file) est décrit par son type (log ASC importé ou
mesure numérique ESP32), un libellé daté, ses canaux et ses volumes, afin de les
distinguer d'un coup d'œil et de supprimer précisément ce qui doit l'être.
"""
import re
from datetime import datetime

ASC_PATTERN = re.compile(r"^can_[^_]+_\d+_(.+)$")


def source_kind(source_file):
    if source_file.startswith("live_"):
        return "digital"
    if source_file.startswith("can_"):
        return "asc"
    return "other"


def format_moment(timestamp):
    if timestamp is None:
        return "date inconnue"
    try:
        return datetime.fromtimestamp(timestamp).strftime("%d/%m/%Y %H:%M:%S")
    except (OverflowError, OSError, ValueError):
        return "date inconnue"


def describe_sources(conn, limit=2000):
    filenames = {
        row[0]: row[1]
        for row in conn.execute("SELECT source_file, filename FROM imported_can_files")
    }
    rows = conn.execute(
        """SELECT source_file, channel, COUNT(*) AS samples,
                  MIN(timestamp) AS start, MAX(timestamp) AS end,
                  MAX(frequency_Hz) AS frequency_hz
           FROM measurements
           WHERE source_file IS NOT NULL AND source_file != ''
           GROUP BY source_file, channel""",
    ).fetchall()
    sources = {}
    for row in rows:
        key = row["source_file"]
        item = sources.setdefault(key, {
            "source_file": key,
            "kind": source_kind(key),
            "channels": {},
            "samples": 0,
            "start": None,
            "end": None,
        })
        item["channels"][row["channel"]] = {
            "samples": row["samples"],
            "start": row["start"],
            "end": row["end"],
            "frequency_hz": row["frequency_hz"],
        }
        item["samples"] += row["samples"]
        item["start"] = row["start"] if item["start"] is None else min(item["start"], row["start"])
        item["end"] = row["end"] if item["end"] is None else max(item["end"], row["end"])
    for key in filenames:
        sources.setdefault(key, {
            "source_file": key, "kind": "asc", "channels": {}, "samples": 0, "start": None, "end": None,
        })
    result = []
    for item in sources.values():
        moment = format_moment(item["start"])
        channels = "+".join(sorted(item["channels"])) or "aucun canal"
        if item["kind"] == "asc":
            match = ASC_PATTERN.match(item["source_file"])
            name = filenames.get(item["source_file"]) or (match.group(1) if match else item["source_file"])
            item["name"] = name
            item["label"] = f"Log ASC · {name} · {moment} · Canal {channels}"
        elif item["kind"] == "digital":
            item["name"] = f"Mesure numérique du {moment}"
            item["label"] = f"Numérique ESP32 · {moment} · Canal {channels}"
        else:
            item["name"] = item["source_file"]
            item["label"] = f"{item['source_file']} · {moment} · Canal {channels}"
        item["started_label"] = moment
        item["ended_label"] = format_moment(item["end"])
        item["duration_s"] = (item["end"] - item["start"]) if item["start"] is not None else 0
        result.append(item)
    result.sort(key=lambda entry: entry["start"] or 0, reverse=True)
    return result[:limit]


def delete_sources(conn, items):
    """items : [{source_file, channels: ['A','B'] | None}] ; None = toute la source."""
    deleted = 0
    removed_sources = []
    for item in items:
        source = str(item.get("source_file") or "")
        if not source:
            continue
        channels = item.get("channels")
        if channels:
            channels = [c for c in channels if c in ("A", "B")]
            if not channels:
                continue
            marks = ",".join("?" for _ in channels)
            deleted += conn.execute(
                f"DELETE FROM measurements WHERE source_file = ? AND channel IN ({marks})", (source, *channels)
            ).rowcount
            conn.execute(
                f"DELETE FROM measurements_summary_1m WHERE source_file = ? AND channel IN ({marks})", (source, *channels)
            )
            remaining = conn.execute("SELECT 1 FROM measurements WHERE source_file = ? LIMIT 1", (source,)).fetchone()
        else:
            deleted += conn.execute("DELETE FROM measurements WHERE source_file = ?", (source,)).rowcount
            conn.execute("DELETE FROM measurements_summary_1m WHERE source_file = ?", (source,))
            remaining = None
        if remaining is None:
            conn.execute("DELETE FROM imported_can_files WHERE source_file = ?", (source,))
            removed_sources.append(source)
    return deleted, removed_sources
