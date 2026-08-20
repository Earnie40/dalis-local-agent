param(
  [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent",
  [string]$Server = "http://localhost:3001"
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

$pkgPath = Join-Path $RepoRoot "packages\repository-index\package.json"
if (-not (Test-Path $pkgPath)) {
  throw "Existing packages\repository-index was not found. This parity pack intentionally does not create a duplicate indexer."
}

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$candidates = @("index", "reindex", "index:repo", "index:repository")
$ran = $false

foreach ($name in $candidates) {
  if ($pkg.scripts.PSObject.Properties.Name -contains $name) {
    Write-Host "Running existing repository-index package script: $name"
    pnpm --filter "@dacai-local-agent/repository-index" run $name
    if ($LASTEXITCODE -eq 0) { $ran = $true; break }
  }
}

if (-not $ran) {
  $cliCandidates = @(
    ".\packages\repository-index\src\cli.ts",
    ".\packages\repository-index\src\index-repository.ts",
    ".\scripts\index-repository.ts",
    ".\scripts\index-repository.mjs"
  )
  foreach ($candidate in $cliCandidates) {
    if (Test-Path $candidate) {
      Write-Host "Running existing index entrypoint: $candidate"
      if ($candidate.EndsWith(".mjs")) {
        node $candidate $RepoRoot
      } else {
        pnpm exec tsx $candidate $RepoRoot
      }
      if ($LASTEXITCODE -eq 0) { $ran = $true; break }
    }
  }
}

if (-not $ran) {
  Write-Host ""
  Write-Host "No conventional CLI/script was exposed by packages/repository-index."
  Write-Host "Using the now-functional local coding agent to inspect that EXISTING package and invoke its real entrypoint."
  Write-Host "It is explicitly forbidden from creating another indexer."

  $workspaces = Invoke-RestMethod "$Server/api/workspaces"
  $workspace = $workspaces.workspaces | Where-Object { $_.rootPath -ieq $RepoRoot } | Select-Object -First 1
  if (-not $workspace) { throw "DacaiLocalAgent workspace is not registered or server is not running." }

  $body = @{
    role = "coding"
    workspaceId = $workspace.id
    maxTurns = 40
    maxToolCalls = 80
    reasoningMode = "deep"
    prompt = @"
INDEX THE CURRENT REPOSITORY USING THE EXISTING packages/repository-index IMPLEMENTATION.

Repository: $RepoRoot

Do not create another indexer, vector database, or repository table.
Inspect packages/repository-index first and discover its actual public/CLI/runtime entrypoint.
Run the existing indexing path against this repository.
Then verify PostgreSQL counts for repositories, repository_files, code_symbols, and symbol_edges.
Verify code_symbols embedding dimensions are 768 when embeddings exist.
Do not stop after describing the indexer. Actually invoke it.
TASK_COMPLETE only after execution and database evidence.
"@
  } | ConvertTo-Json -Depth 10

  $tmp = Join-Path $env:TEMP "dacai-index-repo.json"
  [IO.File]::WriteAllText($tmp, $body, [Text.UTF8Encoding]::new($false))
  curl.exe -N -X POST "$Server/api/agent/stream" -H "Content-Type: application/json" --data-binary "@$tmp"
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Repository index verification ==="
pnpm exec tsx .\scripts\verify-repository-index.ts
if ($LASTEXITCODE -ne 0) {
  throw "Repository index still does not contain the required rows. Inspect the indexing run above."
}
Write-Host "REPOSITORY INDEX VERIFIED." -ForegroundColor Green
