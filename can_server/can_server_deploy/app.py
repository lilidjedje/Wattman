from flask import Flask, render_template, request, jsonify, Response, redirect, url_for
import sqlite3
import os
import time
import io
import csv
import os
import json
import threading
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from datetime import datetime, timedelta
from database import get_db_connection, init_db
from can_parser import iter_asc_stream_rows
from sharepoint_sync import backup_to_sharepoint_local_mount
from can_collector import SocketCanCollector



PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(PROJECT_DIR, "templates"),
    static_folder=os.path.join(PROJECT_DIR, "static")
)
can_collector = SocketCanCollector()


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

DATA_DIR = os.path.join(PROJECT_DIR, "data")
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
    os.replace(temporary_path, path)


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


def find_theory_device(device_id):
    return next((item for item in theory_snapshot().get("devices", []) if item.get("id") == device_id), None)


@app.route("/")
def index():
    return render_template("home.html", theory=theory_snapshot())


@app.route("/measurement")
def measurement():
    return render_template("measurement.html", theory=theory_snapshot())


@app.route("/logs")
def logs():
    return render_template("index.html", theory=theory_snapshot())


@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html")


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
        session = {
            "id": uuid.uuid4().hex,
            "status": "analysis",
            "started_at": start_ts,
            "ended_at": end_ts,
            "requested_duration_s": end_ts - start_ts,
            "actual_duration_s": end_ts - start_ts,
            "frequency_hz": 0,
            "channels": channels or ["A", "B"],
            "measurement_type": payload.get("measurement_type", device.get("kind", "dcdc")),
            "device_id": payload.get("device_id", ""),
            "device_name": device.get("name", payload.get("device_name", "")),
            "theory_device": device,
            "scenario": payload.get("scenario", ""),
            "tolerance_percent": max(0.1, min(float(payload.get("tolerance_percent", 10)), 100)),
            "project": theory_snapshot().get("project", {}),
        }
        save_measurement_session(session)
        return jsonify({"status": "success", "session": session, "dashboard_url": url_for("dashboard", session_id=session["id"])})
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
        return jsonify({"error": "Aucun fichier détecté"}), 400

    uploaded_files = request.files.getlist("files")
    init_db()
    
    conn = get_db_connection()
    conn.execute("PRAGMA journal_mode=WAL;")
    cursor = conn.cursor()
    fichiers_comptes = 0

    for file_storage in uploaded_files:
        if file_storage.filename == "":
            continue
            
        filename = file_storage.filename
        fichiers_comptes += 1
        
        cursor.execute("DELETE FROM measurements WHERE source_file = ?", (filename,))
        cursor.execute("DELETE FROM measurements_summary_1m WHERE source_file = ?", (filename,))
        conn.commit()
        
        file_bytes = file_storage.read()
        lines = file_bytes.decode('utf-8', errors='ignore').splitlines()
        
        # Lecture en-tête par sécurité si la trame 105 est manquante
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
        for row in iter_asc_stream_rows(lines, filename, base_timestamp):
            buffer.append(row)
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

        # Nettoyage définitif du bug UNIQUE constraint failed
        cursor.execute("""
            INSERT OR REPLACE INTO measurements_summary_1m (timestamp_minute, channel, current_min, current_max, current_avg, source_file)
            SELECT (CAST(timestamp AS INTEGER) / 60) * 60, channel, MIN(current_A), MAX(current_A), AVG(current_A), ?
            FROM measurements WHERE source_file = ? GROUP BY 1, channel
        """, (filename, filename))
        conn.commit()

    conn.close()
    backup_to_sharepoint_local_mount()
    
    return jsonify({"status": "success", "fichiers_traites": fichiers_comptes})
    

@app.route("/api/purge_database", methods=["POST"])
def purge_database():
    try:
        init_db()
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM measurements;")
        cursor.execute("DELETE FROM measurements_summary_1m;")
        conn.commit()
        conn.close()
        return jsonify({"status": "success", "message": "Base réinitialisée !"})
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

# L'ESP32-C3 rejoint le point d'accès du Raspberry Pi et publie ce nom mDNS.
# ESP32_BASE_URL permet de forcer son IP si mDNS n'est pas disponible sur le Pi.
ESP32_BASE_URL = os.environ.get("ESP32_BASE_URL", "http://esp32c3-mesure.local").rstrip("/")
ESP32_SIMULATOR = os.environ.get("ESP32_SIMULATOR", "").lower() in {"1", "true", "yes"}
simulator_lock = threading.RLock()
simulator_state = {
    "running": False,
    "duration": 0,
    "frequency": 0,
    "started_at": 0.0,
    "sensors": {
        "A": {"running": False, "finished": False},
        "B": {"running": False, "finished": False},
    },
}
measurement_lock = threading.RLock()
active_measurement = {}


def simulated_esp32_status():
    """Retourne un état ESP32 de test avec la même structure que le firmware."""
    with simulator_lock:
        elapsed = min(int(time.time() - simulator_state["started_at"]), simulator_state["duration"])
        if simulator_state["running"] and elapsed >= simulator_state["duration"]:
            simulator_state["running"] = False
            for sensor in simulator_state["sensors"].values():
                sensor["finished"] = sensor["running"]
                sensor["running"] = False

        sensors = {}
        for name, sensor in simulator_state["sensors"].items():
            sensors[name] = {
                **sensor,
                "samples": elapsed * simulator_state["frequency"] if sensor["running"] or sensor["finished"] else 0,
                "lost": 0,
                "frequency": simulator_state["frequency"] if sensor["running"] else 0,
            }
        return {
            "running": simulator_state["running"],
            "duration": simulator_state["duration"],
            "elapsed": elapsed,
            "frequency": simulator_state["frequency"],
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
            simulator_state["started_at"] = time.time()
            simulator_state["running"] = True
            for name, sensor in simulator_state["sensors"].items():
                sensor["running"] = bool(int(params.get(f"active{name}", 0)))
                sensor["finished"] = False
        elif path == "/api/acquisition/stop" and method == "POST":
            sensor_name = params.get("sensor", "ALL")
            targets = simulator_state["sensors"] if sensor_name == "ALL" else {sensor_name: simulator_state["sensors"][sensor_name]}
            for sensor in targets.values():
                sensor["running"] = False
            simulator_state["running"] = any(sensor["running"] for sensor in simulator_state["sensors"].values())
        else:
            raise RuntimeError("Route de simulateur inconnue.")
    return simulated_esp32_status()


def esp32_request(method, path, params=None):
    """Appelle l'API HTTP de l'ESP32 et retourne sa réponse JSON."""
    if ESP32_SIMULATOR:
        return simulated_esp32_request(method, path, params)

    query = urlencode(params or {})
    url = f"{ESP32_BASE_URL}{path}"
    if query:
        url = f"{url}?{query}"

    request_to_esp = Request(url, method=method)
    try:
        with urlopen(request_to_esp, timeout=2) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("message", body)
        except json.JSONDecodeError:
            detail = body
        raise RuntimeError(detail or f"L'ESP32 a répondu HTTP {error.code}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"ESP32 injoignable sur {ESP32_BASE_URL}: {error}") from error


def duration_in_seconds(value, unit):
    multipliers = {"s": 1, "m": 60, "h": 3600, "j": 86400}
    if unit not in multipliers:
        raise ValueError("Unité de durée invalide.")
    duration = value * multipliers[unit]
    if not 1 <= duration <= 7 * 86400:
        raise ValueError("La durée doit être comprise entre 1 seconde et 7 jours.")
    return duration


@app.route("/api/control_esp_acquisition", methods=["POST"])
def control_esp_acquisition():
    """Proxy des commandes de mesure vers l'ESP32 du réseau du Raspberry Pi."""
    action = request.form.get("action", "start")

    try:
        if action == "stop":
            sensor = request.form.get("sensor", "all").upper()
            if sensor not in ("A", "B", "ALL"):
                raise ValueError("Capteur à arrêter invalide.")
            status = esp32_request("POST", "/api/acquisition/stop", {"sensor": sensor})
            with measurement_lock:
                if active_measurement and not status.get("running"):
                    can_collector.stop()
                    active_measurement["status"] = "stopped"
                    active_measurement["ended_at"] = time.time()
                    active_measurement["actual_duration_s"] = max(
                        0, active_measurement["ended_at"] - active_measurement.get("started_at", active_measurement["ended_at"])
                    )
                    save_measurement_session(dict(active_measurement))
            return jsonify({
                "status": "success",
                "message": "Arrêt confirmé par l'ESP32.",
                "acquisition": status,
                "session": dict(active_measurement),
            })

        frequency = int(request.form.get("freq", 1000))
        if not 1 <= frequency <= 2000:
            raise ValueError("La fréquence doit être comprise entre 1 et 2000 Hz.")

        duration = duration_in_seconds(
            int(request.form.get("dureeValeur", 10)),
            request.form.get("dureeUnite", "s"),
        )
        active_a = 1 if request.form.get("activeA") else 0
        active_b = 1 if request.form.get("activeB") else 0
        if not (active_a or active_b):
            raise ValueError("Sélectionnez au moins un capteur.")

        status = esp32_request("POST", "/api/acquisition/start", {
            "frequency": frequency,
            "duration": duration,
            "activeA": active_a,
            "activeB": active_b,
            "timestamp": int(time.time()),
        })
        device_id = request.form.get("device_id", "").strip()
        device = find_theory_device(device_id) or {}
        started_at = time.time()
        with measurement_lock:
            active_measurement.clear()
            active_measurement.update({
                "id": uuid.uuid4().hex,
                "status": "running",
                "started_at": started_at,
                "ended_at": None,
                "requested_duration_s": duration,
                "actual_duration_s": 0,
                "frequency_hz": frequency,
                "channels": [name for name, active in (("A", active_a), ("B", active_b)) if active],
                "measurement_type": request.form.get("measurement_type", device.get("kind", "dcdc")),
                "device_id": device_id,
                "device_name": request.form.get("device_name", device.get("name", "")).strip(),
                "theory_device": device,
                "scenario": request.form.get("scenario", "").strip(),
                "tolerance_percent": max(0.1, min(float(request.form.get("tolerance_percent", 10)), 100)),
                "project": theory_snapshot().get("project", {}),
            })
            save_measurement_session(dict(active_measurement))
            can_collector.start(
                source_file=f"live_{active_measurement['id']}",
                channels=active_measurement["channels"],
                duration_s=duration,
            )
        return jsonify({
            "status": "success",
            "message": "Mesure démarrée et confirmée par l'ESP32.",
            "acquisition": status,
            "session": dict(active_measurement),
            "collector": can_collector.state(),
        })
    except (TypeError, ValueError, RuntimeError) as error:
        return jsonify({"status": "error", "message": str(error)}), 400

@app.route("/api/esp_target_config", methods=["GET"])
def esp_target_config():
    """Retourne l'état mesuré par l'ESP32, sans approximation côté navigateur."""
    try:
        status = esp32_request("GET", "/api/acquisition/status")
        with measurement_lock:
            if active_measurement and active_measurement.get("status") == "running" and not status.get("running"):
                can_collector.stop()
                active_measurement["status"] = "completed"
                active_measurement["ended_at"] = time.time()
                active_measurement["actual_duration_s"] = status.get(
                    "elapsed", active_measurement.get("requested_duration_s", 0)
                )
                save_measurement_session(dict(active_measurement))
            status["session"] = dict(active_measurement)
            status["collector"] = can_collector.state()
        return jsonify(status)
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


def dashboard_report(session):
    device = session.get("theory_device") or find_theory_device(session.get("device_id")) or {}
    start_ts = float(session.get("started_at") or 0)
    end_ts = float(session.get("ended_at") or time.time())
    tolerance = float(session.get("tolerance_percent") or 10)
    scenario = selected_scenario(device, session.get("scenario", ""))
    channels = session.get("channels") or ["A", "B"]

    init_db()
    conn = get_db_connection()
    placeholders = ",".join("?" for _ in channels)
    rows = conn.execute(
        f"""SELECT timestamp, channel, current_A, frequency_Hz, lost_count
            FROM measurements
            WHERE timestamp >= ? AND timestamp <= ? AND channel IN ({placeholders})
            ORDER BY timestamp ASC""",
        [start_ts, end_ts, *channels],
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
    duration_actual = float(session.get("actual_duration_s") or max(0, end_ts - start_ts))
    duration_error = abs(duration_actual - duration_expected)
    duration_ok = duration_error <= max(1, duration_expected * 0.02)
    global_score = sum(all_conformities) / len(all_conformities) if all_conformities else 0
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
    }


@app.route("/api/dashboard_report")
def api_dashboard_report():
    sessions = measurement_sessions()
    session_id = request.args.get("session_id", "").strip()
    session = next((item for item in sessions if item.get("id") == session_id), sessions[0] if sessions else None)
    if not session:
        return jsonify({"status": "error", "message": "Aucune mesure disponible."}), 404
    return jsonify(dashboard_report(session))

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=80, debug=False)
