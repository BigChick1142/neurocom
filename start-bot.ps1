# One-click start: runs the bot in the background (if it isn't already) and opens the dashboard.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed. Install it from https://nodejs.org and run this again."; Read-Host "Press Enter"; exit 1
}
if (-not (Test-Path "node_modules")) {
  Write-Host "First run: installing (a few minutes)..."
  npm install
  npx playwright install chromium
}
New-Item -ItemType Directory -Force -Path data | Out-Null
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]main\.ts' }
if (-not $running) {
  Write-Host "Starting Neurocom..."
  Start-Process -FilePath "npm.cmd" -ArgumentList "run", "start" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
    -RedirectStandardOutput "data\bot.out.log" -RedirectStandardError "data\bot.err.log"
} else { Write-Host "Neurocom is already running." }
for ($i = 0; $i -lt 40; $i++) {
  try { Invoke-WebRequest "http://127.0.0.1:8787/" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 }
}
Start-Process "http://127.0.0.1:8787/"
Write-Host "Dashboard opened. First time only: log in to the game in the browser window that appeared."
