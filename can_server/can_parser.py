import struct

def iter_asc_stream_rows(file_lines, filename, fallback_base_timestamp):
    stats = {
        "A": {"freq": 1000, "lost": 0},
        "B": {"freq": 1000, "lost": 0}
    }
    
    # Sécurité d'origine
    base_timestamp = fallback_base_timestamp
    
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
            dlc = int(parts[rx_idx + 2])
            data_start = rx_idx + 3
            
            # 🕒 Interception de l'ID 105 émis par l'ESP32
            if can_id == "105":
                try:
                    data_bytes = bytes(int(b, 16) for b in parts[data_start:data_start + dlc])
                    # Déballage au format Big-Endian de l'entier non-signé 32 bits
                    unix_lu = struct.unpack("<I", data_bytes[0:4])[0]
                    if unix_lu > 100000:
                        base_timestamp = unix_lu - float(parts[0])
                except Exception:
                    continue

            elif can_id == "100":
                try:
                    data_bytes = bytes(int(b, 16) for b in parts[data_start:data_start + dlc])
                    current = struct.unpack("<f", data_bytes[0:4])[0]
                    abs_ts = base_timestamp + float(parts[0])
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
                    abs_ts = base_timestamp + float(parts[0])
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