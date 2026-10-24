from flask import Flask, render_template, request, jsonify, Response, redirect, url_for
import sqlite3
import os
import time
import io
import csv
import os
import json
import socket
import subprocess
import threading
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from datetime import datetime, timedelta
from database import get_db_connection, init_db
from can_parser import iter_asc_stream_rows
from sharepoint_sync import backup_to_sharepoint_local_mount
from can_collector import TcpCanCollector



PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(PROJECT_DIR, "templates"),
    static_folder=os.path.join(PROJECT_DIR, "static")
)
THEORY_IMPORT_LIMIT = 50 * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"] = THEORY_IMPORT_LIMIT
app.config["MAX_FORM_MEMORY_SIZE"] = THEORY_IMPORT_LIMIT
# Les mesures numériques arrivent toujours directement de l'ESP32-C3 par Wi-Fi.
# Le mode CAN est exploité séparément, par import des fichiers ASC.
can_collector = TcpCanCollector()


def get_request_timestamps(start_key="start", end_key="end"):
    """Parse timestamps from query params with priority to explicit epoch values."""
    ts_start = None
    ts_end = None

    start_ts_raw = request.args.get("start_ts", "").strip()
    end_ts_raw = request.args.get("end_ts", "").strip()

    if start_ts_raw:
        try:
            ts_start = float(start_ts_raw)
        except ValueError:
            ts_start = None
    if end_ts_raw:
        try:
            ts_end = float(end_ts_raw)
        except ValueError:
            ts_end = None

    if ts_start is None:
        start_str = request.args.get(start_key, "").strip()
        if start_str:
            try:
                ts_start = datetime.strptime(start_str, "%Y-%m-%dT%H:%M").timestamp()
            except ValueError:
                ts_start = None

    if ts_end is None:
        end_str = request.args.get(end_key, "").strip()
        if end_str:
            try:
                ts_end = datetime.strptime(end_str, "%Y-%m-%dT%H:%M").timestamp()
            except ValueError:
                ts_end = None

    return ts_start, ts_end

DATA_DIR = (
    os.path.join(os.environ["ENGINEERING_APP_DATA"], "can_data")
    if os.environ.get("ENGINEERING_APP_DATA")
    else os.path.join(PROJECT_DIR, "data")
)
THEORY_FILE = os.path.join(DATA_DIR, "theory_snapshot.json")
SESSIONS_FILE = os.path.join(DATA_DIR, "measurement_sessions.json")
os.makedirs(DATA_DIR, exist_ok=True)


def read_json_file(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as source:
            return json.load(source)
    except (OSError, ValueError, TypeError):
        return fallback


def write_json_file(path, payload):
    temporary_path = f"{path}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as target:
        json.dump(payload, target, ensure_ascii=False, indent=2)
    for attempt in range(5):
        try:
            os.replace(temporary_path, path)
            break
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.05 * (attempt + 1))


def theory_snapshot():
    payload = read_json_file(THEORY_FILE, {})
    payload.setdefault("project", {})
    payload.setdefault("devices", [])
    return payload


def measurement_sessions():
    sessions = read_json_file(SESSIONS_FILE, [])
    return sessions if isinstance(sessions, list) else []


def save_measurement_session(session):
    sessions = [item for item in measurement_sessions() if item.get("id") != session.get("id")]
    sessions.insert(0, session)
    write_json_file(SESSIONS_FILE, sessions[:100])


def saved_dashboards():
    return [
        session for session in measurement_sessions()
        if session.get("dashboard_saved")
    ]


def dashboard_source(session):
    source = str(session.get("dashboard_source") or session.get("acquisition_mode") or "").lower()
    return "can" if source == "can" or session.get("status") == "imported" else "digital"


def discard_unsaved_sessions():
    """Supprime les mesures temporaires tout en conservant l'historique explicite."""
    sessions = measurement_sessions()
    unsaved = [session for session in sessions if not session.get("dashboard_saved")]
    if not unsaved:
        return {"sessions": 0, "measurements": 0, "summaries": 0}

    init_db()
    conn = get_db_connection()
    deleted_measurements = 0
    deleted_summaries = 0
    for session in unsaved:
        source_files = [str(item) for item in (session.get("source_files") or []) if item]
        if source_files:
            placeholders = ",".join("?" for _ in source_files)
            cursor = conn.execute(
                f"DELETE FROM measurements WHERE source_file IN ({placeholders})",
                source_files,
            )
            deleted_measurements += max(0, cursor.rowcount)
            cursor = conn.execute(
                f"DELETE FROM measurements_summary_1m WHERE source_file IN ({placeholders})",
                source_files,
            )
            deleted_summaries += max(0, cursor.rowcount)
            continue

        start_ts = session.get("started_at")
        end_ts = session.get("ended_at")
        channels = [
            channel for channel in (session.get("channels") or ["A", "B"])
            if channel in ("A", "B")
        ]
        if start_ts is None or end_ts is None or not channels:
            continue
        placeholders = ",".join("?" for _ in channels)
        parameters = [float(start_ts), float(end_ts), *channels]
        cursor = conn.execute(
            f"""DELETE FROM measurements
                WHERE timestamp >= ? AND timestamp <= ?
                AND channel IN ({placeholders})""",
            parameters,
        )
        deleted_measurements += max(0, cursor.rowcount)
        cursor = conn.execute(
            f"""DELETE FROM measurements_summary_1m
                WHERE timestamp_minute >= ? AND timestamp_minute <= ?
                AND channel IN ({placeholders})""",
            parameters,
        )
        deleted_summaries += max(0, cursor.rowcount)
    conn.commit()
    conn.close()
    write_json_file(SESSIONS_FILE, saved_dashboards())
    return {
        "sessions": len(unsaved),
        "measurements": deleted_measurements,
        "summaries": deleted_summaries,
    }


def find_theory_device(device_id):
    return next((item for item in theory_snapshot().get("devices", []) if item.get("id") == device_id), None)


@app.route("/")
def index():
    history = saved_dashboards()
    return render_template(
        "home.html",
        theory=theory_snapshot(),
        dashboard_history=history,
        digital_dashboard_history=[
            item for item in history if dashboard_source(item) == "digital"
        ],
        can_dashboard_history=[
            item for item in history if dashboard_source(item) == "can"
        ],
    )


@app.route("/measurement")
def measurement():
    acquisition_mode = request.args.get("mode", "").strip().lower()
    if acquisition_mode not in {"can", "digital"}:
        return redirect(url_for("index"))
    return render_template(
        "measurement.html",
        theory=theory_snapshot(),
        acquisition_mode=acquisition_mode,
    )


@app.route("/logs")
def logs():
    return render_template("index.html", theory=theory_snapshot())


@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/save_dashboard", methods=["POST"])
def save_dashboard():
    payload = request.get_json(silent=True) or {}
    session_id = str(payload.get("session_id") or "").strip()
    sessions = measurement_sessions()
    session = next((item for item in sessions if item.get("id") == session_id), None)
    if not session:
        return jsonify({"status": "error", "message": "Session de mesure introuvable."}), 404
    default_name = (
        f"{(session.get('analysis') or {}).get('label') or 'Dashboard'} "
        f"— {datetime.now().strftime('%d/%m/%Y %H:%M')}"
    )
    name = " ".join(str(payload.get("name") or default_name).split()).strip()
    if not name:
        return jsonify({"status": "error", "message": "Donnez un nom au dashboard."}), 400
    if len(name) > 120:
        return jsonify({"status": "error", "message": "Le nom du dashboard est limité à 120 caractères."}), 400

    saved_at = datetime.now().isoformat(timespec="seconds")
    source = dashboard_source(session)
    session["dashboard_saved"] = True
    session["dashboard_name"] = name
    session["dashboard_saved_at"] = saved_at
    session["dashboard_source"] = source
    with measurement_lock:
        if active_measurement.get("id") == session_id:
            active_measurement["dashboard_saved"] = True
            active_measurement["dashboard_name"] = name
            active_measurement["dashboard_saved_at"] = saved_at
            active_measurement["dashboard_source"] = source
    save_measurement_session(session)
    return jsonify({
        "status": "success",
        "message": f"Dashboard « {name} » enregistré dans l’historique.",
        "dashboard": {
            "session_id": session_id,
            "name": name,
            "saved_at": saved_at,
            "source": source,
            "url": url_for("dashboard", session_id=session_id),
        },
    })


@app.route("/dashboard/open")
def dashboard_entry():
    acquisition_mode = request.args.get("mode", "").strip().lower()
    if acquisition_mode == "can":
        return redirect(url_for("dashboard_import"))
    if acquisition_mode != "digital":
        return redirect(url_for("index"))

    session = next(
        (
            item for item in measurement_sessions()
            if item.get("acquisition_mode") == "digital"
            and item.get("status") in {"completed", "stopped"}
        ),
        None,
    )
    if not session:
        return redirect(url_for("measurement", mode="digital", dashboard_missing="1"))
    return redirect(url_for("dashboard_setup", session_id=session["id"]))


@app.route("/dashboard/import")
def dashboard_import():
    return render_template("dashboard_import.html", theory=theory_snapshot())


@app.route("/dashboard/setup")
def dashboard_setup():
    session_id = request.args.get("session_id", "").strip()
    session = next(
        (item for item in measurement_sessions() if item.get("id") == session_id),
        {},
    )
    is_digital = session.get("acquisition_mode") == "digital"
    available_channels = [
        channel for channel in (session.get("channels") or ["A", "B"])
        if channel in ("A", "B")
    ]
    selected_channels = [
        channel for channel in ((session.get("analysis") or {}).get("dashboard_channels") or available_channels)
        if channel in available_channels
    ]
    return render_template(
        "dashboard_setup.html",
        theory=theory_snapshot(),
        available_channels=available_channels,
        selected_channels=selected_channels or available_channels,
        back_url=url_for("measurement", mode="digital") if is_digital else url_for("dashboard_import"),
        back_label="Retour à l’acquisition" if is_digital else "Retour aux logs CAN",
    )


@app.route("/import-theory", methods=["POST"])
def import_theory():
    raw_snapshot = request.form.get("theory_snapshot", "")
    try:
        snapshot = json.loads(raw_snapshot)
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("devices", []), list):
            raise ValueError("Format théorique invalide.")
        snapshot["received_at"] = datetime.now().isoformat(timespec="seconds")
        write_json_file(THEORY_FILE, snapshot)
    except (ValueError, TypeError, json.JSONDecodeError):
        pass
    return redirect(url_for("index"))


@app.route("/api/theory")
def get_theory():
    return jsonify(theory_snapshot())


@app.route("/api/measurement_sessions")
def get_measurement_sessions():
    return jsonify({"sessions": measurement_sessions()})


@app.route("/api/database_status")
def database_status():
    init_db()
    conn = get_db_connection()
    row = conn.execute("""
        SELECT COUNT(*) AS measurement_count,
               COUNT(DISTINCT source_file) AS file_count,
               MIN(timestamp) AS started_at,
               MAX(timestamp) AS ended_at,
               COUNT(DISTINCT channel) AS channel_count
        FROM measurements
    """).fetchone()
    sources = [
        item["source_file"]
        for item in conn.execute("""
            SELECT DISTINCT source_file
            FROM measurements
            WHERE source_file IS NOT NULL AND source_file != ''
            ORDER BY source_file
        """).fetchall()
    ]
    conn.close()
    sessions = measurement_sessions()
    latest_session = sessions[0] if sessions else None
    return jsonify({
        "measurement_count": int(row["measurement_count"] or 0),
        "file_count": int(row["file_count"] or 0),
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "duration_s": max(0, float(row["ended_at"] or 0) - float(row["started_at"] or 0)),
        "channel_count": int(row["channel_count"] or 0),
        "source_files": sources,
        "latest_session_id": latest_session.get("id") if latest_session else None,
        "dashboard_setup_url": (
            url_for("dashboard_setup", session_id=latest_session["id"])
            if latest_session and row["measurement_count"]
            else None
        ),
    })


ANALYSIS_TYPES = {
    "dcdc": "DCDC Sizing",
    "dm1": "Consommation de veille DM1",
    "dm2": "Consommation de veille DM2",
    "customer": "Customer Mode",
    "biberonnage": "Biberonnage",
    "wltc": "WLTC",
}


def temperature_capacity_factor(temperature_c):
    """Facteur de capacité utile, interpolé entre des points conservatifs."""
    curve = [(-30, 0.40), (-20, 0.50), (-10, 0.65), (0, 0.80), (10, 0.90), (20, 1.00), (50, 1.00)]
    value = max(curve[0][0], min(float(temperature_c), curve[-1][0]))
    for (low_t, low_factor), (high_t, high_factor) in zip(curve, curve[1:]):
        if low_t <= value <= high_t:
            ratio = (value - low_t) / (high_t - low_t)
            return low_factor + ratio * (high_factor - low_factor)
    return 1.0


def scenario_for_analysis(device, analysis_type, temperature_c):
    scenarios = device.get("scenarios") or {}
    if not scenarios:
        return []
    if analysis_type == "wltc":
        names = [name for name in scenarios if "WLTC" in name.upper()]
        return [
            interval
            for name in names
            for interval in scenarios.get(name, [])
        ]
    if analysis_type == "dcdc":
        temperature_c = float(temperature_c)
        token = "winter" if temperature_c < 5 else ("mid-season" if temperature_c <= 15 else "summer")
        name = next((name for name in scenarios if token in name.lower()), None)
        return scenarios.get(name, []) if name else scenarios.get(next(iter(scenarios)), [])
    return []


def analysis_interval_definitions(analysis_type):
    if analysis_type == "wltc":
        return [
            {"label": "0 - 1,67 min", "start_s": 0, "end_s": 100},
            {"label": "1,68 - 4 min", "start_s": 100.8, "end_s": 240},
            {"label": "4 - 7 min", "start_s": 240, "end_s": 420},
            {"label": "7 - 8,16 min", "start_s": 420, "end_s": 489.6},
            {"label": "12,25 - 25 min", "start_s": 735, "end_s": 1500},
            {"label": "25 - 30 min", "start_s": 1500, "end_s": 1800},
        ]
    if analysis_type == "dcdc":
        return [
            {"label": "0 - 5 min", "start_s": 0, "end_s": 300},
            {"label": "5 - 10 min", "start_s": 300, "end_s": 600},
            {"label": "10 - 15 min", "start_s": 600, "end_s": 900},
            {"label": "15 - 25 min", "start_s": 900, "end_s": 1500},
            {"label": "25 - 30 min", "start_s": 1500, "end_s": 1800},
        ]
    return []


def expected_current_for_interval(device, analysis_type, temperature_c, interval):
    profile = scenario_for_analysis(device, analysis_type, temperature_c)
    candidates = []
    for profile_interval in profile:
        start_s = float(profile_interval.get("start_s") or 0)
        end_s = float(profile_interval.get("end_s") or interval["end_s"])
        overlap = min(end_s, interval["end_s"]) - max(start_s, interval["start_s"])
        if overlap > 0:
            candidates.append(float(profile_interval.get("expected_A") or device.get("nominal_A") or 0))
    # Les trois variantes WLTC sont présentes dans le référentiel. La valeur
    # la plus haute par intervalle constitue la limite d'homologation prudente.
    return max(candidates, default=float(device.get("nominal_A") or 0))


def day_profile_points(device):
    points = []
    for raw_day, raw_value in (device.get("day_profiles") or {}).items():
        try:
            points.append((float(str(raw_day).replace(",", ".")), 1 if float(raw_value) >= 0.5 else 0))
        except (TypeError, ValueError):
            continue
    return sorted(points)


def day_profile_value(device, day):
    points = day_profile_points(device)
    if not points:
        return 1
    selected = points[0][1]
    for point_day, value in points:
        if point_day > day + 1e-9:
            break
        selected = value
    return selected


def autonomy_profile_segments(devices, start_day, end_day):
    boundaries = {float(start_day), float(end_day)}
    for device in devices:
        boundaries.update(
            day for day, _ in day_profile_points(device)
            if start_day < day < end_day
        )
    ordered = sorted(boundaries)
    return [
        (ordered[index], ordered[index + 1])
        for index in range(len(ordered) - 1)
        if ordered[index + 1] > ordered[index]
    ]


@app.route("/api/configure_dashboard", methods=["POST"])
def configure_dashboard():
    payload = request.get_json(silent=True) or {}
    sessions = measurement_sessions()
    session_id = str(payload.get("session_id") or "").strip()
    session = next((item for item in sessions if item.get("id") == session_id), None)
    if not session:
        return jsonify({"status": "error", "message": "Session de mesure introuvable."}), 404
    analysis_type = str(payload.get("analysis_type") or "").strip().lower()
    if analysis_type not in ANALYSIS_TYPES:
        return jsonify({"status": "error", "message": "Type d'analyse invalide."}), 400
    is_autonomy = analysis_type in ("dm1", "dm2", "customer")
    uses_temperature = analysis_type in ("dcdc", "wltc")
    temperature_c = None
    start_day = None
    end_day = None
    if is_autonomy:
        maximum_day = 30 if analysis_type == "customer" else 90
        try:
            start_day = float(payload.get("start_day", 0))
            end_day = float(payload.get("end_day", maximum_day))
        except (TypeError, ValueError):
            return jsonify({"status": "error", "message": "Renseignez une plage de jours valide."}), 400
        if not 0 <= start_day < end_day <= maximum_day:
            return jsonify({
                "status": "error",
                "message": f"La plage doit être comprise entre 0 et {maximum_day} jours, avec une fin supérieure au départ.",
            }), 400
    elif uses_temperature:
        try:
            temperature_c = float(payload.get("temperature_c"))
        except (TypeError, ValueError):
            return jsonify({"status": "error", "message": "Renseignez une température valide."}), 400
        if not -50 <= temperature_c <= 80:
            return jsonify({"status": "error", "message": "La température doit être comprise entre -50 et 80 °C."}), 400

    snapshot = theory_snapshot()
    devices = snapshot.get("devices", [])
    requested_ids = {str(item) for item in payload.get("device_ids", [])}
    selected = [device for device in devices if str(device.get("id")) in requested_ids]
    if not selected:
        return jsonify({"status": "error", "message": "Sélectionnez au moins un ECU / Device."}), 400

    available_channels = [
        channel for channel in (session.get("channels") or ["A", "B"])
        if channel in ("A", "B")
    ]
    requested_dashboard_channels = payload.get("dashboard_channels")
    if requested_dashboard_channels is None:
        requested_dashboard_channels = available_channels
    dashboard_channels = [
        str(channel).upper()
        for channel in requested_dashboard_channels
        if str(channel).upper() in available_channels
    ]
    dashboard_channels = list(dict.fromkeys(dashboard_channels))
    if not dashboard_channels:
        return jsonify({
            "status": "error",
            "message": "Sélectionnez au moins un canal à afficher dans le dashboard.",
        }), 400

    biberonnage = None
    if analysis_type == "biberonnage":
        available_biberonnages = snapshot.get("biberonnage_analyses") or []
        requested_biberonnage_id = str(payload.get("biberonnage_id") or "").strip()
        selected_biberonnage = next(
            (
                item for item in available_biberonnages
                if str(item.get("id")) == requested_biberonnage_id
            ),
            None,
        )
        if selected_biberonnage is None:
            selected_biberonnage = {
                "id": requested_biberonnage_id or "measured",
                "name": "Biberonnage mesuré",
                "result": {},
            }
        result = selected_biberonnage.get("result") or {}

        def biberonnage_number(key, fallback):
            raw_value = result.get(key)
            if raw_value is None or raw_value == "":
                return float(fallback)
            try:
                return float(raw_value)
            except (TypeError, ValueError):
                return float(fallback)

        analysis_config = snapshot.get("analysis_config") or {}
        biberonnage = {
            "id": str(selected_biberonnage.get("id") or "measured"),
            "name": str(selected_biberonnage.get("name") or "Biberonnage mesuré"),
            "battery_capacity_Ah": biberonnage_number(
                "capacityAh", analysis_config.get("battery_capacity_Ah") or 60
            ),
            "starting_soc_percent": biberonnage_number(
                "startSoc", analysis_config.get("starting_soc_percent") or 90
            ),
            "demand_soc_percent": biberonnage_number("demandSoc", 76),
            "target_soc_percent": biberonnage_number("targetSoc", 90),
            "supply_voltage_V": 14.5,
        }

    session["analysis"] = {
        "type": analysis_type,
        "label": ANALYSIS_TYPES[analysis_type],
        "temperature_c": temperature_c,
        "start_day": start_day,
        "end_day": end_day,
        "device_ids": [device.get("id") for device in selected],
        "device_names": [device.get("name") for device in selected],
        "biberonnage": biberonnage,
        "dashboard_channels": dashboard_channels,
        "configured_at": datetime.now().isoformat(timespec="seconds"),
    }
    with measurement_lock:
        if active_measurement.get("id") == session_id:
            active_measurement["analysis"] = dict(session["analysis"])
    save_measurement_session(session)
    return jsonify({
        "status": "success",
        "dashboard_url": url_for("dashboard", session_id=session_id),
    })


@app.route("/api/create_analysis_session", methods=["POST"])
def create_analysis_session():
    payload = request.get_json(silent=True) or {}
    try:
        start_ts = float(payload.get("start_ts") or datetime.fromisoformat(payload["start"]).timestamp())
        end_ts = float(payload.get("end_ts") or datetime.fromisoformat(payload["end"]).timestamp())
        if end_ts <= start_ts:
            raise ValueError("La date de fin doit être postérieure à la date de début.")
        device = find_theory_device(str(payload.get("device_id", ""))) or {}
        channels = payload.get("channels") or ["A", "B"]
        channels = [channel for channel in channels if channel in ("A", "B")]
        init_db()
        conn = get_db_connection()
        placeholders = ",".join("?" for _ in (channels or ["A", "B"]))
        source_files = [
            row["source_file"]
            for row in conn.execute(
                f"""SELECT DISTINCT source_file FROM measurements
                    WHERE timestamp >= ? AND timestamp <= ?
                    AND channel IN ({placeholders})
                    AND source_file IS NOT NULL AND source_file != ''""",
                [start_ts, end_ts, *(channels or ["A", "B"])],
            ).fetchall()
        ]
        conn.close()
        session = {
            "id": uuid.uuid4().hex,
            "status": "analysis",
            "started_at": start_ts,
            "ended_at": end_ts,
            "requested_duration_s": end_ts - start_ts,
            "actual_duration_s": end_ts - start_ts,
            "frequency_hz": 0,
            "channels": channels or ["A", "B"],
            "source_files": source_files,
            "acquisition_mode": "can",
            "measurement_type": payload.get("measurement_type", device.get("kind", "dcdc")),
            "device_id": payload.get("device_id", ""),
            "device_name": device.get("name", payload.get("device_name", "")),
            "theory_device": device,
            "scenario": payload.get("scenario", ""),
            "tolerance_percent": max(0.1, min(float(payload.get("tolerance_percent", 10)), 100)),
            "project": theory_snapshot().get("project", {}),
        }
        save_measurement_session(session)
        return jsonify({"status": "success", "session": session, "dashboard_url": url_for("dashboard_setup", session_id=session["id"])})
    except (KeyError, TypeError, ValueError) as error:
        return jsonify({"status": "error", "message": str(error)}), 400

@app.route("/api/detect_peaks")
def detect_peaks():
    seuil_raw = request.args.get("seuil", "0.0").strip()
    seuil = float(seuil_raw) if seuil_raw else 0.0
    ts_start, ts_end = get_request_timestamps()
    channel = request.args.get("channel", "").strip().upper()

    conn = get_db_connection()
    conn.execute("PRAGMA journal_mode=WAL;")
    cursor = conn.cursor()

    where_clauses = ["current_A >= ?"]
    params = [seuil]

    if ts_start is not None:
        where_clauses.append("timestamp >= ?")
        params.append(ts_start)

    if ts_end is not None:
        where_clauses.append("timestamp <= ?")
        params.append(ts_end)

    if channel in ("A", "B"):
        where_clauses.append("channel = ?")
        params.append(channel)

    where_stmt = " AND ".join(where_clauses)

    query_A = f"SELECT timestamp, current_A, frequency_Hz, lost_count FROM measurements WHERE {where_stmt} AND channel = 'A' ORDER BY timestamp ASC"
    rows_A = cursor.execute(query_A, params).fetchall()

    query_B = f"SELECT timestamp, current_A, frequency_Hz, lost_count FROM measurements WHERE {where_stmt} AND channel = 'B' ORDER BY timestamp ASC"
    rows_B = cursor.execute(query_B, params).fetchall()

    conn.close()

    pts_A = [{"timestamp": r["timestamp"], "current": r["current_A"], "freq": r["frequency_Hz"], "lost": r["lost_count"]} for r in rows_A]
    pts_B = [{"timestamp": r["timestamp"], "current": r["current_A"], "freq": r["frequency_Hz"], "lost": r["lost_count"]} for r in rows_B]

    return jsonify({"mode": "instant", "truncated": False, "points_A": pts_A, "points_B": pts_B})

@app.route("/api/global_peaks_report")
def global_peaks_report():
    seuil_raw = request.args.get("seuil", "").strip()
    seuil = 0.0 if not seuil_raw or seuil_raw in ("undefined", "null") else float(seuil_raw)
    ts_start, ts_end = get_request_timestamps()
    channel = request.args.get("channel", "").strip().upper()

    conn = get_db_connection()
    conn.execute("PRAGMA journal_mode=WAL;")
    cursor = conn.cursor()

    where_clauses = []
    params = []
    if ts_start is not None:
        where_clauses.append("timestamp >= ?")
        params.append(ts_start)
    if ts_end is not None:
        where_clauses.append("timestamp <= ?")
        params.append(ts_end)
    if channel in ("A", "B"):
        where_clauses.append("channel = ?")
        params.append(channel)

    where_stmt = " AND ".join(where_clauses) if where_clauses else "1=1"
    query = f"SELECT timestamp, channel, current_A FROM measurements WHERE {where_stmt} ORDER BY channel, timestamp ASC"
    rows = cursor.execute(query, params).fetchall()
    conn.close() 

    if not rows:
        return jsonify([])

    rapport_points = []
    total_rows = len(rows)

    for i in range(total_rows):
        current_row = rows[i]
        if current_row["current_A"] < seuil:
            continue

        ts_actuel = current_row["timestamp"]
        canal_actuel = current_row["channel"]

        ts_suivant = None
        if i + 1 < total_rows and rows[i + 1]["channel"] == canal_actuel:
            ts_suivant = rows[i + 1]["timestamp"]

        duree_ms = (ts_suivant - ts_actuel) * 1000.0 if ts_suivant is not None else 1.0

        rapport_points.append({
            "capteur": canal_actuel,
            "debut": ts_actuel,
            "valeur_max": round(current_row["current_A"], 7),
            "duree_ms": round(duree_ms, 2)
        })

    rapport_points.sort(key=lambda x: x["debut"], reverse=False)
    return jsonify(rapport_points)

@app.route("/api/measurements_summary_1m")
def measurements_summary_1m():
    ts_start, ts_end = get_request_timestamps()
    channel = request.args.get("channel", "").strip().upper()

    conn = get_db_connection()
    conn.execute("PRAGMA journal_mode=WAL;")
    cursor = conn.cursor()

    where_clauses = []
    params = []
    if ts_start is not None:
        where_clauses.append("timestamp_minute >= ?")
        params.append(ts_start)
    if ts_end is not None:
        where_clauses.append("timestamp_minute <= ?")
        params.append(ts_end)
    if channel in ("A", "B"):
        where_clauses.append("channel = ?")
        params.append(channel)

    where_stmt = " AND ".join(where_clauses) if where_clauses else "1=1"
    query = f"SELECT timestamp_minute, channel, current_min, current_max, current_avg FROM measurements_summary_1m WHERE {where_stmt} ORDER BY timestamp_minute ASC"
    rows = cursor.execute(query, params).fetchall()
    conn.close()

    summary = [{
        "timestamp_minute": r["timestamp_minute"],
        "channel": r["channel"],
        "current_min": r["current_min"],
        "current_max": r["current_max"],
        "current_avg": r["current_avg"]
    } for r in rows]

    return jsonify({"summary": summary})

@app.route("/api/export_measurements_csv")
def export_measurements_csv():
    start_str = request.args.get("start", "").strip()
    end_str = request.args.get("end", "").strip()
    ts_start, ts_end = get_request_timestamps()
    channel = request.args.get("channel", "").strip().upper()
    unit = request.args.get("unit", "A").strip()

    unit_lower = unit.lower()
    current_factor = 1000.0 if unit_lower == "ma" else 1.0
    current_header = "courant_mA" if unit_lower == "ma" else "courant_A"

    conn = get_db_connection()
    conn.execute("PRAGMA journal_mode=WAL;")
    cursor = conn.cursor()

    where_clauses = []
    params = []
    if ts_start is not None:
        where_clauses.append("timestamp >= ?")
        params.append(ts_start)
    if ts_end is not None:
        where_clauses.append("timestamp <= ?")
        params.append(ts_end)
    if channel in ("A", "B"):
        where_clauses.append("channel = ?")
        params.append(channel)

    where_stmt = " AND ".join(where_clauses) if where_clauses else "1=1"
    query = f"SELECT timestamp, channel, current_A, frequency_Hz, lost_count FROM measurements WHERE {where_stmt} ORDER BY channel, timestamp ASC"

    start_label = start_str.replace(':', '').replace('T', '_') if start_str else 'all'
    end_label = end_str.replace(':', '').replace('T', '_') if end_str else 'end'
    filename = f"mesures_{start_label}_{end_label}.csv"

    def generate():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["date", "heure", "duree_ms", "channel", current_header, "hz", "lost"])
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)

        rows = cursor.execute(query, params)
        previous_row = None
        for row in rows:
            if previous_row is None:
                previous_row = row
                continue

            duration_ms = 0.0
            if row[1] == previous_row[1]:
                duration_ms = round((row[0] - previous_row[0]) * 1000.0, 3)

            timestamp = datetime.fromtimestamp(previous_row[0])
            date_str = timestamp.strftime("%Y-%m-%d")
            time_str = timestamp.strftime("%H:%M:%S.%f")[:-3]
            current_value = round(previous_row[2] * current_factor, 6)

            writer.writerow([date_str, time_str, duration_ms, previous_row[1], current_value, previous_row[3], previous_row[4]])
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)
            previous_row = row

        if previous_row is not None:
            timestamp = datetime.fromtimestamp(previous_row[0])
            date_str = timestamp.strftime("%Y-%m-%d")
            time_str = timestamp.strftime("%H:%M:%S.%f")[:-3]
            current_value = round(previous_row[2] * current_factor, 6)
            writer.writerow([date_str, time_str, 0.0, previous_row[1], current_value, previous_row[3], previous_row[4]])
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)

        conn.close()

    return Response(generate(), mimetype='text/csv', headers={"Content-Disposition": f"attachment; filename=\"{filename}\""})

@app.route("/api/upload_and_ingest_measures", methods=["POST"])
def upload_and_ingest_measures():
    if "files" not in request.files:
        return jsonify({"status": "error", "message": "Aucun fichier ASC détecté."}), 400

    uploaded_files = [
        item for item in request.files.getlist("files")
        if item.filename
    ]
    if not uploaded_files:
        return jsonify({"status": "error", "message": "Aucun fichier ASC sélectionné."}), 400
    invalid_filename = next((
        os.path.basename(item.filename.replace("\\", "/"))
        for item in uploaded_files
        if not item.filename.lower().endswith(".asc")
    ), None)
    if invalid_filename:
        return jsonify({
            "status": "error",
            "message": f"Le fichier « {invalid_filename} » n'est pas au format ASC.",
        }), 400

    session_id = uuid.uuid4().hex
    discard_unsaved_sessions()
    init_db()

    conn = get_db_connection()
    conn.execute("PRAGMA journal_mode=WAL;")
    cursor = conn.cursor()
    files_processed = []
    total_measurements = 0
    global_start = None
    global_end = None
    detected_channels = set()
    frequency_total = 0.0
    frequency_samples = 0
    imported_channel_metrics = {
        "A": {"started_at": None, "ended_at": None, "frequency_total": 0.0, "frequency_samples": 0},
        "B": {"started_at": None, "ended_at": None, "frequency_total": 0.0, "frequency_samples": 0},
    }

    for file_index, file_storage in enumerate(uploaded_files):
        filename = os.path.basename(file_storage.filename.replace("\\", "/"))
        source_key = f"can_{session_id}_{file_index}_{filename}"
        cursor.execute("DELETE FROM measurements WHERE source_file = ?", (source_key,))
        cursor.execute("DELETE FROM measurements_summary_1m WHERE source_file = ?", (source_key,))
        conn.commit()

        file_bytes = file_storage.read()
        lines = file_bytes.decode('utf-8', errors='ignore').splitlines()

        # Lecture d'en-tête par sécurité si la trame 0x105 est manquante.
        base_timestamp = time.time()
        for line in lines[:30]:
            if line.strip().startswith("date"):
                date_str = line.replace("date", "").strip()
                try:
                    dt = datetime.strptime(date_str, "%a %b %d %I:%M:%S %p %Y")
                    base_timestamp = dt.timestamp() + 7200.0 # Heure d'été France
                    break
                except Exception:
                    try:
                        dt = datetime.strptime(date_str, "%d/%m/%Y %H:%M:%S")
                        base_timestamp = dt.timestamp() + 7200.0
                        break
                    except Exception:
                        continue

        buffer = []
        file_measurements = 0
        file_start = None
        file_end = None
        file_channels = set()
        file_channel_metrics = {
            channel: {
                "started_at": None,
                "ended_at": None,
                "frequency_total": 0.0,
                "frequency_samples": 0,
                "measurements": 0,
            }
            for channel in ("A", "B")
        }
        for row in iter_asc_stream_rows(lines, source_key, base_timestamp):
            buffer.append(row)
            timestamp, channel, _, frequency_hz, _, _ = row
            file_measurements += 1
            file_start = timestamp if file_start is None else min(file_start, timestamp)
            file_end = timestamp if file_end is None else max(file_end, timestamp)
            file_channels.add(channel)
            detected_channels.add(channel)
            channel_metric = imported_channel_metrics[channel]
            file_channel_metric = file_channel_metrics[channel]
            file_channel_metric["measurements"] += 1
            file_channel_metric["started_at"] = (
                timestamp if file_channel_metric["started_at"] is None
                else min(file_channel_metric["started_at"], timestamp)
            )
            file_channel_metric["ended_at"] = (
                timestamp if file_channel_metric["ended_at"] is None
                else max(file_channel_metric["ended_at"], timestamp)
            )
            channel_metric["started_at"] = (
                timestamp if channel_metric["started_at"] is None
                else min(channel_metric["started_at"], timestamp)
            )
            channel_metric["ended_at"] = (
                timestamp if channel_metric["ended_at"] is None
                else max(channel_metric["ended_at"], timestamp)
            )
            if frequency_hz is not None and float(frequency_hz) > 0:
                frequency_total += float(frequency_hz)
                frequency_samples += 1
                channel_metric["frequency_total"] += float(frequency_hz)
                channel_metric["frequency_samples"] += 1
                file_channel_metric["frequency_total"] += float(frequency_hz)
                file_channel_metric["frequency_samples"] += 1
            if len(buffer) >= 20000:
                cursor.executemany('''
                    INSERT INTO measurements (timestamp, channel, current_A, frequency_Hz, lost_count, source_file) 
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', buffer)
                conn.commit()
                buffer = []

        if buffer:
            cursor.executemany('''
                INSERT INTO measurements (timestamp, channel, current_A, frequency_Hz, lost_count, source_file) 
                VALUES (?, ?, ?, ?, ?, ?)
            ''', buffer)
            conn.commit()

        if not file_measurements:
            continue

        cursor.execute("""
            INSERT OR REPLACE INTO measurements_summary_1m (timestamp_minute, channel, current_min, current_max, current_avg, source_file)
            SELECT (CAST(timestamp AS INTEGER) / 60) * 60, channel, MIN(current_A), MAX(current_A), AVG(current_A), ?
            FROM measurements WHERE source_file = ? GROUP BY 1, channel
        """, (source_key, source_key))
        conn.commit()

        total_measurements += file_measurements
        global_start = file_start if global_start is None else min(global_start, file_start)
        global_end = file_end if global_end is None else max(global_end, file_end)
        file_channel_settings = {}
        for channel in sorted(file_channels):
            metric = file_channel_metrics[channel]
            duration = max(0, float(metric["ended_at"]) - float(metric["started_at"]))
            frequency = (
                round(metric["frequency_total"] / metric["frequency_samples"])
                if metric["frequency_samples"] else 0
            )
            file_channel_settings[channel] = {
                "measurements": metric["measurements"],
                "actual_duration_s": duration,
                "actual_frequency_hz": frequency,
            }
        files_processed.append({
            "name": filename,
            "source_file": source_key,
            "measurements": file_measurements,
            "channels": sorted(file_channels),
            "started_at": file_start,
            "ended_at": file_end,
            "duration_s": max(0, float(file_end) - float(file_start)),
            "channel_settings": file_channel_settings,
        })

    conn.close()

    if total_measurements == 0:
        return jsonify({
            "status": "error",
            "message": (
                "Aucune mesure INA226 n'a été décodée. Vérifiez que le fichier ASC "
                "contient les trames CAN 0x100/0x102."
            ),
        }), 422

    actual_frequency_hz = round(frequency_total / frequency_samples) if frequency_samples else 0
    channel_settings = {}
    for channel in sorted(detected_channels):
        metric = imported_channel_metrics[channel]
        duration = max(0, float(metric["ended_at"]) - float(metric["started_at"]))
        frequency = (
            round(metric["frequency_total"] / metric["frequency_samples"])
            if metric["frequency_samples"] else 0
        )
        channel_settings[channel] = {
            "requested_duration_s": duration,
            "actual_duration_s": duration,
            "requested_frequency_hz": frequency,
            "actual_frequency_hz": frequency,
        }
    session = {
        "id": session_id,
        "status": "imported",
        "started_at": global_start,
        "ended_at": global_end,
        "requested_duration_s": max(0, float(global_end) - float(global_start)),
        "actual_duration_s": max(0, float(global_end) - float(global_start)),
        "frequency_hz": actual_frequency_hz,
        "actual_frequency_hz": actual_frequency_hz,
        "channel_settings": channel_settings,
        "channels": sorted(detected_channels),
        "source_files": [item["source_file"] for item in files_processed],
        "uploaded_filenames": [item["name"] for item in files_processed],
        "acquisition_mode": "can",
        "project": theory_snapshot().get("project", {}),
        "imported_at": datetime.now().isoformat(timespec="seconds"),
    }
    save_measurement_session(session)
    backup_to_sharepoint_local_mount()

    return jsonify({
        "status": "success",
        "message": f"{total_measurements} mesures CAN décodées.",
        "files_processed": files_processed,
        "files_count": len(files_processed),
        "measurements_count": total_measurements,
        "channels": sorted(detected_channels),
        "started_at": global_start,
        "ended_at": global_end,
        "duration_s": session["actual_duration_s"],
        "actual_frequency_hz": actual_frequency_hz,
        "channel_settings": channel_settings,
        "session": session,
        "dashboard_setup_url": url_for("dashboard_setup", session_id=session["id"]),
    })


@app.route("/api/purge_database", methods=["POST"])
def purge_database():
    try:
        if active_measurement.get("status") == "running":
            return jsonify({
                "status": "error",
                "message": "Arrêtez la mesure CAN en cours avant de réinitialiser la base.",
            }), 409
        init_db()
        conn = get_db_connection()
        cursor = conn.cursor()
        measurement_count = cursor.execute("SELECT COUNT(*) FROM measurements").fetchone()[0]
        summary_count = cursor.execute("SELECT COUNT(*) FROM measurements_summary_1m").fetchone()[0]
        cursor.execute("DELETE FROM measurements;")
        cursor.execute("DELETE FROM measurements_summary_1m;")
        conn.commit()
        conn.close()
        write_json_file(SESSIONS_FILE, [])
        active_measurement.clear()
        return jsonify({
            "status": "success",
            "message": "Base de données et sessions de mesure réinitialisées.",
            "deleted_measurements": measurement_count,
            "deleted_summaries": summary_count,
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    
@app.route("/api/live_progress")
def live_progress():
    conn = get_db_connection()
    status = conn.execute("SELECT * FROM live_status WHERE id = 1").fetchone()
    conn.close()
    
    if not status or not status['start_time']:
        return jsonify({"status": "idle", "message": "Aucun test en cours"})
        
    elapsed = time.time() - status['start_time']
    total = status['target_duration'] # en secondes
    
    # Calcul du pourcentage et conversion en heures/minutes
    progress_percent = min((elapsed / total) * 100, 100)
    
    elapsed_hours = str(timedelta(seconds=int(elapsed)))
    total_hours = str(timedelta(seconds=int(total)))
    
    return jsonify({
        "status": "running",
        "sensor": status['active_sensor'],
        "progress_str": f"{elapsed_hours} sur {total_hours}",
        "percent": progress_percent
    })

# L'ESP32-C3 rejoint le point d'accès du poste de mesure et publie ce nom mDNS.
# ESP32_BASE_URL permet de forcer son IP si mDNS n'est pas disponible sur le Pi.
ESP32_BASE_URL = os.environ.get("ESP32_BASE_URL", "http://esp32c3-mesure.local").rstrip("/")
ESP32_SIMULATOR = os.environ.get("ESP32_SIMULATOR", "").lower() in {"1", "true", "yes"}
simulator_lock = threading.RLock()
simulator_state = {
    "running": False,
    "duration": 0,
    "frequency": 0,
    "acquisition_mode": "digital",
    "started_at": 0.0,
    "sensors": {
        "A": {"running": False, "finished": False, "duration": 0, "frequency": 0},
        "B": {"running": False, "finished": False, "duration": 0, "frequency": 0},
    },
}
measurement_lock = threading.RLock()
active_measurement = {}


def simulated_esp32_status():
    """Retourne un état ESP32 de test avec la même structure que le firmware."""
    with simulator_lock:
        elapsed = min(int(time.time() - simulator_state["started_at"]), simulator_state["duration"])
        for sensor in simulator_state["sensors"].values():
            sensor_elapsed = min(elapsed, sensor["duration"])
            if sensor["running"] and elapsed >= sensor["duration"]:
                sensor["finished"] = True
                sensor["running"] = False
            sensor["elapsed"] = sensor_elapsed
        simulator_state["running"] = any(sensor["running"] for sensor in simulator_state["sensors"].values())

        sensors = {}
        for name, sensor in simulator_state["sensors"].items():
            sensors[name] = {
                **sensor,
                "samples": sensor["elapsed"] * sensor["frequency"] if sensor["running"] or sensor["finished"] else 0,
                "lost": 0,
                "frequency": sensor["frequency"] if sensor["running"] or sensor["finished"] else 0,
            }
        return {
            "running": simulator_state["running"],
            "duration": simulator_state["duration"],
            "elapsed": elapsed,
            "frequency": simulator_state["frequency"],
            "acquisition_mode": simulator_state["acquisition_mode"],
            "can": {
                "ready": True,
                "bitrate": 500000,
                "oscillator_mhz": 8,
                "tx_ok": sum(sensor.get("samples", 0) for sensor in sensors.values())
                if simulator_state["acquisition_mode"] == "can"
                else 0,
                "tx_errors": 0,
            },
            "sensors": sensors,
        }


def simulated_esp32_request(method, path, params):
    """Simule les routes du firmware pour les essais uniquement sur le PC."""
    params = params or {}
    if path == "/api/acquisition/status" and method == "GET":
        return simulated_esp32_status()

    with simulator_lock:
        if path == "/api/acquisition/start" and method == "POST":
            if simulator_state["running"]:
                raise RuntimeError("Une mesure est deja en cours.")
            simulator_state["duration"] = int(params["duration"])
            simulator_state["frequency"] = int(params["frequency"])
            simulator_state["acquisition_mode"] = str(params.get("mode") or "digital")
            simulator_state["started_at"] = time.time()
            simulator_state["running"] = True
            for name, sensor in simulator_state["sensors"].items():
                sensor["running"] = bool(int(params.get(f"active{name}", 0)))
                sensor["finished"] = False
                sensor["duration"] = int(params.get(f"duration{name}") or params["duration"])
                sensor["frequency"] = int(params.get(f"frequency{name}") or params["frequency"])
                sensor["elapsed"] = 0
        elif path == "/api/acquisition/stop" and method == "POST":
            sensor_name = params.get("sensor", "ALL")
            targets = simulator_state["sensors"] if sensor_name == "ALL" else {sensor_name: simulator_state["sensors"][sensor_name]}
            for sensor in targets.values():
                sensor["finished"] = sensor["running"]
                sensor["running"] = False
            simulator_state["running"] = any(sensor["running"] for sensor in simulator_state["sensors"].values())
        else:
            raise RuntimeError("Route de simulateur inconnue.")
    return simulated_esp32_status()


def configured_esp32_base_url():
    config = read_json_file(os.path.join(DATA_DIR, "esp32_connection.json"), {})
    value = str(config.get("base_url") or ESP32_BASE_URL).strip().rstrip("/")
    return value or ESP32_BASE_URL


wifi_connection_lock = threading.RLock()
wifi_last_verified = 0.0


def ensure_esp32_network():
    """Connecte automatiquement Windows au point d'accès autonome de l'ESP32."""
    global wifi_last_verified
    if ESP32_SIMULATOR:
        return
    base_url = configured_esp32_base_url()
    host = urlsplit(base_url).hostname
    if os.name != "nt" or host != "192.168.4.1":
        return

    with wifi_connection_lock:
        if time.monotonic() - wifi_last_verified < 15:
            return
        try:
            with socket.create_connection((host, 80), timeout=0.7):
                wifi_last_verified = time.monotonic()
                return
        except OSError:
            pass

        profile_path = os.path.join(DATA_DIR, "ESP32C3-Mesure.xml")
        profile_xml = """<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>ESP32C3-Mesure</name>
  <SSIDConfig><SSID><name>ESP32C3-Mesure</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType><connectionMode>auto</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>ina226mesure</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>"""
        with open(profile_path, "w", encoding="utf-8") as profile:
            profile.write(profile_xml)
        startup = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.run(
            ["netsh", "wlan", "add", "profile", f"filename={profile_path}", "user=current"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=startup,
            check=False,
        )
        connect = subprocess.run(
            ["netsh", "wlan", "connect", "name=ESP32C3-Mesure", "ssid=ESP32C3-Mesure"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=startup,
            check=False,
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                with socket.create_connection((host, 80), timeout=1):
                    wifi_last_verified = time.monotonic()
                    return
            except OSError:
                time.sleep(0.5)
        detail = (connect.stdout or connect.stderr or "").strip()
        raise RuntimeError(
            "Connexion automatique au réseau ESP32C3-Mesure impossible. "
            "Vérifiez que l'ESP32 est alimenté et que le Wi-Fi du PC est activé."
            + (f" Détail Windows : {detail}" if detail else "")
        )


def esp32_request(method, path, params=None):
    """Appelle l'API HTTP de l'ESP32 et retourne sa réponse JSON."""
    if ESP32_SIMULATOR:
        return simulated_esp32_request(method, path, params)

    ensure_esp32_network()
    query = urlencode(params or {})
    base_url = configured_esp32_base_url()
    url = f"{base_url}{path}"
    if query:
        url = f"{url}?{query}"

    request_to_esp = Request(url, method=method)
    timeout_seconds = 8 if method == "POST" and path == "/api/acquisition/start" else 4
    try:
        with urlopen(request_to_esp, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("message", body)
        except json.JSONDecodeError:
            detail = body
        raise RuntimeError(detail or f"L'ESP32 a répondu HTTP {error.code}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"ESP32 injoignable sur {base_url}: {error}") from error


@app.route("/api/esp_connection_config", methods=["GET", "POST"])
def esp_connection_config():
    """Adresse directe de l'ESP32, conservée dans les données locales de l'application."""
    config_path = os.path.join(DATA_DIR, "esp32_connection.json")
    if request.method == "POST":
        payload = request.get_json(silent=True) or request.form
        base_url = str(payload.get("base_url") or "").strip().rstrip("/")
        if not base_url.startswith(("http://", "https://")):
            return jsonify({"status": "error", "message": "L'adresse doit commencer par http:// ou https://."}), 400
        write_json_file(config_path, {"base_url": base_url})
    return jsonify({"status": "success", "base_url": configured_esp32_base_url()})


def duration_in_seconds(value, unit):
    multipliers = {"s": 1, "m": 60, "h": 3600, "j": 86400}
    if unit not in multipliers:
        raise ValueError("Unité de durée invalide.")
    duration = value * multipliers[unit]
    if not 1 <= duration <= 7 * 86400:
        raise ValueError("La durée doit être comprise entre 1 seconde et 7 jours.")
    return duration


def actual_frequency_from_status(status, fallback=0):
    """Moyenne des fréquences réellement mesurées par les INA226 actifs."""
    frequencies = [
        float(sensor.get("frequency") or 0)
        for sensor in (status.get("sensors") or {}).values()
        if sensor.get("running") or sensor.get("finished") or sensor.get("samples")
    ]
    frequencies = [frequency for frequency in frequencies if frequency > 0]
    if frequencies:
        return sum(frequencies) / len(frequencies)
    return float(status.get("frequency") or fallback or 0)


def channel_status_metrics(status, channel_settings):
    """Return requested and actual acquisition metrics for each INA226."""
    result = {}
    sensors = status.get("sensors") or {}
    for channel, settings in channel_settings.items():
        sensor = sensors.get(channel) or {}
        requested_duration = float(settings.get("requested_duration_s") or 0)
        requested_frequency = float(settings.get("requested_frequency_hz") or 0)
        result[channel] = {
            **settings,
            "running": bool(sensor.get("running")),
            "finished": bool(sensor.get("finished")),
            "actual_duration_s": float(
                sensor.get("elapsed")
                if sensor.get("elapsed") is not None
                else min(float(status.get("elapsed") or 0), requested_duration)
            ),
            "actual_frequency_hz": float(sensor.get("frequency") or requested_frequency),
        }
    return result


@app.route("/api/control_esp_acquisition", methods=["POST"])
def control_esp_acquisition():
    """Transmet directement les commandes de mesure du PC vers l'ESP32."""
    action = request.form.get("action", "start")

    try:
        if action == "stop":
            sensor = request.form.get("sensor", "all").upper()
            if sensor not in ("A", "B", "ALL"):
                raise ValueError("Capteur à arrêter invalide.")
            status = esp32_request("POST", "/api/acquisition/stop", {"sensor": sensor})
            with measurement_lock:
                if active_measurement:
                    active_measurement["actual_frequency_hz"] = actual_frequency_from_status(
                        status, active_measurement.get("actual_frequency_hz")
                    )
                    active_measurement["channel_settings"] = channel_status_metrics(
                        status, active_measurement.get("channel_settings") or {}
                    )
                    if not status.get("running"):
                        can_collector.stop()
                        active_measurement["status"] = "stopped"
                        active_measurement["ended_at"] = time.time()
                        active_measurement["actual_duration_s"] = max(
                            0, active_measurement["ended_at"] - active_measurement.get(
                                "started_at", active_measurement["ended_at"]
                            )
                        )
                    save_measurement_session(dict(active_measurement))
            return jsonify({
                "status": "success",
                "message": (
                    "Canal A arrêté ; le canal B continue."
                    if sensor == "A" and status.get("running")
                    else "Canal B arrêté ; le canal A continue."
                    if sensor == "B" and status.get("running")
                    else "Arrêt des canaux confirmé par l'ESP32."
                ),
                "acquisition": status,
                "session": dict(active_measurement),
            })

        acquisition_mode = str(request.form.get("acquisition_mode") or "").strip().lower()
        if acquisition_mode not in {"can", "digital"}:
            raise ValueError("Mode de mesure invalide. Choisissez CAN ou Numérique.")
        if acquisition_mode == "can":
            # Une acquisition CAN ne doit conserver aucun socket du collecteur
            # numérique d'une mesure précédente.
            can_collector.stop()

        channel_fields_present = (
            "channelSelection" in request.form
            or "activeA" in request.form
            or "activeB" in request.form
        )
        active_a = 1 if (request.form.get("activeA") or not channel_fields_present) else 0
        active_b = 1 if (request.form.get("activeB") or not channel_fields_present) else 0
        if not (active_a or active_b):
            raise ValueError("Sélectionnez au moins un capteur.")

        session_id = uuid.uuid4().hex
        channels = [name for name, active in (("A", active_a), ("B", active_b)) if active]
        channel_settings = {}
        for channel in channels:
            frequency = int(request.form.get(f"freq{channel}", request.form.get("freq", 1000)))
            if not 1 <= frequency <= 2000:
                raise ValueError(f"La fréquence du canal {channel} doit être comprise entre 1 et 2000 Hz.")
            duration = duration_in_seconds(
                int(request.form.get(f"dureeValeur{channel}", request.form.get("dureeValeur", 10))),
                request.form.get(f"dureeUnite{channel}", request.form.get("dureeUnite", "s")),
            )
            channel_settings[channel] = {
                "requested_frequency_hz": frequency,
                "requested_duration_s": duration,
            }
        if sum(item["requested_frequency_hz"] for item in channel_settings.values()) > 2000:
            raise ValueError("La somme des fréquences des canaux actifs ne doit pas dépasser 2000 Hz.")

        duration = max(item["requested_duration_s"] for item in channel_settings.values())
        frequency = max(item["requested_frequency_hz"] for item in channel_settings.values())
        if acquisition_mode == "digital" and not ESP32_SIMULATOR:
            ensure_esp32_network()
            can_collector.start(
                source_file=f"live_{session_id}",
                channels=channels,
                duration_s=duration,
                target_url=configured_esp32_base_url(),
            )
        measurement_epoch = int(time.time())
        try:
            status = esp32_request("POST", "/api/acquisition/start", {
                "frequency": frequency,
                "duration": duration,
                "frequencyA": channel_settings.get("A", {}).get("requested_frequency_hz", 0),
                "frequencyB": channel_settings.get("B", {}).get("requested_frequency_hz", 0),
                "durationA": channel_settings.get("A", {}).get("requested_duration_s", 0),
                "durationB": channel_settings.get("B", {}).get("requested_duration_s", 0),
                "activeA": active_a,
                "activeB": active_b,
                "timestamp": measurement_epoch,
                "mode": acquisition_mode,
            })
        except Exception:
            can_collector.stop()
            raise
        discard_unsaved_sessions()
        device_id = request.form.get("device_id", "").strip()
        device = find_theory_device(device_id) or {}
        started_at = float(measurement_epoch)
        with measurement_lock:
            active_measurement.clear()
            active_measurement.update({
                "id": session_id,
                "status": "running",
                "started_at": started_at,
                "ended_at": None,
                "requested_duration_s": duration,
                "actual_duration_s": 0,
                "frequency_hz": frequency,
                "actual_frequency_hz": actual_frequency_from_status(status, frequency),
                "channel_settings": channel_status_metrics(status, channel_settings),
                "channels": channels,
                "acquisition_mode": acquisition_mode,
                "source_files": [f"live_{session_id}"] if acquisition_mode == "digital" else [],
                "measurement_type": "unassigned",
                "device_id": device_id,
                "device_name": request.form.get("device_name", device.get("name", "")).strip(),
                "theory_device": device,
                "scenario": request.form.get("scenario", "").strip(),
                "tolerance_percent": max(0.1, min(float(request.form.get("tolerance_percent", 10)), 100)),
                "project": theory_snapshot().get("project", {}),
            })
            save_measurement_session(dict(active_measurement))
        return jsonify({
            "status": "success",
            "message": (
                "Mesure numérique démarrée : réception directe des valeurs ESP32-C3 par Wi-Fi, sans CAN."
                if acquisition_mode == "digital"
                else "Mesure CAN démarrée : les trames sont émises sur le bus CAN pour l’enregistrement dans CANalyzer."
            ),
            "acquisition": status,
            "session": dict(active_measurement),
            "collector": can_collector.state(),
            "next_url": (
                url_for("dashboard_setup", session_id=session_id)
                if acquisition_mode == "digital"
                else url_for("dashboard_import")
            ),
        })
    except (TypeError, ValueError, RuntimeError) as error:
        return jsonify({"status": "error", "message": str(error)}), 400

def reconcile_active_measurement(status):
    """Synchronise la session locale avec l'état réel de l'ESP32."""
    with measurement_lock:
        if active_measurement:
            active_measurement["actual_frequency_hz"] = actual_frequency_from_status(
                status, active_measurement.get("actual_frequency_hz")
            )
            active_measurement["channel_settings"] = channel_status_metrics(
                status, active_measurement.get("channel_settings") or {}
            )
        if active_measurement.get("status") == "running" and not status.get("running"):
            can_collector.stop()
            active_measurement["status"] = "completed"
            active_measurement["ended_at"] = time.time()
            active_measurement["actual_duration_s"] = status.get(
                "elapsed", active_measurement.get("requested_duration_s", 0)
            )
            save_measurement_session(dict(active_measurement))
        status["session"] = dict(active_measurement)
        status["collector"] = can_collector.state()
    return status


@app.route("/api/esp_target_config", methods=["GET"])
def esp_target_config():
    """Retourne l'état mesuré par l'ESP32, sans approximation côté navigateur."""
    try:
        return jsonify(reconcile_active_measurement(
            esp32_request("GET", "/api/acquisition/status")
        ))
    except RuntimeError as error:
        return jsonify({"status": "error", "message": str(error)}), 502


def selected_scenario(device, scenario_name):
    scenarios = device.get("scenarios") or {}
    if scenario_name in scenarios:
        return scenarios[scenario_name]
    if scenarios:
        return scenarios[next(iter(scenarios))]
    nominal = float(device.get("nominal_A") or 0)
    return [{"label": "Mesure complète", "start_s": 0, "end_s": None, "expected_A": nominal}]


def decimate_chart_points(points, value_key, max_points=4000):
    """Réduit l'affichage en conservant les minima, maxima et extrémités."""
    if len(points) <= max_points:
        return points
    bucket_count = max(1, (max_points - 2) // 2)
    bucket_size = max(1, (len(points) - 2 + bucket_count - 1) // bucket_count)
    reduced = [points[0]]
    for start in range(1, len(points) - 1, bucket_size):
        bucket = points[start:min(len(points) - 1, start + bucket_size)]
        if not bucket:
            continue
        minimum = min(bucket, key=lambda point: point[value_key])
        maximum = max(bucket, key=lambda point: point[value_key])
        reduced.extend(sorted(
            (minimum, maximum),
            key=lambda point: point["time_s"],
        ) if minimum is not maximum else [minimum])
    reduced.append(points[-1])
    return reduced


def dashboard_report(session):
    device = session.get("theory_device") or find_theory_device(session.get("device_id")) or {}
    start_ts = float(session.get("started_at") or 0)
    end_ts = float(session.get("ended_at") or time.time())
    tolerance = float(session.get("tolerance_percent") or 10)
    scenario = selected_scenario(device, session.get("scenario", ""))
    analysis = session.get("analysis") or {}
    acquired_channels = [
        channel for channel in (session.get("channels") or ["A", "B"])
        if channel in ("A", "B")
    ]
    channels = [
        channel for channel in (analysis.get("dashboard_channels") or acquired_channels)
        if channel in acquired_channels
    ] or acquired_channels

    init_db()
    conn = get_db_connection()
    channel_placeholders = ",".join("?" for _ in channels)
    source_files = [str(item) for item in (session.get("source_files") or []) if item]
    source_filter = ""
    parameters = [start_ts, end_ts, *channels]
    if source_files:
        source_placeholders = ",".join("?" for _ in source_files)
        source_filter = f" AND source_file IN ({source_placeholders})"
        parameters.extend(source_files)
    rows = conn.execute(
        f"""SELECT timestamp, channel, current_A, frequency_Hz, lost_count
            FROM measurements
            WHERE timestamp >= ? AND timestamp <= ? AND channel IN ({channel_placeholders})
            {source_filter}
            ORDER BY timestamp ASC""",
        parameters,
    ).fetchall()
    conn.close()

    channel_reports = []
    all_conformities = []
    for channel in channels:
        points = [row for row in rows if row["channel"] == channel]
        interval_reports = []
        for interval in scenario:
            interval_start = start_ts + float(interval.get("start_s") or 0)
            requested_end = interval.get("end_s")
            interval_end = end_ts if requested_end is None else min(end_ts, start_ts + float(requested_end))
            interval_points = [row for row in points if interval_start <= row["timestamp"] <= interval_end]
            expected = float(interval.get("expected_A") or device.get("nominal_A") or 0)
            margin = max(abs(expected) * tolerance / 100, 0.001)
            compliant = [row for row in interval_points if abs(float(row["current_A"]) - expected) <= margin]
            compliance = (len(compliant) / len(interval_points) * 100) if interval_points else 0
            average = (
                sum(float(row["current_A"]) for row in interval_points) / len(interval_points)
                if interval_points else None
            )
            interval_report = {
                "label": interval.get("label", "Intervalle"),
                "start_s": interval.get("start_s", 0),
                "end_s": interval.get("end_s"),
                "expected_A": expected,
                "average_A": average,
                "minimum_A": min((float(row["current_A"]) for row in interval_points), default=None),
                "maximum_A": max((float(row["current_A"]) for row in interval_points), default=None),
                "samples": len(interval_points),
                "compliance_percent": compliance,
                "status": "pass" if interval_points and compliance >= 95 else (
                    "warning" if interval_points and compliance >= 80 else ("fail" if interval_points else "no_data")
                ),
            }
            interval_reports.append(interval_report)
            if interval_points:
                all_conformities.append(compliance)
        channel_reports.append({
            "channel": channel,
            "samples": len(points),
            "lost": max((int(row["lost_count"] or 0) for row in points), default=0),
            "intervals": interval_reports,
        })

    duration_expected = float(session.get("requested_duration_s") or 0)
    if session.get("status") == "running":
        duration_actual = max(0, min(time.time() - start_ts, duration_expected))
    else:
        duration_actual = float(session.get("actual_duration_s") or max(0, end_ts - start_ts))
    duration_error = abs(duration_actual - duration_expected)
    duration_ok = duration_error <= max(1, duration_expected * 0.02)
    global_score = sum(all_conformities) / len(all_conformities) if all_conformities else 0
    analysis_type = analysis.get("type", "dcdc")
    is_autonomy = analysis_type in ("dm1", "dm2", "customer")
    temperature_c = float(analysis.get("temperature_c") if analysis.get("temperature_c") is not None else 20)
    snapshot = theory_snapshot()
    all_devices = snapshot.get("devices", [])
    selected_ids = {str(item) for item in analysis.get("device_ids", [])}
    selected_devices = [item for item in all_devices if str(item.get("id")) in selected_ids]
    if not selected_devices and device:
        selected_devices = [device]

    # Série brute : chaque échantillon acquis est transmis au graphe. Chart.js
    # applique uniquement une décimation d'affichage, sans moyenner les données.
    chart_series = []
    for channel in channels:
        channel_rows = [row for row in rows if row["channel"] == channel]
        channel_points = [
            {"time_s": max(0, float(row["timestamp"]) - start_ts), "current_A": float(row["current_A"])}
            for row in channel_rows
        ]
        energy_points = []
        energy_ah = 0.0
        for index, row in enumerate(channel_rows):
            if index:
                previous = channel_rows[index - 1]
                energy_ah += (
                    (float(previous["current_A"]) + float(row["current_A"])) / 2
                    * max(0, float(row["timestamp"]) - float(previous["timestamp"]))
                    / 3600
                )
            energy_points.append({
                "time_s": max(0, float(row["timestamp"]) - start_ts),
                "energy_Ah": energy_ah,
            })
        chart_series.append({
            "channel": channel,
            "points": decimate_chart_points(channel_points, "current_A"),
            "energy_points": (
                decimate_chart_points(energy_points, "energy_Ah")
                if analysis_type == "biberonnage" else []
            ),
            "raw_samples": len(channel_points),
        })

    channel_averages = []
    channel_peaks = []
    channel_metrics = []
    saved_channel_settings = session.get("channel_settings") or {}
    for channel in channels:
        channel_rows = [row for row in rows if row["channel"] == channel]
        values = [float(row["current_A"]) for row in channel_rows]
        timestamps = [float(row["timestamp"]) for row in channel_rows]
        measured_frequencies = [
            float(row["frequency_Hz"]) for row in channel_rows
            if float(row["frequency_Hz"] or 0) > 0
        ]
        settings = saved_channel_settings.get(channel) or {}
        requested_duration = float(settings.get("requested_duration_s") or duration_expected)
        requested_frequency = float(settings.get("requested_frequency_hz") or session.get("frequency_hz") or 0)
        if session.get("status") == "running":
            actual_duration = max(0, min(time.time() - start_ts, requested_duration))
        else:
            actual_duration = float(
                settings.get("actual_duration_s")
                if settings.get("actual_duration_s") is not None
                else (max(timestamps) - min(timestamps) if timestamps else 0)
            )
        actual_frequency = float(
            (sum(measured_frequencies) / len(measured_frequencies))
            if measured_frequencies
            else (settings.get("actual_frequency_hz") or requested_frequency)
        )
        common_metrics = {
            "channel": channel,
            "address": "0x40" if channel == "A" else "0x41",
            "running": bool(settings.get("running", session.get("status") == "running")),
            "finished": bool(settings.get("finished", session.get("status") != "running")),
            "requested_duration_s": requested_duration,
            "actual_duration_s": actual_duration,
            "requested_frequency_hz": requested_frequency,
            "actual_frequency_hz": actual_frequency,
        }
        if values:
            average = sum(values) / len(values)
            peak = max(values)
            channel_averages.append(average)
            channel_peaks.append(peak)
            channel_metrics.append({
                **common_metrics,
                "samples": len(values),
                "average_current_A": average,
                "minimum_current_A": min(values),
                "peak_current_A": peak,
            })
        else:
            channel_metrics.append({
                **common_metrics,
                "samples": 0,
                "average_current_A": None,
                "minimum_current_A": None,
                "peak_current_A": None,
            })
    measured_average = sum(channel_averages) if channel_averages else None
    measured_peak = sum(channel_peaks) if channel_peaks else None

    device_summaries = []
    theoretical_peak = 0.0
    profile_duration = 0.0
    for selected_device in selected_devices:
        profile = scenario_for_analysis(selected_device, analysis_type, temperature_c)
        expected_values = [
            float(interval.get("expected_A") or selected_device.get("nominal_A") or 0)
            for interval in profile
        ]
        peak = max(expected_values, default=float(selected_device.get("nominal_A") or 0))
        duration = max(
            (float(interval.get("end_s") or duration_expected) for interval in profile),
            default=duration_expected,
        )
        theoretical_peak += peak
        profile_duration = max(profile_duration, duration)
        device_summaries.append({
            "id": selected_device.get("id"),
            "name": selected_device.get("name"),
            "nominal_A": float(selected_device.get("nominal_A") or 0),
            "profile_peak_A": peak,
            "profile_duration_s": duration,
            "intervals": [],
        })

    comparison_intervals = []
    if analysis_type in ("dcdc", "wltc"):
        summaries_by_id = {str(item["id"]): item for item in device_summaries}
        for definition in analysis_interval_definitions(analysis_type):
            channel_values = {}
            for channel in channels:
                values = [
                    float(row["current_A"])
                    for row in rows
                    if row["channel"] == channel
                    and definition["start_s"] <= float(row["timestamp"]) - start_ts < definition["end_s"]
                ]
                if values:
                    channel_values[channel] = values
            measured_interval_average = (
                sum(sum(values) / len(values) for values in channel_values.values())
                if channel_values else None
            )
            measured_interval_minimum = (
                sum(min(values) for values in channel_values.values())
                if channel_values else None
            )
            measured_interval_maximum = (
                sum(max(values) for values in channel_values.values())
                if channel_values else None
            )
            measured_average_by_channel = {
                channel: (
                    sum(channel_values[channel]) / len(channel_values[channel])
                    if channel in channel_values else None
                )
                for channel in ("A", "B")
            }
            measured_minimum_by_channel = {
                channel: (min(channel_values[channel]) if channel in channel_values else None)
                for channel in ("A", "B")
            }
            measured_maximum_by_channel = {
                channel: (max(channel_values[channel]) if channel in channel_values else None)
                for channel in ("A", "B")
            }
            samples_by_channel = {
                channel: len(channel_values.get(channel, []))
                for channel in ("A", "B")
            }
            expected_by_device = [
                {
                    "id": str(selected_device.get("id")),
                    "expected_A": expected_current_for_interval(
                        selected_device, analysis_type, temperature_c, definition
                    ),
                }
                for selected_device in selected_devices
            ]
            total_expected = sum(item["expected_A"] for item in expected_by_device)
            device_comparisons = []
            for item in expected_by_device:
                allocated = (
                    measured_interval_average * item["expected_A"] / total_expected
                    if measured_interval_average is not None and total_expected > 0
                    else (0.0 if measured_interval_average == 0 else None)
                )
                allocated_by_channel = {
                    channel: (
                        measured_average_by_channel[channel] * item["expected_A"] / total_expected
                        if measured_average_by_channel[channel] is not None and total_expected > 0
                        else (0.0 if measured_average_by_channel[channel] == 0 else None)
                    )
                    for channel in ("A", "B")
                }
                status_by_channel = {
                    channel: (
                        "pass"
                        if allocated_by_channel[channel] is not None
                        and allocated_by_channel[channel] <= item["expected_A"]
                        else ("fail" if allocated_by_channel[channel] is not None else "no_data")
                    )
                    for channel in ("A", "B")
                }
                status = (
                    "pass" if allocated is not None and allocated <= item["expected_A"]
                    else ("fail" if allocated is not None else "no_data")
                )
                device_interval = {
                    "label": definition["label"],
                    "start_s": definition["start_s"],
                    "end_s": definition["end_s"],
                    "expected_A": item["expected_A"],
                    "measured_allocated_A": allocated,
                    "measured_allocated_channel_A": allocated_by_channel["A"],
                    "measured_allocated_channel_B": allocated_by_channel["B"],
                    "status_channel_A": status_by_channel["A"],
                    "status_channel_B": status_by_channel["B"],
                    "status": status,
                }
                device_comparisons.append({"id": item["id"], **device_interval})
                if item["id"] in summaries_by_id:
                    summaries_by_id[item["id"]]["intervals"].append(device_interval)

            interval_status = (
                "pass"
                if measured_interval_average is not None and measured_interval_average <= total_expected
                else ("fail" if measured_interval_average is not None else "no_data")
            )
            comparison_intervals.append({
                **definition,
                "theoretical_A": total_expected,
                "measured_average_A": measured_interval_average,
                "measured_average_channel_A": measured_average_by_channel["A"],
                "measured_average_channel_B": measured_average_by_channel["B"],
                "measured_minimum_channel_A": measured_minimum_by_channel["A"],
                "measured_minimum_channel_B": measured_minimum_by_channel["B"],
                "measured_maximum_channel_A": measured_maximum_by_channel["A"],
                "measured_maximum_channel_B": measured_maximum_by_channel["B"],
                "samples_channel_A": samples_by_channel["A"],
                "samples_channel_B": samples_by_channel["B"],
                "status_channel_A": (
                    "pass"
                    if measured_average_by_channel["A"] is not None
                    and measured_average_by_channel["A"] <= total_expected
                    else ("fail" if measured_average_by_channel["A"] is not None else "no_data")
                ),
                "status_channel_B": (
                    "pass"
                    if measured_average_by_channel["B"] is not None
                    and measured_average_by_channel["B"] <= total_expected
                    else ("fail" if measured_average_by_channel["B"] is not None else "no_data")
                ),
                "measured_minimum_A": measured_interval_minimum,
                "measured_maximum_A": measured_interval_maximum,
                "samples": sum(len(values) for values in channel_values.values()),
                "status": interval_status,
                "devices": device_comparisons,
            })

    if analysis_type == "biberonnage":
        summaries_by_id = {str(item["id"]): item for item in device_summaries}
        expected_by_device = [
            {
                "id": str(selected_device.get("id")),
                "expected_A": float(selected_device.get("nominal_A") or 0),
            }
            for selected_device in selected_devices
        ]
        total_expected = sum(item["expected_A"] for item in expected_by_device)
        if duration_actual <= 120:
            base_period_s, unit_divisor, unit_label = 10.0, 1.0, "s"
        elif duration_actual <= 7200:
            base_period_s, unit_divisor, unit_label = 60.0, 60.0, "min"
        elif duration_actual <= 172800:
            base_period_s, unit_divisor, unit_label = 3600.0, 3600.0, "h"
        else:
            base_period_s, unit_divisor, unit_label = 86400.0, 86400.0, "jour"
        estimated_periods = max(1, int((duration_actual + base_period_s - 1) // base_period_s))
        period_multiplier = max(1, int((estimated_periods + 119) // 120))
        period_s = base_period_s * period_multiplier

        def feeding_period_label(period_start, period_end):
            def period_value(value):
                return f"{value:.2f}".rstrip("0").rstrip(".").replace(".", ",")

            start_value = period_value(period_start / unit_divisor)
            end_value = period_value(period_end / unit_divisor)
            if unit_label == "jour":
                return f"Jour {start_value} à {end_value}"
            return f"{start_value} à {end_value} {unit_label}"

        period_start = 0.0
        while period_start < max(duration_actual, 0.001):
            period_end = min(max(duration_actual, 0.001), period_start + period_s)
            is_last_period = period_end >= max(duration_actual, 0.001)
            period_rows_by_channel = {
                channel: [
                    row for row in rows
                    if row["channel"] == channel
                    and period_start <= max(0.0, float(row["timestamp"]) - start_ts)
                    and (
                        max(0.0, float(row["timestamp"]) - start_ts) < period_end
                        or (
                            is_last_period
                            and max(0.0, float(row["timestamp"]) - start_ts) <= period_end
                        )
                    )
                ]
                for channel in ("A", "B")
            }
            measured_by_channel = {
                channel: (
                    sum(abs(float(row["current_A"])) for row in period_rows_by_channel[channel])
                    / len(period_rows_by_channel[channel])
                    if period_rows_by_channel[channel] else None
                )
                for channel in ("A", "B")
            }
            measured_total = (
                sum(value for value in measured_by_channel.values() if value is not None)
                if any(value is not None for value in measured_by_channel.values())
                else None
            )
            label = feeding_period_label(period_start, period_end)
            device_comparisons = []
            for item in expected_by_device:
                allocated_by_channel = {
                    channel: (
                        measured_by_channel[channel] * item["expected_A"] / total_expected
                        if measured_by_channel[channel] is not None and total_expected > 0
                        else None
                    )
                    for channel in ("A", "B")
                }
                allocated = (
                    sum(value for value in allocated_by_channel.values() if value is not None)
                    if any(value is not None for value in allocated_by_channel.values())
                    else None
                )
                status_by_channel = {
                    channel: (
                        "pass" if allocated_by_channel[channel] is not None
                        and allocated_by_channel[channel] <= item["expected_A"]
                        else ("fail" if allocated_by_channel[channel] is not None else "no_data")
                    )
                    for channel in ("A", "B")
                }
                device_interval = {
                    "label": label,
                    "start_s": period_start,
                    "end_s": period_end,
                    "expected_A": item["expected_A"],
                    "measured_allocated_A": allocated,
                    "measured_allocated_channel_A": allocated_by_channel["A"],
                    "measured_allocated_channel_B": allocated_by_channel["B"],
                    "status_channel_A": status_by_channel["A"],
                    "status_channel_B": status_by_channel["B"],
                    "status": (
                        "pass" if allocated is not None and allocated <= item["expected_A"]
                        else ("fail" if allocated is not None else "no_data")
                    ),
                }
                device_comparisons.append({"id": item["id"], **device_interval})
                if item["id"] in summaries_by_id:
                    summaries_by_id[item["id"]]["intervals"].append(device_interval)

            status_by_channel = {
                channel: (
                    "pass" if measured_by_channel[channel] is not None
                    and measured_by_channel[channel] <= total_expected
                    else ("fail" if measured_by_channel[channel] is not None else "no_data")
                )
                for channel in ("A", "B")
            }
            comparison_intervals.append({
                "label": label,
                "start_s": period_start,
                "end_s": period_end,
                "theoretical_A": total_expected,
                "measured_average_A": measured_total,
                "measured_average_channel_A": measured_by_channel["A"],
                "measured_average_channel_B": measured_by_channel["B"],
                "samples_channel_A": len(period_rows_by_channel["A"]),
                "samples_channel_B": len(period_rows_by_channel["B"]),
                "status_channel_A": status_by_channel["A"],
                "status_channel_B": status_by_channel["B"],
                "samples": sum(len(values) for values in period_rows_by_channel.values()),
                "status": (
                    "pass" if measured_total is not None and measured_total <= total_expected
                    else ("fail" if measured_total is not None else "no_data")
                ),
                "devices": device_comparisons,
            })
            period_start = period_end

    config = snapshot.get("analysis_config") or {}
    dcdc_output = float(config.get("dcdc_output_current_A") or 250)
    battery_capacity = float(config.get("battery_capacity_Ah") or 60)
    starting_soc = float(config.get("starting_soc_percent") or 90)
    minimum_soc = float(config.get("minimum_soc_percent") or 70)
    capacity_factor = 1.0 if is_autonomy else temperature_capacity_factor(temperature_c)
    usable_capacity = battery_capacity * max(0, starting_soc - minimum_soc) / 100 * capacity_factor
    daily_consumption = measured_average * 24 if measured_average is not None else None
    autonomy_days = (
        usable_capacity / daily_consumption
        if daily_consumption is not None and daily_consumption > 0 else None
    )
    theoretical_daily_consumption = None
    theoretical_autonomy_days = None
    autonomy_difference_days = None
    autonomy_excess_daily = 0.0
    autonomy_excess_range = 0.0
    autonomy_excess_days = 0.0
    autonomy_status = "no_data"
    autonomy_profile = []
    start_day = analysis.get("start_day")
    end_day = analysis.get("end_day")
    if is_autonomy:
        maximum_day = 30 if analysis_type == "customer" else 90
        start_day = float(0 if start_day is None else start_day)
        end_day = float(maximum_day if end_day is None else end_day)
        selected_days = max(0, end_day - start_day)
        nominal_total = sum(float(item.get("nominal_A") or 0) for item in selected_devices)
        channel_base_current = {
            metric["channel"]: (
                abs(float(metric["average_current_A"]))
                if metric.get("average_current_A") is not None else None
            )
            for metric in channel_metrics
        }
        summaries_by_id = {str(item["id"]): item for item in device_summaries}
        theoretical_energy_range = 0.0
        measured_energy_range = 0.0

        def day_label(value):
            return f"{float(value):g}".replace(".", ",")

        for segment_start, segment_end in autonomy_profile_segments(selected_devices, start_day, end_day):
            segment_days = segment_end - segment_start
            expected_by_device = []
            for selected_device in selected_devices:
                profile_value = day_profile_value(selected_device, segment_start)
                expected_by_device.append({
                    "id": str(selected_device.get("id")),
                    "profile": profile_value,
                    "nominal_A": float(selected_device.get("nominal_A") or 0),
                    "expected_A": float(selected_device.get("nominal_A") or 0) * profile_value,
                })
            theoretical_current = sum(item["expected_A"] for item in expected_by_device)
            activity_ratio = theoretical_current / nominal_total if nominal_total > 0 else 0.0
            projected_by_channel = {
                channel: (
                    channel_base_current[channel] * activity_ratio
                    if channel_base_current.get(channel) is not None else None
                )
                for channel in ("A", "B")
            }
            segment_rows_by_channel = {
                channel: [
                    row for row in rows
                    if row["channel"] == channel
                    and segment_start
                    <= start_day + max(0, float(row["timestamp"]) - start_ts) / 86400
                    < segment_end
                ]
                for channel in ("A", "B")
            }
            samples_by_channel = {
                channel: len(segment_rows_by_channel[channel])
                for channel in ("A", "B")
            }
            measured_by_channel = {
                channel: (
                    projected_by_channel[channel]
                    if samples_by_channel[channel] > 0 else None
                )
                for channel in ("A", "B")
            }
            measured_segment_current = (
                sum(value for value in measured_by_channel.values() if value is not None)
                if any(value is not None for value in measured_by_channel.values())
                else None
            )
            theoretical_daily_ah = theoretical_current * 24
            measured_daily_ah = (
                measured_segment_current * 24
                if measured_segment_current is not None else None
            )
            projected_daily_ah = (
                sum(
                    value for value in projected_by_channel.values()
                    if value is not None
                ) * 24
                if any(value is not None for value in projected_by_channel.values())
                else None
            )
            theoretical_energy_range += theoretical_daily_ah * segment_days
            if projected_daily_ah is not None:
                measured_energy_range += projected_daily_ah * segment_days
            label = f"Jour {day_label(segment_start)} à {day_label(segment_end)}"
            device_comparisons = []
            for item in expected_by_device:
                allocated_by_channel = {
                    channel: (
                        channel_base_current[channel] * item["nominal_A"] / nominal_total * item["profile"]
                        if channel_base_current.get(channel) is not None
                        and nominal_total > 0
                        and samples_by_channel[channel] > 0
                        else None
                    )
                    for channel in ("A", "B")
                }
                allocated = (
                    sum(value for value in allocated_by_channel.values() if value is not None)
                    if any(value is not None for value in allocated_by_channel.values())
                    else None
                )
                status_by_channel = {
                    channel: (
                        "pass" if allocated_by_channel[channel] is not None
                        and allocated_by_channel[channel] <= item["expected_A"]
                        else ("fail" if allocated_by_channel[channel] is not None else "no_data")
                    )
                    for channel in ("A", "B")
                }
                device_interval = {
                    "label": label,
                    "start_day": segment_start,
                    "end_day": segment_end,
                    "profile": item["profile"],
                    "expected_A": item["expected_A"],
                    "measured_allocated_A": allocated,
                    "measured_allocated_channel_A": allocated_by_channel["A"],
                    "measured_allocated_channel_B": allocated_by_channel["B"],
                    "status_channel_A": status_by_channel["A"],
                    "status_channel_B": status_by_channel["B"],
                    "status": (
                        "pass" if allocated is not None and allocated <= item["expected_A"]
                        else ("fail" if allocated is not None else "no_data")
                    ),
                }
                device_comparisons.append({"id": item["id"], **device_interval})
                if item["id"] in summaries_by_id:
                    summaries_by_id[item["id"]]["intervals"].append(device_interval)

            status_by_channel = {
                channel: (
                    "pass" if measured_by_channel[channel] is not None
                    and measured_by_channel[channel] <= theoretical_current
                    else ("fail" if measured_by_channel[channel] is not None else "no_data")
                )
                for channel in ("A", "B")
            }
            interval_status = (
                "pass" if measured_segment_current is not None
                and measured_segment_current <= theoretical_current
                else ("fail" if measured_segment_current is not None else "no_data")
            )
            comparison_intervals.append({
                "label": label,
                "start_day": segment_start,
                "end_day": segment_end,
                "duration_days": segment_days,
                "theoretical_A": theoretical_current,
                "theoretical_daily_Ah": theoretical_daily_ah,
                "measured_average_A": measured_segment_current,
                "measured_average_channel_A": measured_by_channel["A"],
                "measured_average_channel_B": measured_by_channel["B"],
                "measured_daily_channel_A_Ah": (
                    measured_by_channel["A"] * 24 if measured_by_channel["A"] is not None else None
                ),
                "measured_daily_channel_B_Ah": (
                    measured_by_channel["B"] * 24 if measured_by_channel["B"] is not None else None
                ),
                "samples_channel_A": samples_by_channel["A"],
                "samples_channel_B": samples_by_channel["B"],
                "status_channel_A": status_by_channel["A"],
                "status_channel_B": status_by_channel["B"],
                "samples": sum(samples_by_channel.values()),
                "status": interval_status,
                "devices": device_comparisons,
            })
            autonomy_profile.append({
                "label": label,
                "start_day": segment_start,
                "end_day": segment_end,
                "theoretical_daily_Ah": theoretical_daily_ah,
                "measured_daily_Ah": measured_daily_ah,
                "measured_daily_channel_A_Ah": (
                    measured_by_channel["A"] * 24 if measured_by_channel["A"] is not None else None
                ),
                "measured_daily_channel_B_Ah": (
                    measured_by_channel["B"] * 24 if measured_by_channel["B"] is not None else None
                ),
            })

        theoretical_daily_consumption = (
            theoretical_energy_range / selected_days if selected_days > 0 else None
        )
        daily_consumption = measured_energy_range / selected_days if selected_days > 0 else None
        theoretical_autonomy_days = (
            usable_capacity / theoretical_daily_consumption
            if theoretical_daily_consumption and theoretical_daily_consumption > 0 else None
        )
        autonomy_days = (
            usable_capacity / daily_consumption
            if daily_consumption and daily_consumption > 0 else None
        )
        autonomy_difference_days = (
            autonomy_days - theoretical_autonomy_days
            if autonomy_days is not None and theoretical_autonomy_days is not None else None
        )
        autonomy_excess_daily = max(
            0.0, (daily_consumption or 0.0) - (theoretical_daily_consumption or 0.0)
        )
        autonomy_excess_range = max(0.0, measured_energy_range - theoretical_energy_range)
        autonomy_excess_days = max(
            0.0,
            (theoretical_autonomy_days or 0.0) - (autonomy_days or 0.0),
        )
        if autonomy_days is not None and theoretical_autonomy_days is not None:
            autonomy_status = "better" if autonomy_days >= theoretical_autonomy_days else "worse"
    integrated_energy_by_channel = {
        item["channel"]: float((item.get("energy_points") or [{}])[-1].get("energy_Ah") or 0)
        for item in chart_series
        if item.get("energy_points")
    }
    measured_energy = (
        sum(integrated_energy_by_channel.values())
        if integrated_energy_by_channel
        else (
            measured_average * duration_actual / 3600
            if measured_average is not None else None
        )
    )
    feeding = None
    if analysis_type == "biberonnage":
        feeding_config = analysis.get("biberonnage") or {}
        configured_start_soc = feeding_config.get("starting_soc_percent")
        configured_demand_soc = feeding_config.get("demand_soc_percent")
        configured_target_soc = feeding_config.get("target_soc_percent")
        feeding_capacity = max(
            0.01,
            float(feeding_config.get("battery_capacity_Ah") or battery_capacity),
        )
        feeding_start_soc = max(
            0.0,
            min(
                100.0,
                float(
                    starting_soc
                    if configured_start_soc is None else configured_start_soc
                ),
            ),
        )
        feeding_voltage = max(
            0.01,
            float(feeding_config.get("supply_voltage_V") or 14.5),
        )
        energy_rows = []
        for channel in channels:
            signed_ah = float(integrated_energy_by_channel.get(channel, 0))
            transferred_ah = abs(signed_ah)
            energy_rows.append({
                "channel": channel,
                "address": "0x40" if channel == "A" else "0x41",
                "signed_Ah": signed_ah,
                "transferred_Ah": transferred_ah,
                "energy_Wh": transferred_ah * feeding_voltage,
            })
        total_transferred_ah = sum(item["transferred_Ah"] for item in energy_rows)
        total_cost_wh = sum(item["energy_Wh"] for item in energy_rows)
        for item in energy_rows:
            item["share_percent"] = (
                item["energy_Wh"] / total_cost_wh * 100
                if total_cost_wh > 0 else 0
            )

        energy_series = {
            item["channel"]: item.get("energy_points") or []
            for item in chart_series
        }
        for item in energy_rows:
            channel_points = energy_series.get(item["channel"]) or []
            channel_duration = max(
                (float(point["time_s"]) for point in channel_points),
                default=0.0,
            )
            theoretical_channel_ah = (
                max(0.0, total_expected) * channel_duration / 3600
            )
            theoretical_channel_wh = theoretical_channel_ah * feeding_voltage
            measured_channel_wh = item["energy_Wh"]
            battery_need_wh = theoretical_channel_wh
            energy_lost_wh = max(0.0, measured_channel_wh - theoretical_channel_wh)
            pie_total_wh = battery_need_wh + energy_lost_wh
            channel_soc_points = [{
                "time_s": 0.0,
                "soc_percent": feeding_start_soc,
            }]
            channel_theoretical_soc_points = [{
                "time_s": 0.0,
                "soc_percent": feeding_start_soc,
            }]
            for point in channel_points:
                timestamp = float(point["time_s"])
                channel_soc_points.append({
                    "time_s": timestamp,
                    "soc_percent": max(
                        0.0,
                        min(
                            100.0,
                            feeding_start_soc
                            - float(point["energy_Ah"]) / feeding_capacity * 100,
                        ),
                    ),
                })
                channel_theoretical_soc_points.append({
                    "time_s": timestamp,
                    "soc_percent": max(
                        0.0,
                        min(
                            100.0,
                            feeding_start_soc
                            - max(0.0, total_expected) * timestamp / 3600
                            / feeding_capacity * 100,
                        ),
                    ),
                })
            item.update({
                "duration_s": channel_duration,
                "theoretical_Ah": theoretical_channel_ah,
                "theoretical_Wh": theoretical_channel_wh,
                "difference_Ah": item["transferred_Ah"] - theoretical_channel_ah,
                "difference_Wh": measured_channel_wh - theoretical_channel_wh,
                "battery_need_Wh": battery_need_wh,
                "energy_lost_Wh": energy_lost_wh,
                "battery_need_percent": (
                    battery_need_wh / pie_total_wh * 100
                    if pie_total_wh > 0 else 0
                ),
                "energy_lost_percent": (
                    energy_lost_wh / pie_total_wh * 100
                    if pie_total_wh > 0 else 0
                ),
                "soc_points": decimate_chart_points(
                    channel_soc_points, "soc_percent", max_points=4000
                ),
                "theoretical_soc_points": decimate_chart_points(
                    channel_theoretical_soc_points,
                    "soc_percent",
                    max_points=4000,
                ),
                "ending_soc_percent": channel_soc_points[-1]["soc_percent"],
                "theoretical_ending_soc_percent": (
                    channel_theoretical_soc_points[-1]["soc_percent"]
                ),
            })
        timeline = sorted({
            float(point["time_s"])
            for points in energy_series.values()
            for point in points
        } | {0.0})
        energy_indexes = {channel: 0 for channel in energy_series}

        def cumulative_energy_at(channel, timestamp):
            points = energy_series.get(channel) or []
            if not points:
                return 0.0
            index = energy_indexes[channel]
            while (
                index + 1 < len(points)
                and float(points[index + 1]["time_s"]) <= timestamp
            ):
                index += 1
            energy_indexes[channel] = index
            current = points[index]
            if index + 1 >= len(points):
                return float(current["energy_Ah"])
            following = points[index + 1]
            current_time = float(current["time_s"])
            following_time = float(following["time_s"])
            if following_time <= current_time:
                return float(current["energy_Ah"])
            ratio = max(
                0.0,
                min(1.0, (timestamp - current_time) / (following_time - current_time)),
            )
            return (
                float(current["energy_Ah"])
                + (float(following["energy_Ah"]) - float(current["energy_Ah"])) * ratio
            )

        soc_points = []
        theoretical_soc_points = []
        for timestamp in timeline:
            cumulative_ah = sum(
                cumulative_energy_at(channel, timestamp)
                for channel in energy_series
            )
            soc_points.append({
                "time_s": timestamp,
                "soc_percent": max(
                    0.0,
                    min(100.0, feeding_start_soc - cumulative_ah / feeding_capacity * 100),
                ),
            })
            theoretical_cumulative_ah = max(0.0, total_expected) * timestamp / 3600
            theoretical_soc_points.append({
                "time_s": timestamp,
                "soc_percent": max(
                    0.0,
                    min(
                        100.0,
                        feeding_start_soc
                        - theoretical_cumulative_ah / feeding_capacity * 100,
                    ),
                ),
            })
        soc_points = decimate_chart_points(soc_points, "soc_percent", max_points=4000)
        theoretical_soc_points = decimate_chart_points(
            theoretical_soc_points, "soc_percent", max_points=4000
        )
        ending_soc = (
            soc_points[-1]["soc_percent"] if soc_points else feeding_start_soc
        )
        theoretical_duration = max(
            (float(point["time_s"]) for point in theoretical_soc_points),
            default=max(0.0, duration_actual),
        )
        theoretical_energy_ah = max(0.0, total_expected) * theoretical_duration / 3600
        theoretical_energy_wh = theoretical_energy_ah * feeding_voltage
        theoretical_ending_soc = (
            theoretical_soc_points[-1]["soc_percent"]
            if theoretical_soc_points else feeding_start_soc
        )
        feeding = {
            "id": str(feeding_config.get("id") or "measured"),
            "name": str(feeding_config.get("name") or "Biberonnage mesuré"),
            "battery_capacity_Ah": feeding_capacity,
            "starting_soc_percent": feeding_start_soc,
            "ending_soc_percent": ending_soc,
            "soc_change_percent": ending_soc - feeding_start_soc,
            "theoretical_ending_soc_percent": theoretical_ending_soc,
            "theoretical_soc_change_percent": (
                theoretical_ending_soc - feeding_start_soc
            ),
            "demand_soc_percent": float(
                76 if configured_demand_soc is None else configured_demand_soc
            ),
            "target_soc_percent": float(
                90 if configured_target_soc is None else configured_target_soc
            ),
            "supply_voltage_V": feeding_voltage,
            "net_energy_Ah": sum(item["signed_Ah"] for item in energy_rows),
            "total_transferred_Ah": total_transferred_ah,
            "total_cost_ef_Wh": total_cost_wh,
            "theoretical_current_A": max(0.0, total_expected),
            "theoretical_energy_Ah": theoretical_energy_ah,
            "theoretical_cost_ef_Wh": theoretical_energy_wh,
            "energy_difference_Ah": total_transferred_ah - theoretical_energy_ah,
            "cost_difference_Wh": total_cost_wh - theoretical_energy_wh,
            "soc_difference_percent": ending_soc - theoretical_ending_soc,
            "number_of_measurements": 1 if rows else 0,
            "channels": energy_rows,
            "soc_points": soc_points,
            "theoretical_soc_points": theoretical_soc_points,
        }
    relevant_kind = "dcdc" if analysis_type in ("dcdc", "wltc") else "sleep"
    available_ids = {str(item.get("id")) for item in all_devices if item.get("kind") == relevant_kind}
    all_selected = bool(available_ids) and available_ids.issubset(selected_ids)
    sizing_channels = []
    for channel_metric in channel_metrics:
        if channel_metric.get("samples"):
            used_current = max(
                abs(float(channel_metric.get("minimum_current_A") or 0)),
                abs(float(channel_metric.get("peak_current_A") or 0)),
            )
            margin = dcdc_output - used_current
            sizing_channels.append({
                "channel": channel_metric["channel"],
                "address": channel_metric["address"],
                "used_current_A": used_current,
                "remaining_current_A": max(0.0, margin),
                "excess_current_A": max(0.0, -margin),
                "margin_current_A": margin,
                "status": "pass" if margin >= 0 else "fail",
            })
        else:
            sizing_channels.append({
                "channel": channel_metric["channel"],
                "address": channel_metric["address"],
                "used_current_A": None,
                "remaining_current_A": None,
                "excess_current_A": None,
                "margin_current_A": None,
                "status": "no_data",
            })
    current_to_limit = (
        max(0, dcdc_output - measured_peak) if measured_peak is not None else None
    )
    sizing_status = (
        "pass" if measured_peak is not None and measured_peak <= dcdc_output
        else ("fail" if measured_peak is not None else "no_data")
    )

    return {
        "session": session,
        "device": device,
        "channels": channel_reports,
        "has_data": bool(rows),
        "global_score": global_score,
        "global_status": "pass" if global_score >= 95 and duration_ok else (
            "warning" if global_score >= 80 else "fail"
        ),
        "duration": {
            "expected_s": duration_expected,
            "actual_s": duration_actual,
            "error_s": duration_error,
            "status": "pass" if duration_ok else "fail",
        },
        "analysis": {
            "type": analysis_type,
            "label": ANALYSIS_TYPES.get(analysis_type, analysis_type),
            "temperature_c": None if is_autonomy else temperature_c,
            "start_day": start_day,
            "end_day": end_day,
            "dashboard_channels": channels,
            "capacity_factor": capacity_factor,
            "selected_devices": device_summaries,
            "selected_count": len(selected_devices),
            "available_count": len(available_ids),
            "all_selected": all_selected,
            "profile_duration_s": profile_duration,
            "profile_repetitions": duration_actual / profile_duration if profile_duration > 0 else None,
            "theoretical_peak_A": theoretical_peak,
            "intervals": comparison_intervals,
            "intervals_ok": sum(item["status"] == "pass" for item in comparison_intervals),
            "intervals_with_data": sum(item["status"] != "no_data" for item in comparison_intervals),
        },
        "measurement": {
            "requested_frequency_hz": float(session.get("frequency_hz") or 0),
            "actual_frequency_hz": float(session.get("actual_frequency_hz") or session.get("frequency_hz") or 0),
            "average_current_A": measured_average,
            "peak_current_A": measured_peak,
            "energy_Ah": measured_energy,
            "series": chart_series,
            "channels": channel_metrics,
        },
        "sizing": {
            "output_current_A": dcdc_output,
            "current_to_output_A": current_to_limit,
            "status": sizing_status,
            "channels": sizing_channels,
        },
        "autonomy": {
            "battery_capacity_Ah": battery_capacity,
            "starting_soc_percent": starting_soc,
            "minimum_soc_percent": minimum_soc,
            "usable_capacity_Ah": usable_capacity,
            "daily_consumption_Ah": daily_consumption,
            "days": autonomy_days,
            "theoretical_daily_consumption_Ah": theoretical_daily_consumption,
            "theoretical_days": theoretical_autonomy_days,
            "difference_days": autonomy_difference_days,
            "excess_daily_Ah": autonomy_excess_daily,
            "excess_range_Ah": autonomy_excess_range,
            "excess_days": autonomy_excess_days,
            "status": autonomy_status,
            "profile": autonomy_profile,
        },
        "feeding": feeding,
    }


@app.route("/api/dashboard_report")
def api_dashboard_report():
    session_id = request.args.get("session_id", "").strip()
    with measurement_lock:
        should_refresh = (
            active_measurement.get("id") == session_id
            and active_measurement.get("status") == "running"
            and active_measurement.get("acquisition_mode") == "digital"
        )
    if should_refresh:
        try:
            reconcile_active_measurement(
                esp32_request("GET", "/api/acquisition/status")
            )
        except RuntimeError:
            # Les mesures déjà écrites restent consultables même si l'ESP32
            # devient momentanément injoignable.
            pass
    sessions = measurement_sessions()
    session = next((item for item in sessions if item.get("id") == session_id), sessions[0] if sessions else None)
    if not session:
        return jsonify({"status": "error", "message": "Aucune mesure disponible."}), 404
    return jsonify(dashboard_report(session))

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=80, debug=False)
