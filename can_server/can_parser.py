import struct
import math

def iter_asc_stream_rows(file_lines, filename, fallback_base_timestamp, timestamp_info=None):
    stats = {
        "A": {"freq": 0, "lost": 0},
        "B": {"freq": 0, "lost": 0}
    }
    
    # Sécurité d'origine
    base_timestamp = fallback_base_timestamp
    synchronized = False
    
    for line in file_lines:
        if isinstance(line, bytes):
            line = line.decode('utf-8', errors='ignore')
            
        parts = line.split()
        if len(parts) < 7:
            continue
            
        if "Rx" in parts:
            rx_idx = parts.index("Rx")
            if len(parts) < rx_idx + 3:
                continue
                
            can_id = parts[rx_idx - 1].strip()
            try:
                dlc = int(parts[rx_idx + 2])
            except ValueError:
                continue
            data_start = rx_idx + 3
            
            # 🕒 Interception de l'ID 105 émis par l'ESP32
            if can_id == "105":
                try:
                    data_bytes = bytes(int(b, 16) for b in parts[data_start:data_start + dlc])
                    # Déballage au format Big-Endian de l'entier non-signé 32 bits
                    unix_lu = struct.unpack("<I", data_bytes[0:4])[0]
                    # Preserve the ASC elapsed-time axis. Repeated integer-second
                    # sync frames must not move samples backwards or extend a log.
                    # A valid ASC date header is authoritative for that file.
                    if unix_lu > 100000 and not synchronized and not (timestamp_info or {}).get('header'):
                        base_timestamp = unix_lu - float(parts[0])
                        synchronized = True
                        if timestamp_info is not None:
                            timestamp_info['synchronized'] = True
                except Exception:
                    continue

            elif can_id == "100":
                try:
                    data_bytes = bytes(int(b, 16) for b in parts[data_start:data_start + dlc])
                    current = struct.unpack("<f", data_bytes[0:4])[0]
                    if not math.isfinite(current):
                        continue
                    abs_ts = base_timestamp + float(parts[0])
                    if timestamp_info is not None and not timestamp_info.get('header') and not timestamp_info.get('synchronized'):
                        timestamp_info['uncertain'] = True
                    yield (abs_ts, "A", current, stats["A"]["freq"], stats["A"]["lost"], filename)
                except Exception:
                    continue
            elif can_id == "101":
                try:
                    data_bytes = bytes(int(b, 16) for b in parts[data_start:data_start + dlc])
                    stats["A"]["freq"] = struct.unpack("<H", data_bytes[0:2])[0]
                    stats["A"]["lost"] = struct.unpack("<H", data_bytes[2:4])[0]
                except Exception:
                    continue
            elif can_id == "102":
                try:
                    data_bytes = bytes(int(b, 16) for b in parts[data_start:data_start + dlc])
                    current = struct.unpack("<f", data_bytes[0:4])[0]
                    if not math.isfinite(current):
                        continue
                    abs_ts = base_timestamp + float(parts[0])
                    if timestamp_info is not None and not timestamp_info.get('header') and not timestamp_info.get('synchronized'):
                        timestamp_info['uncertain'] = True
                    yield (abs_ts, "B", current, stats["B"]["freq"], stats["B"]["lost"], filename)
                except Exception:
                    continue
            elif can_id == "103":
                try:
                    data_bytes = bytes(int(b, 16) for b in parts[data_start:data_start + dlc])
                    stats["B"]["freq"] = struct.unpack("<H", data_bytes[0:2])[0]
                    stats["B"]["lost"] = struct.unpack("<H", data_bytes[2:4])[0]
                except Exception:
                    continue
