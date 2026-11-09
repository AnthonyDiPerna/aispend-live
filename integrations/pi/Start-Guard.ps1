param(
  [string]$ProjectPath = (Get-Location).Path,
  [string]$RuntimeDirectory,
  [string]$BridgeDirectory,
  [string]$AgentDirectory,
  [string]$StateDirectory,
  [switch]$Resume,
  [switch]$ListModels
)
$ErrorActionPreference = 'Stop'
$guardRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (!$RuntimeDirectory) { $RuntimeDirectory = Join-Path $guardRepo '.guard-runtime' }
if (!$BridgeDirectory) { $BridgeDirectory = Join-Path $RuntimeDirectory 'pi-claude-code' }
if (!$AgentDirectory) { $AgentDirectory = Join-Path $guardRepo '.guard-data/pi-agent' }
if (!$StateDirectory) { $StateDirectory = Join-Path $guardRepo '.guard-data/controller' }
$guardCli = Join-Path $RuntimeDirectory 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
$guardBridge = Join-Path $BridgeDirectory 'src/index.ts'
if (!(Test-Path -LiteralPath $guardCli) -or !(Test-Path -LiteralPath $guardBridge)) {
  throw 'Install the pinned Pi runtime and official Claude bridge first. See integrations/pi/README.md.'
}
$null = New-Item -ItemType Directory -Force -Path $AgentDirectory,$StateDirectory
$guardSettings = Join-Path $AgentDirectory 'settings.json'
if (!(Test-Path -LiteralPath $guardSettings)) {
  [IO.File]::WriteAllText($guardSettings, '{"defaultProvider":"aispend","defaultModel":"guard","defaultThinkingLevel":"medium","cacheWarming":"off","retry":{"enabled":false},"compaction":{"enabled":false}}')
}
$env:PI_CODING_AGENT_DIR = $AgentDirectory
$env:AI_SPEND_GUARD_URL = 'http://127.0.0.1:9021'
$env:AI_SPEND_GUARD_ARTIFACTS = Join-Path $StateDirectory 'artifacts'
$guardHealth = $null
try { $guardHealth = Invoke-RestMethod -Uri "$env:AI_SPEND_GUARD_URL/health" -TimeoutSec 2 } catch { }
if ($guardHealth -and ($guardHealth.name -ne 'ai-spend-guard' -or $guardHealth.demo)) { throw 'Port 9021 is occupied by another service or a demo controller.' }
if (!$guardHealth) {
  $guardServer = Join-Path $guardRepo 'tools/usage-guard-server.js'
  $guardArguments = @('"' + $guardServer + '"', '--port', '9021', '--state-dir', '"' + $StateDirectory + '"')
  $null = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $guardArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDirectory 'server.log') -RedirectStandardError (Join-Path $StateDirectory 'server-error.log')
  for ($guardAttempt = 0; $guardAttempt -lt 20; $guardAttempt++) {
    Start-Sleep -Milliseconds 200
    try { $guardHealth = Invoke-RestMethod -Uri "$env:AI_SPEND_GUARD_URL/health" -TimeoutSec 1; break } catch { }
  }
  if (!$guardHealth) { throw 'The controller did not start. Inspect server-error.log in the state directory.' }
}
$guardArgs = @($guardCli, '--no-extensions', '-e', $guardBridge, '-e', (Join-Path $PSScriptRoot 'index.ts'), '--model', 'aispend/guard')
if ($ListModels) { $guardArgs += '--list-models' }
elseif ($Resume) { $guardArgs += '--continue' }
Write-Host 'AI Spend Guard: http://127.0.0.1:9021 · /guard to connect · /guard-hold to stop automatic resumption'
Push-Location -LiteralPath $ProjectPath
try { & node.exe @guardArgs } finally { Pop-Location }
