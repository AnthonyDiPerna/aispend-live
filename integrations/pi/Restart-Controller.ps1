param([string]$StateDirectory)
# Stop the Guard controller on port 9021 and start it again, hidden, with the same state directory.
# Close or pause Pi windows first: a request in flight during the restart is settled as failed.
$ErrorActionPreference = 'Stop'
$guardRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (!$StateDirectory) { $StateDirectory = Join-Path $guardRepo '.guard-data/controller' }
$listener = Get-NetTCPConnection -LocalPort 9021 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) { Stop-Process -Id $listener.OwningProcess -Force; Start-Sleep -Seconds 1 }
$server = Join-Path $guardRepo 'tools/usage-guard-server.js'
$null = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('"' + $server + '"', '--port', '9021', '--state-dir', '"' + $StateDirectory + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDirectory 'server.log') -RedirectStandardError (Join-Path $StateDirectory 'server-error.log')
for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 250; try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:9021/health' -TimeoutSec 1; break } catch { } }
if (!$h) { throw 'The controller did not come back. Inspect server-error.log in the state directory.' }
Write-Host 'AI Spend Guard restarted on http://127.0.0.1:9021'
