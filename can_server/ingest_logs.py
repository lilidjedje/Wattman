import os
from pathlib import Path
from database import get_db_connection, init_db
from can_parser import iter_asc_rows

DATA_DIR = Path("data")

def ingest_new_logs():
    init_db()
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT filename, last_size, last_mtime FROM file_tracker")
    tracker = {row['filename']: (row['last_size'], row['last_mtime']) for row in cursor.fetchall()}
    
    asc_files = sorted(DATA_DIR.glob("*.asc"))
    
    for filepath in asc_files:
        filename = filepath.name
        stat = filepath.stat()
        current_size = stat.st_size
        current_mtime = stat.st_mtime
        
        if filename in tracker:
            old_size, old_mtime = tracker[filename]
            if current_size == old_size and current_mtime == old_mtime:
                continue
        
        print(f"📥 Traitement du fichier multi-points : {filename}")
        
        # Purge ciblée pour ce fichier uniquement
        cursor.execute("DELETE FROM measurements WHERE source_file = ?", (filename,))
        cursor.execute("DELETE FROM measurements_summary_1m WHERE source_file = ?", (filename,))
        
        buffer = []
        try:
            for row in iter_asc_rows(filepath):
                # row contient: (abs_ts, channel, current, freq, lost)
                full_row = row + (filename,)
                buffer.append(full_row)
                if len(buffer) >= 20000:
                    cursor.executemany('''
                        INSERT INTO measurements (timestamp, channel, current_A, frequency_Hz, lost_count, source_file) 
                        VALUES (?, ?, ?, ?, ?, ?)
                    ''', buffer)
                    conn.commit()
                    buffer = []
        except Exception as e:
            print(f"[INFO] Lecture partielle de {filename} : {e}")
            
        if buffer:
            cursor.executemany('''
                INSERT INTO measurements (timestamp, channel, current_A, frequency_Hz, lost_count, source_file) 
                VALUES (?, ?, ?, ?, ?, ?)
            ''', buffer)
            conn.commit()
            
        # Génération du résumé par minute dissocié par CANAL (A et B)
        print(f"[INFO] Calcul des résumés (A & B) pour {filename}...")
        cursor.execute("""
            INSERT INTO measurements_summary_1m (timestamp_minute, channel, current_min, current_max, current_avg, source_file)
            SELECT 
                (CAST(timestamp AS INTEGER) / 60) * 60 as min_ts,
                channel,
                MIN(current_A),
                MAX(current_A),
                AVG(current_A),
                ?
            FROM measurements
            WHERE source_file = ?
            GROUP BY min_ts, channel
        """, (filename, filename))
        
        cursor.execute('''
            INSERT OR REPLACE INTO file_tracker (filename, last_size, last_mtime) 
            VALUES (?, ?, ?)
        ''', (filename, current_size, current_mtime))
        conn.commit()
        
    conn.close()