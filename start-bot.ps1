# Starts the paper trading loop in the background. Safe to call twice:
# a live PID in .state\bot.pid means a bot is already running.
$root = $PSScriptRoot
$state = Join-Path $root '.state'
$pidFile = Join-Path $state 'bot.pid'

if (Test-Path $pidFile) {
  $existing = Get-Process -Id (Get-Content $pidFile) -ErrorAction SilentlyContinue
  if ($existing) { Write-Host "Bot already running (PID $($existing.Id))"; exit 0 }
}

New-Item -ItemType Directory -Force -Path $state | Out-Null
$p = Start-Process bun -ArgumentList 'run', 'run' -WorkingDirectory $root `
  -RedirectStandardOutput (Join-Path $state 'bot.log') `
  -RedirectStandardError (Join-Path $state 'bot.err') `
  -WindowStyle Hidden -PassThru
$p.Id | Set-Content $pidFile
Write-Host "Started bot (PID $($p.Id)). Log: .state\bot.log"
