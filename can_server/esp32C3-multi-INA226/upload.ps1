param([string]$Port)
$ErrorActionPreference = 'Stop'
$cli = (Get-Command arduino-cli -ErrorAction SilentlyContinue).Source
if (!$cli) { $cli = 'C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe' }
if (!(Test-Path -LiteralPath $cli)) { throw 'arduino-cli introuvable. Installez Arduino IDE ou ajoutez arduino-cli au PATH.' }
if (!$Port) {
    $devices = @(Get-PnpDevice -Class Ports -PresentOnly | Where-Object { $_.InstanceId -like 'USB\VID_303A*' -and $_.Status -eq 'OK' })
    if ($devices.Count -ne 1) { throw 'Branchez un seul ESP32 USB Espressif ou precisez -Port COMx.' }
    if ($devices[0].FriendlyName -match '\((COM\d+)\)') { $Port = $Matches[1] }
    if (!$Port) { throw 'Port COM de l ESP32 introuvable.' }
}
$fqbn = 'esp32:esp32:esp32c3:CDCOnBoot=cdc'
$build = Join-Path $PSScriptRoot '../../outputs/multi-ina-build'
Write-Host "Compilation ESP32-C3 puis televersement sur $Port"
& $cli compile --fqbn $fqbn --build-path $build $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Compilation echouee.' }
& $cli upload --fqbn $fqbn --port $Port --input-dir $build $PSScriptRoot
if ($LASTEXITCODE -ne 0) {
    throw 'Televersement echoue. Fermez le moniteur serie. Maintenez BOOT, appuyez puis relachez RESET/EN, relachez BOOT, et relancez le script.'
}
