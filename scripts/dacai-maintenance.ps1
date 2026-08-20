param(
  [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent",
  [string]$Server = "http://localhost:3001"
)

$ErrorActionPreference = "Stop"
$logDir = Join-Path $RepoRoot ".dacai\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir "maintenance.log"

function Log([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -Path $log -Value $line
  Write-Host $line
}

try {
  $workspaces = Invoke-RestMethod "$Server/api/workspaces" -TimeoutSec 5
} catch {
  Log "Server unavailable; maintenance skipped."
  exit 0
}

$workspace = $workspaces.workspaces | Where-Object { $_.rootPath -ieq $RepoRoot } | Select-Object -First 1
if (-not $workspace) {
  Log "Workspace not registered; maintenance skipped."
  exit 0
}

$jobs = @(
  @{
    role = "repo-explorer"
    objective = "Review the repository for stale TODO/FIXME markers, dead-looking integration seams, and documentation that no longer matches code. Read-only. Return only evidence-backed items."
  },
  @{
    role = "security-reviewer"
    objective = "Perform a bounded defensive hypothesis review of recent repository changes. Use only local repository/test evidence. Do not test public targets. Return confirmed issues and rejected hypotheses separately."
  }
)

foreach ($job in $jobs) {
  $body = @{
    objective = $job.objective
    workspaceId = $workspace.id
    role = $job.role
    source = "internal"
  } | ConvertTo-Json -Depth 8

  try {
    $result = Invoke-RestMethod "$Server/api/tasks" -Method Post -ContentType "application/json" -Body $body
    Log "Submitted $($job.role) task $($result.task.id)"
  } catch {
    Log "Failed to submit $($job.role): $($_.Exception.Message)"
  }
}
