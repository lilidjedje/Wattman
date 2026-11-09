$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$temporaryOutput = Join-Path $env:TEMP ("engineering-calculator-build-" + [DateTime]::UtcNow.ToString("yyyyMMddHHmmss"))
$finalOutput = Join-Path $projectRoot "dist"

& (Join-Path $PSScriptRoot "build-backend.ps1")
New-Item -ItemType Directory -Path $temporaryOutput | Out-Null
Push-Location $projectRoot
try {
    npx electron-builder --win nsis "--config.directories.output=$temporaryOutput"
    if ($LASTEXITCODE -ne 0) { throw "La création de l'installateur Electron a échoué." }
    New-Item -ItemType Directory -Path $finalOutput -Force | Out-Null
    Copy-Item `
        -LiteralPath (Join-Path $temporaryOutput "Engineering Calculator-Setup-2.0.0.exe") `
        -Destination (Join-Path $finalOutput "Engineering Calculator-Setup-2.0.0.exe") `
        -Force
} finally {
    Pop-Location
}

Write-Host "Installateur créé dans $finalOutput"
