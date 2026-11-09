import os
import shutil
import sys
from pathlib import Path
from datetime import datetime

# Chemins locaux sur le Raspberry Pi
DB_LOCAL_PATH = Path(os.path.expanduser("~")) / "can_server/Base_de_Donnees/mesures.db"

# --- MÉTHODE 1 : Si ton SharePoint est monté comme un dossier réseau sur le Pi ---
# (Voir section 4 pour le montage réseau Linux)
SHAREPOINT_MOUNT_DIR = Path("/mnt/sharepoint_renault")

def backup_to_sharepoint_local_mount():
    try:
        if not DB_LOCAL_PATH.exists():
            print("Erreur : La base locale n'existe pas encore.", file=sys.stderr)
            return False
        
        # Sécurité : Création du dossier cible s'il n'existe pas
        SHAREPOINT_MOUNT_DIR.mkdir(parents=True, exist_ok=True)
        
        # Génère un nom de fichier horodaté pour éviter d'écraser sauvagement
        date_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        destination = SHAREPOINT_MOUNT_DIR / f"mesures_backup_{date_str}.db"
        
        # Copie physique du fichier vers SharePoint
        shutil.copy2(DB_LOCAL_PATH, destination)
        print(f" Sauvegarde réussie sur SharePoint (Montage) : {destination.name}", file=sys.stderr)
        return True
    except Exception as e:
        print(f" Échec de la sauvegarde sur SharePoint : {e}", file=sys.stderr)
        return False

if __name__ == "__main__":
    backup_to_sharepoint_local_mount()
