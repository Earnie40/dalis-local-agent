<#
.SYNOPSIS
    Read-only local finder for the DACAIS local-agent skill pack
    (skill family: local.filesystem.find).

.DESCRIPTION
    Locates files by name/glob and locates text inside files under a
    caller-specified path on THIS machine only. It never modifies, deletes,
    moves, or opens files for writing, and performs no network activity.

    Bounded by MaxResults and MaxDepth so an over-broad query cannot run away.
    Prefers ripgrep (rg) for content search when available, otherwise falls
    back to Select-String.

    Honours the agent Security Boundary in SKILLS.md: it operates only on the
    local computer and the path the user points it at.
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$Name,

    [string]$Content,

    [int]$MaxResults = 200,

    [int]$MaxDepth = 25
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path)) {
    throw "Search root does not exist: $Path"
}

$root = (Resolve-Path -LiteralPath $Path).Path

Write-Output "OBSERVATION: local-find"
Write-Output "root      : $root"
Write-Output ("name      : {0}" -f $(if ($Name) { $Name } else { '(any)' }))
Write-Output ("content   : {0}" -f $(if ($Content) { $Content } else { '(none)' }))
Write-Output "maxResults: $MaxResults"
Write-Output ("-" * 60)

# --- Phase 1: locate files by name/glob -------------------------------------
$filter = if ($Name) { $Name } else { "*" }

$files = Get-ChildItem -LiteralPath $root -Recurse -File -Filter $filter -Depth $MaxDepth -ErrorAction SilentlyContinue |
    Select-Object -First $MaxResults

if (-not $Content) {
    Write-Output ("FILES MATCHING NAME ({0} shown, cap {1}):" -f $files.Count, $MaxResults)
    foreach ($f in $files) {
        Write-Output ("{0,12:N0}  {1}" -f $f.Length, $f.FullName)
    }
    Write-Output ""
    Write-Output "CONFIDENCE: complete for this root up to the result cap."
    return
}

# --- Phase 2: locate content inside files -----------------------------------
Write-Output "SEARCHING CONTENT for pattern: $Content"
Write-Output ""

$rg = Get-Command rg -ErrorAction SilentlyContinue
if ($rg) {
    $rgArgs = @("--no-heading", "--line-number", "--color", "never", "--max-count", "20")
    if ($Name) { $rgArgs += @("--glob", $Name) }
    $rgArgs += @($Content, $root)
    & $rg.Source @rgArgs 2>$null | Select-Object -First $MaxResults
}
else {
    $files |
        Select-String -Pattern $Content -List -ErrorAction SilentlyContinue |
        Select-Object -First $MaxResults |
        ForEach-Object { Write-Output ("{0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line.Trim()) }
}

Write-Output ""
Write-Output "CONFIDENCE: content matches above are direct observations (read-only)."
