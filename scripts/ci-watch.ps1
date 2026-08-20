param(
  [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent",
  [string]$Server = "http://localhost:3001"
)

$ErrorActionPreference = "Continue"
Set-Location $RepoRoot
$logDir = Join-Path $RepoRoot ".dacai\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir "ci-watch.log"

$checks = & gh pr checks 2>&1
$code = $LASTEXITCODE
Add-Content $log "$(Get-Date -Format o) gh pr checks exit=$code`n$checks"

if ($code -eq 0) { exit 0 }
if ($env:DACAI_AUTO_CI_FIX -ne "1") {
  Add-Content $log "$(Get-Date -Format o) CI is not green; automatic remediation disabled (set DACAI_AUTO_CI_FIX=1 to enable)."
  exit 0
}

try {
  $workspaces = Invoke-RestMethod "$Server/api/workspaces" -TimeoutSec 5
  $workspace = $workspaces.workspaces | Where-Object { $_.rootPath -ieq $RepoRoot } | Select-Object -First 1
  if (-not $workspace) { throw "workspace not registered" }

  $body = @{
    objective = "CI checks for the current branch are not green. Inspect the exact GitHub check evidence with gh when available, reproduce locally, fix the root cause, and validate. Do not push or open a PR automatically."
    workspaceId = $workspace.id
    role = "ci-fixer"
    source = "internal"
  } | ConvertTo-Json -Depth 8
  $task = Invoke-RestMethod "$Server/api/tasks" -Method Post -ContentType "application/json" -Body $body
  Add-Content $log "$(Get-Date -Format o) submitted ci-fixer task $($task.task.id)"
} catch {
  Add-Content $log "$(Get-Date -Format o) failed to submit ci-fixer: $($_.Exception.Message)"
}
