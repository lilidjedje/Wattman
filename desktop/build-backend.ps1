$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot 'desktop-build'
$distRoot = Join-Path $outputRoot 'dist'
$workRoot = Join-Path $outputRoot 'work'

python -c "import PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw 'PyInstaller est requis. Installez-le avec : python -m pip install pyinstaller'
}

python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --name engineering-backend `
    --distpath $distRoot `
    --workpath $workRoot `
    --specpath $outputRoot `
    --paths (Join-Path $projectRoot 'can_server') `
    --hidden-import flask `
    --hidden-import sqlite3 `
    --hidden-import werkzeug.middleware.dispatcher `
    --collect-all openpyxl `
    --add-data "$projectRoot\templates;templates" `
    --add-data "$projectRoot\static;static" `
    --add-data "$projectRoot\app.py;." `
    --add-data "$projectRoot\can_server\templates;can_server\templates" `
    --add-data "$projectRoot\can_server\static;can_server\static" `
    --add-data "$projectRoot\can_server\app.py;can_server" `
    --add-data "$projectRoot\can_server\database.py;can_server" `
    --add-data "$projectRoot\can_server\can_parser.py;can_server" `
    --add-data "$projectRoot\can_server\can_collector.py;can_server" `
    --add-data "$projectRoot\can_server\sharepoint_sync.py;can_server" `
    --add-data "$projectRoot\can_server\peak_detector.py;can_server" `
    --add-data "$projectRoot\can_server\csv_reader.py;can_server" `
    --add-data "$projectRoot\can_server\ingest_logs.py;can_server" `
    --add-data "$projectRoot\can_server\config-dbc.ini;can_server" `
    --add-data "$projectRoot\can_server\config-dbc.dbc;can_server" `
    --add-data "$projectRoot\Consoveille.xlsx;." `
    --add-data "$projectRoot\DCDC.xlsx;." `
    (Join-Path $PSScriptRoot 'bridge.py')
