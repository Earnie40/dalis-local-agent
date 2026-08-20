param(
  [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent"
)

$ErrorActionPreference = "Stop"
$script = Join-Path $RepoRoot "scripts\ci-watch.ps1"
if (-not (Test-Path $script)) { throw "CI watch script not found: $script" }

$taskName = "DACAIS-CI-Watch"
$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`" -RepoRoot `"$RepoRoot`""
schtasks.exe /Create /F /SC MINUTE /MO 15 /TN $taskName /TR $command
if ($LASTEXITCODE -ne 0) { throw "Failed to create Windows scheduled task." }

Write-Host "Installed $taskName (every 15 minutes)."
Write-Host "By default this only logs. Set DACAI_AUTO_CI_FIX=1 in the task environment before enabling automatic fix submissions."
