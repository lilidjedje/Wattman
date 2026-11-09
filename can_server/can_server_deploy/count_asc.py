from pathlib import Path

count = 0

for file in Path("data").glob("*.asc"):
    print("Lecture :", file)
    with open(file, "r", errors="ignore") as f:
        for line in f:
            if " 100 " in line:  # filtre ID CAN
                count += 1

print("Nombre total de trames ID 0x100 :", count)
