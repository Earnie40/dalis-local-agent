param(
  [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent"
)

$ErrorActionPreference = "Stop"

$LogDirectory = Join-Path $RepoRoot ".dacai\logs"
$LogFile = Join-Path $LogDirectory "repository-intelligence.log"

New-Item -ItemType Directory -Force $LogDirectory | Out-Null

function Write-Log {
  param([string]$Message)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$timestamp $Message" |
    Out-File $LogFile -Append -Encoding utf8
}

try {
  Write-Log "Repository intelligence refresh started."

  Push-Location "$RepoRoot\packages\repository-index"

  node `
    --env-file="$RepoRoot\.env" `
    --import tsx `
    src\run-index.ts |
    Out-File $LogFile -Append -Encoding utf8

  node `
    --env-file="$RepoRoot\.env" `
    --import tsx `
    src\run-symbol-embeddings.ts |
    Out-File $LogFile -Append -Encoding utf8

  node `
    --env-file="$RepoRoot\.env" `
    --import tsx `
    src\run-architecture-map.ts |
    Out-File $LogFile -Append -Encoding utf8

  Write-Log "Repository intelligence refresh completed."
}
catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  throw
}
finally {
  Pop-Location
}
