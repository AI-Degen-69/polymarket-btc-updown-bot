# Restart: kill whatever bot loop/dashboard/vite is running, start a fresh
# dashboard API on 8788, a fresh paper loop, the Vite dashboard on 5173,
# then open the console in a browser.
$root = $PSScriptRoot
$state = Join-Path $root '.state'
$pidFile = Join-Path $state 'bot.pid'
$health = 'http://127.0.0.1:8788/api/bot/health'
# The npm shim `bun.ps1` is not an executable, so the real bun.exe is resolved once.
$bun = (Get-Command bun.exe -CommandType Application | Select-Object -First 1).Source
if (-not $bun) { throw 'bun.exe not found on PATH' }

New-Item -ItemType Directory -Force -Path $state | Out-Null

function Test-Api([string]$url) {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url).StatusCode -eq 200 } catch { $false }
}

# Kills the matching processes only: /T would take unrelated children with it.
function Stop-Procs([string]$pattern) {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern } | ForEach-Object {
    & taskkill /PID $_.ProcessId /F 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "Stopped PID $($_.ProcessId)" }
  }
}

# 1. Every running bot loop, whichever copy of the project started it, plus the
#    wrapper that launched it.
Stop-Procs 'index\.ts"?\s+run\b'
Stop-Procs 'bun(\.exe)?"?\s+run"?\s+run"?\s*$'
Stop-Procs 'vite\b'
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue

# 2. A dashboard from another project copy would serve that copy's state instead
#    of this one's, so it gets replaced.
$owned = $false
if (Test-Api $health) {
  $dir = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $health).Content | ConvertFrom-Json
  $owned = $dir.dataDir.TrimEnd('\') -eq $state.TrimEnd('\')
  if (-not $owned) { Write-Host "Port 8788 belongs to $($dir.dataDir) - restarting it from here"; Stop-Procs 'dashboard'; Start-Sleep -Milliseconds 500 }
}

if (-not $owned) {
  Move-Item (Join-Path $state 'dashboard.log') (Join-Path $state 'dashboard.log.1') -Force -ErrorAction SilentlyContinue
  $dashboard = Start-Process $bun -ArgumentList 'run', 'dashboard' -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $state 'dashboard.log') `
    -RedirectStandardError (Join-Path $state 'dashboard.err') -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 60 -and -not (Test-Api $health); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Api $health)) { throw "Dashboard did not answer on 8788 - see .state\dashboard.err" }
  Write-Host "Dashboard API started (PID $($dashboard.Id))"
}

# 3. Fresh bot loop in paper mode (LIVE=true in .env is the only way to go live).
Move-Item (Join-Path $state 'bot.log') (Join-Path $state 'bot.log.1') -Force -ErrorAction SilentlyContinue
$bot = Start-Process $bun -ArgumentList 'run', 'run' -WorkingDirectory $root `
  -RedirectStandardOutput (Join-Path $state 'bot.log') `
  -RedirectStandardError (Join-Path $state 'bot.err') -WindowStyle Hidden -PassThru
$bot.Id | Set-Content $pidFile
Write-Host "Started bot (PID $($bot.Id)). Log: .state\bot.log"

# 4. Vite frontend dev server at :5173
if (-not (Test-Api 'http://localhost:5173/')) {
  Move-Item (Join-Path $state 'vite.log') (Join-Path $state 'vite.log.1') -Force -ErrorAction SilentlyContinue
  $vite = Start-Process $bun -ArgumentList 'run', 'dev' -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $state 'vite.log') `
    -RedirectStandardError (Join-Path $state 'vite.err') -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 40 -and -not (Test-Api 'http://localhost:5173/'); $i++) { Start-Sleep -Milliseconds 250 }
  Write-Host "Vite dashboard started (PID $($vite.Id))"
}

# 5. Open the Vite dashboard console in browser
Start-Process 'http://localhost:5173/'
Write-Host "Opened http://localhost:5173/"
