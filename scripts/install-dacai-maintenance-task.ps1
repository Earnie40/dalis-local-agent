param(
  [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent",
  [string]$Time = "02:00"
)

$ErrorActionPreference = "Stop"
$script = Join-Path $RepoRoot "scripts\dacai-maintenance.ps1"
if (-not (Test-Path $script)) { throw "Maintenance script not found: $script" }

$taskName = "DACAIS-Agent-Maintenance"
$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`" -RepoRoot `"$RepoRoot`""
schtasks.exe /Create /F /SC DAILY /ST $Time /TN $taskName /TR $command
if ($LASTEXITCODE -ne 0) { throw "Failed to create Windows scheduled task." }

Write-Host "Installed scheduled task: $taskName at $Time"
Write-Host "The server must be running for maintenance tasks to be submitted."
