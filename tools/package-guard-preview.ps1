$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$guardRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardFiles = @(
  'LICENSE',
  'README.md',
  'package.json',
  '.gitignore',
  'CHANGELOG.md',
  'doc/PI-GUARD-ANALYSIS.md',
  'doc/OVERHAUL-BRIEF-2026-11-08.md'
)
$guardFiles += @(
  'ai-spend-dashboard-server.js',
  'ai-spend-dashboard-test.js',
  'ai-spend-dashboard.html',
  'checkin-cli.js',
  'subscription-optimizer.js',
  'subscription-optimizer-test.js',
  'export-guard-demo.js',
  'export-guard-snapshot.js',
  'export-history-test.js',
  'export-history.js',
  'export-public-demo.js',
  'preview-public.js',
  'public-demo-test.js',
  'usage-guard-pi-test.js',
  'usage-guard-server.js',
  'usage-guard-test.js',
  'usage-guard.css',
  'usage-guard.html',
  'usage-guard.js',
  'guard-accounting.js',
  'guard-advisor.js',
  'guard-advisor-test.js',
  'guard-continuity-test.js',
  'guard-handoff.js',
  'guard-hooks.js',
  'guard-impact.js',
  'guard-learning.js',
  'guard-native.js',
  'guard-recovery-test.js',
  'guard-rejection.js',
  'guard-rejection-test.js',
  'guard-statusline.js',
  'guard-watchdog.js',
  'guard-watchdog-test.js',
  'record-guard-demo.cjs',
  'render-guard-demo.py',
  'render-harness-gifs.py',
  'usage-collectors.js',
  'usage-collectors-test.js',
  'usage-insights.js',
  'package-guard-preview.ps1'
) | ForEach-Object { 'tools/' + $_ }
$guardFiles += @(
  'index.ts',
  'package.json',
  'README.md',
  'Start-Guard.ps1',
  'Restart-Controller.ps1',
  'test-fixtures/fake-provider.ts',
  'test-fixtures/walkthrough-provider.ts'
) | ForEach-Object { 'integrations/pi/' + $_ }
$guardFiles += 'integrations/native/README.md'
$guardFiles += @(
  'index.html',
  'design.css',
  'guard.html',
  'usage-guard.css',
  'demo-data.json',
  'guard-snapshot.json',
  'demo-agy-swarm.gif',
  'demo-codex-fast.gif',
  'demo-claude-tiers.gif',
  'demo-pi-guard.gif',
  'guard-walkthrough.gif',
  'guard-walkthrough.json',
  'counter.php',
  '.htaccess'
) | ForEach-Object { 'public/' + $_ }
$guardArchivePath = Join-Path $guardRoot 'public/ai-spend-live-guard-preview.zip'
$guardTempArchive = $guardArchivePath + '.tmp'
if (Test-Path -LiteralPath $guardTempArchive) { Remove-Item -LiteralPath $guardTempArchive }
$guardZip = [IO.Compression.ZipFile]::Open($guardTempArchive,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($guardRelative in $guardFiles) {
    $guardSource = [IO.Path]::GetFullPath((Join-Path $guardRoot $guardRelative))
    if (!$guardSource.StartsWith($guardRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Source is outside the repository' }
    $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($guardZip,$guardSource,$guardRelative,[IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $guardZip.Dispose() }
Move-Item -LiteralPath $guardTempArchive -Destination $guardArchivePath -Force
Write-Output "Packaged $($guardFiles.Count) explicitly selected source files. No runtime, auth, session or private state directories are included."
