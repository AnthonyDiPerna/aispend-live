$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$guardRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardFiles = @('LICENSE','README.md','package.json','.gitignore','doc/PI-GUARD-ANALYSIS.md','CHANGELOG.md')
$guardFiles += @('ai-spend-dashboard-server.js','ai-spend-dashboard-test.js','ai-spend-dashboard.html','export-guard-demo.js','export-history-test.js','export-history.js','export-public-demo.js','preview-public.js','public-demo-test.js','usage-guard-pi-test.js','usage-guard-server.js','usage-guard-test.js','usage-guard.css','usage-guard.html','usage-guard.js','guard-advisor.js','guard-advisor-test.js','guard-handoff.js','record-guard-demo.cjs','render-guard-demo.py','guard-accounting.js','guard-statusline.js','usage-collectors.js','usage-collectors-test.js','usage-insights.js','package-guard-preview.ps1') | ForEach-Object { 'tools/' + $_ }
$guardFiles += @('index.ts','package.json','README.md','Start-Guard.ps1','test-fixtures/fake-provider.ts','test-fixtures/walkthrough-provider.ts') | ForEach-Object { 'integrations/pi/' + $_ }
$guardFiles += @('index.html','design.css','guard.html','usage-guard.css','demo-data.json','guard-walkthrough.gif','guard-walkthrough.json') | ForEach-Object { 'public/' + $_ }
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
