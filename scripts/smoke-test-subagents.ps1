param(
  [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent",
  [string]$Server = "http://localhost:3001",
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"

$workspaces = Invoke-RestMethod "$Server/api/workspaces" -TimeoutSec 10
$workspace = $workspaces.workspaces |
  Where-Object { $_.rootPath -ieq $RepoRoot } |
  Select-Object -First 1

if (-not $workspace) {
  throw "DacaiLocalAgent workspace is not registered at $RepoRoot."
}

$requests = @(
  @{
    role = "repo-explorer"
    objective = "Read-only smoke test: identify the exact files that implement the coding-agent loop and context manager. Use repository tools and return evidence-backed paths only. Do not modify anything."
  },
  @{
    role = "security-reviewer"
    objective = "Read-only smoke test: inspect the coding-agent permission boundary and identify the exact files/classes that prevent model output from bypassing tool authorization. Do not modify anything and do not test external systems."
  }
)

$taskIds = @()

foreach ($item in $requests) {
  $body = @{
    objective = $item.objective
    workspaceId = $workspace.id
    role = $item.role
    source = "internal"
    maxTurns = 10
  } | ConvertTo-Json -Depth 8

  $submitted = Invoke-RestMethod "$Server/api/tasks" -Method Post -ContentType "application/json" -Body $body
  $taskIds += $submitted.task.id
  Write-Host "Submitted $($item.role): $($submitted.task.id)"
}

Write-Host "Both child tasks were submitted before polling; they are eligible to run concurrently under the existing TaskRunner worker cap."

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$done = @{}

while ((Get-Date) -lt $deadline -and $done.Count -lt $taskIds.Count) {
  foreach ($taskId in $taskIds) {
    if ($done.ContainsKey($taskId)) { continue }

    $response = Invoke-RestMethod "$Server/api/tasks/$taskId" -TimeoutSec 10
    $task = $response.task
    Write-Host "$taskId  status=$($task.status)"

    if ($task.status -in @("completed", "failed", "cancelled")) {
      $done[$taskId] = $task
    }
  }

  if ($done.Count -lt $taskIds.Count) {
    Start-Sleep -Seconds 2
  }
}

if ($done.Count -lt $taskIds.Count) {
  throw "Subagent smoke test timed out. Tasks: $($taskIds -join ', ')"
}

Write-Host ""
foreach ($taskId in $taskIds) {
  $task = $done[$taskId]
  Write-Host "=== $taskId / $($task.status) ==="
  if ($task.result) { Write-Host $task.result }
  if ($task.error) { Write-Host $task.error -ForegroundColor Red }
}

if (@($done.Values | Where-Object { $_.status -ne "completed" }).Count -gt 0) {
  throw "At least one child agent did not complete successfully."
}

Write-Host ""
Write-Host "PARALLEL SUBAGENT SMOKE TEST PASSED." -ForegroundColor Green
