from pathlib import Path
import sqlite3

# Utilise un chemin relatif au projet pour garantir la même base selon l'instance déployée.
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "Base_de_Donnees" / "mesures.db"

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
    
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_current ON measurements(current_A)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_ts ON measurements(timestamp)')
    
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
    print(f"Base de données SQLite initialisée avec succès à l'emplacement : {DB_PATH}")