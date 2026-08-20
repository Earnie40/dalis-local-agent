$ErrorActionPreference = "Stop"
Set-Location "C:\Users\Kyleh\DacaiLocalAgent"

$source = Get-ChildItem "$env:USERPROFILE\Downloads" -Filter "agent-full-codex-upgrade*.json" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $source) {
    throw "agent-full-codex-upgrade.json was not found in Downloads."
}

Copy-Item $source.FullName ".\agent-full-codex-upgrade.json" -Force

Write-Host "Using task:"
Write-Host (Resolve-Path ".\agent-full-codex-upgrade.json")

curl.exe -N `
  -X POST `
  "http://localhost:3001/api/agent/stream" `
  -H "Content-Type: application/json" `
  --data-binary "@agent-full-codex-upgrade.json"
