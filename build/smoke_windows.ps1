$ErrorActionPreference = 'Stop'
$installer = (Get-ChildItem dist/PigeonPal-Setup-*-x64.exe | Select-Object -First 1).FullName
if (-not $installer) { throw 'Installer missing' }
$installDir = Join-Path $env:RUNNER_TEMP 'pigeonpal-installed'
$process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Installer failed' }
$exe = Join-Path $installDir 'PigeonPal.exe'
if (-not (Test-Path $exe)) { throw 'Installed executable missing' }
$process = Start-Process -FilePath $exe -ArgumentList '--offline' -PassThru
try {
  $deadline = (Get-Date).AddSeconds(40)
  do {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) { throw 'Installed application exited before creating a window' }
  } until ($process.MainWindowHandle -ne 0 -or (Get-Date) -ge $deadline)
  if ($process.MainWindowHandle -eq 0) { throw 'Installed UI did not create a window' }
  $children = @(Get-CimInstance Win32_Process -Filter "Name='PigeonPalService.exe'" | Where-Object { $_.ParentProcessId -eq $process.Id })
  if ($children.Count -ne 1) { throw 'Expected exactly one owned backend' }
  # Force parent death: pipe EOF must stop child, not leave locks/orphan processes.
  Stop-Process -Id $process.Id -Force
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Process -Id $children[0].ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Get-Process -Id $children[0].ProcessId -ErrorAction SilentlyContinue) { throw 'Backend survived forced parent exit' }
} finally { if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } }
Write-Output 'Installed Windows app: window/backend/forced parent shutdown passed. Interactive toasts still require a signed-in user acceptance check.'
