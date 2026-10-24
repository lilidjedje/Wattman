"""Collecte des mesures du sketch ESP32-C3 multi INA226."""

import os
import socket
import struct
import threading
import time
from urllib.parse import urlsplit

from database import get_db_connection, init_db


CURRENT_IDS = {0x100: "A", 0x102: "B"}
STATS_IDS = {0x101: "A", 0x103: "B"}


class SocketCanCollector:
    def __init__(self):
        self.interface = os.environ.get("CAN_INTERFACE", "can0").strip() or "can0"
        self.enabled = os.environ.get("CAN_COLLECTOR_ENABLED", "1").lower() not in {"0", "false", "no"}
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.RLock()
        self._state = {"running": False, "available": False, "interface": self.interface, "message": "En attente."}

    def state(self):
        with self._lock:
            return dict(self._state)

    def _set_state(self, **values):
        with self._lock:
            self._state.update(values)

    def start(self, source_file, channels, duration_s, target_url=None):
        self.stop()
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._collect,
            args=(source_file, set(channels), float(duration_s)),
            name="socketcan-collector",
            daemon=True,
        )
        self._thread.start()

    def stop(self):
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=1.5)
        self._thread = None

    def _collect(self, source_file, channels, duration_s):
        if not self.enabled:
            self._set_state(running=False, available=False, message="Collecteur SocketCAN désactivé.")
            return
        if not hasattr(socket, "PF_CAN"):
            self._set_state(running=False, available=False, message="SocketCAN est disponible uniquement sur Linux.")
            return

        can_socket = None
        connection = None
        samples = 0
        batch = []
        stats = {"A": {"frequency": 0, "lost": 0}, "B": {"frequency": 0, "lost": 0}}
        deadline = time.monotonic() + duration_s + 2
        try:
            init_db()
            can_socket = socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
            can_socket.settimeout(0.25)
            can_socket.bind((self.interface,))
            connection = get_db_connection()
            self._set_state(running=True, available=True, message=f"Collecte active sur {self.interface}.", samples=0)

            while not self._stop.is_set() and time.monotonic() <= deadline:
                try:
                    frame = can_socket.recv(16)
                except socket.timeout:
                    continue
                can_id, length, payload = struct.unpack("=IB3x8s", frame)
                can_id &= 0x1FFFFFFF
                payload = payload[:length]

                if can_id in STATS_IDS and len(payload) >= 4:
                    channel = STATS_IDS[can_id]
                    frequency, lost = struct.unpack("<HH", payload[:4])
                    stats[channel] = {"frequency": frequency, "lost": lost}
                    continue
                if can_id not in CURRENT_IDS or len(payload) < 4:
                    continue

                channel = CURRENT_IDS[can_id]
                if channel not in channels:
                    continue
                current = struct.unpack("<f", payload[:4])[0]
                batch.append((
                    time.time(),
                    channel,
                    current,
                    stats[channel]["frequency"],
                    stats[channel]["lost"],
                    source_file,
                ))
                samples += 1
                if len(batch) >= 500:
                    self._flush(connection, batch)
                    batch.clear()
                    self._set_state(samples=samples)

            if batch:
                self._flush(connection, batch)
            self._set_state(running=False, available=True, message="Collecte terminée.", samples=samples)
        except OSError as error:
            self._set_state(
                running=False,
                available=False,
                message=f"Interface {self.interface} indisponible : {error}",
                samples=samples,
            )
        finally:
            if connection is not None and batch:
                try:
                    SocketCanCollector._flush(connection, batch)
                    self._set_state(samples=samples)
                except Exception:
                    pass
            if connection is not None:
                connection.close()
            if can_socket is not None:
                can_socket.close()

    @staticmethod
    def _flush(connection, rows):
        connection.executemany(
            """INSERT INTO measurements
               (timestamp, channel, current_A, frequency_Hz, lost_count, source_file)
               VALUES (?, ?, ?, ?, ?, ?)""",
            rows,
        )
        connection.commit()


class TcpCanCollector:
    """Collecte le flux numérique direct publié par l'ESP32-C3, sans bus CAN."""

    MAGIC = 0xA55A
    FRAME = struct.Struct("<HBBHQ8s")

    def __init__(self):
        self._thread = None
        self._socket = None
        self._stop = threading.Event()
        self._lock = threading.RLock()
        self._state = {
            "running": False,
            "available": False,
            "interface": "Wi-Fi automatique",
            "message": "En attente de l'ESP32-C3.",
            "samples": 0,
        }

    def state(self):
        with self._lock:
            return dict(self._state)

    def _set_state(self, **values):
        with self._lock:
            self._state.update(values)

    def start(self, source_file, channels, duration_s, target_url=None):
        self.stop()
        host = urlsplit(target_url or "http://192.168.4.1").hostname or "192.168.4.1"
        try:
            stream_socket = socket.create_connection((host, 3333), timeout=5)
            stream_socket.settimeout(0.25)
        except OSError as error:
            self._set_state(
                running=False,
                available=False,
                interface=f"tcp://{host}:3333",
                message=f"Flux de mesures ESP32 indisponible : {error}",
            )
            raise RuntimeError(
                f"L'ESP32 répond, mais son flux de trames sur {host}:3333 est indisponible. "
                "Vérifiez que le nouveau firmware est téléversé."
            ) from error

        self._stop.clear()
        self._socket = stream_socket
        self._thread = threading.Thread(
            target=self._collect,
            args=(stream_socket, source_file, set(channels), float(duration_s), host),
            name="esp32-tcp-can-collector",
            daemon=True,
        )
        self._thread.start()

    def stop(self):
        self._stop.set()
        stream_socket = self._socket
        self._socket = None
        if stream_socket is not None:
            try:
                stream_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                stream_socket.close()
            except OSError:
                pass
        thread = self._thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=1.5)
        self._thread = None

    def _collect(self, stream_socket, source_file, channels, duration_s, host):
        connection = None
        buffer = bytearray()
        batch = []
        samples = 0
        stats = {"A": {"frequency": 0, "lost": 0}, "B": {"frequency": 0, "lost": 0}}
        deadline = time.monotonic() + duration_s + 3
        last_flush = time.monotonic()
        magic = struct.pack("<H", self.MAGIC)
        try:
            init_db()
            connection = get_db_connection()
            self._set_state(
                running=True,
                available=True,
                interface=f"tcp://{host}:3333",
                message="Réception numérique directe depuis l'ESP32-C3 (sans CAN).",
                samples=0,
            )
            while not self._stop.is_set() and time.monotonic() <= deadline:
                try:
                    chunk = stream_socket.recv(8192)
                    if not chunk:
                        break
                    buffer.extend(chunk)
                except socket.timeout:
                    if batch and time.monotonic() - last_flush >= 0.5:
                        SocketCanCollector._flush(connection, batch)
                        batch.clear()
                        last_flush = time.monotonic()
                        self._set_state(samples=samples)
                    continue

                while len(buffer) >= self.FRAME.size:
                    if buffer[:2] != magic:
                        marker = buffer.find(magic, 1)
                        del buffer[:marker if marker >= 0 else max(1, len(buffer) - 1)]
                        continue
                    _, version, length, can_id, timestamp_us, raw_payload = self.FRAME.unpack_from(buffer)
                    del buffer[:self.FRAME.size]
                    if version != 1 or length > 8:
                        continue
                    payload = raw_payload[:length]
                    if can_id in STATS_IDS and len(payload) >= 4:
                        channel = STATS_IDS[can_id]
                        frequency, lost = struct.unpack("<HH", payload[:4])
                        stats[channel] = {"frequency": frequency, "lost": lost}
                        continue
                    if can_id not in CURRENT_IDS or len(payload) < 4:
                        continue
                    channel = CURRENT_IDS[can_id]
                    if channel not in channels:
                        continue
                    batch.append((
                        timestamp_us / 1_000_000,
                        channel,
                        struct.unpack("<f", payload[:4])[0],
                        stats[channel]["frequency"],
                        stats[channel]["lost"],
                        source_file,
                    ))
                    samples += 1
                    if len(batch) >= 500:
                        SocketCanCollector._flush(connection, batch)
                        batch.clear()
                        last_flush = time.monotonic()
                        self._set_state(samples=samples)
                if batch and time.monotonic() - last_flush >= 0.5:
                    SocketCanCollector._flush(connection, batch)
                    batch.clear()
                    last_flush = time.monotonic()
                    self._set_state(samples=samples)
            if batch:
                SocketCanCollector._flush(connection, batch)
            self._set_state(
                running=False,
                available=True,
                message="Réception numérique terminée.",
                samples=samples,
            )
        except OSError as error:
            self._set_state(
                running=False,
                available=False,
                message=f"Flux ESP32 interrompu : {error}",
                samples=samples,
            )
        finally:
            if connection is not None and batch:
                try:
                    SocketCanCollector._flush(connection, batch)
                    self._set_state(samples=samples)
                except Exception:
                    pass
            if connection is not None:
                connection.close()
            try:
                stream_socket.close()
            except OSError:
                pass
            if self._socket is stream_socket:
                self._socket = None
