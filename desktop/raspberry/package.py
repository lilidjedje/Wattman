"""Build the Pi deployment archive without PC data, credentials or node_modules."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[2]
output = root / 'desktop-build' / 'wattman-recorder.zip'
output.parent.mkdir(exist_ok=True)
files = [root / name for name in ('app.py', 'requirements.txt', 'Consoveille.xlsx', 'DCDC.xlsx',
                                  'desktop/recorder.py', 'desktop/raspberry/install.sh',
                                  'desktop/raspberry/README.md', 'desktop/raspberry/GUIDE_DEBUTANTE.md',
                                  'can_server/esp32C3-multi-INA226-copie/esp32C3-multi-INA226-copie.ino',
                                  'can_server/esp32C3-multi-INA226-copie/wattman_tft.h',
                                  'can_server/esp32C3-multi-INA226-copie/BRANCHEMENT_TFT_ST7735.md')]
files += list((root / 'can_server').glob('*.py'))
for folder in ('templates', 'static', 'can_server/templates', 'can_server/static'):
    files += [path for path in (root / folder).rglob('*') if path.is_file()]
files += list((root / 'can_server').glob('config-dbc.*'))
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in sorted(set(files)):
        if path.is_file():
            archive.write(path, path.relative_to(root).as_posix())
print(output)
