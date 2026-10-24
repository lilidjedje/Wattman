# check_db.py
from database import get_db_connection

conn = get_db_connection()
cursor = conn.cursor()

cursor.execute("SELECT COUNT(*) FROM measurements;")
count = cursor.fetchone()[0]

print("Nombre de mesures dans la DB centralisée :", count)

conn.close()