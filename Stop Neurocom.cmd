@echo off
rem Stops Neurocom (the game browser window stays open).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src[\\/]main\.ts' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host 'Neurocom stopped.'"
timeout /t 2 >nul
