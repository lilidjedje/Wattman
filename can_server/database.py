import os
from pathlib import Path
import sqlite3

# Utilise un chemin relatif au projet pour garantir la même base selon l'instance déployée.
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("ENGINEERING_APP_DATA", "")).resolve() / "can_data" if os.environ.get("ENGINEERING_APP_DATA") else BASE_DIR / "Base_de_Donnees"
DB_PATH = DATA_DIR / "mesures.db"

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    # Crée automatiquement l'arborescence des dossiers sur le PC s'ils n'existent pas
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Vos tables SQL
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS measurements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            channel TEXT NOT NULL,      
            current_A REAL NOT NULL,
            frequency_Hz INTEGER,
            lost_count INTEGER,
            source_file TEXT
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS measurements_summary_1m (
            timestamp_minute REAL,
            channel TEXT,               
            current_min REAL,
            current_max REAL,
            current_avg REAL,
            source_file TEXT,
            PRIMARY KEY (timestamp_minute, channel)
        )
    ''')
    
    cursor.execute('CREATE TABLE IF NOT EXISTS imported_can_files (source_file TEXT PRIMARY KEY, filename TEXT NOT NULL)')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS saved_dashboards (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            project_name TEXT NOT NULL,
            session_id TEXT NOT NULL,
            dashboard_name TEXT NOT NULL,
            source TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            source_files_json TEXT NOT NULL,
            analysis_json TEXT NOT NULL,
            report_json TEXT NOT NULL
        )
    ''')
    columns = {row[1] for row in cursor.execute('PRAGMA table_info(saved_dashboards)')}
    for name, kind in [('database_snapshot', 'BLOB'), ('view_json', "TEXT NOT NULL DEFAULT '{}'")]:
        if name not in columns:
            cursor.execute(f'ALTER TABLE saved_dashboards ADD COLUMN {name} {kind}')

    cursor.execute(
        'CREATE INDEX IF NOT EXISTS idx_saved_dashboards_project '
        'ON saved_dashboards(project_id, saved_at)'
    )

    cursor.execute('CREATE INDEX IF NOT EXISTS idx_current ON measurements(current_A)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_ts ON measurements(timestamp)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_channel_ts ON measurements(channel, timestamp)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_source_ts ON measurements(source_file, timestamp)')
    
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
    print(f"Base de données SQLite initialisée avec succès à l'emplacement : {DB_PATH}")
