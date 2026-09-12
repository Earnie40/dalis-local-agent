param(
    [int]$ReplaceProcessId = 0,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$EntryPoint = Join-Path $RepoRoot 'apps\server\src\index.ts'
if (-not (Test-Path $EntryPoint)) { throw 'DACAIS server entry point is missing.' }
$IsAdmin = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($ReplaceProcessId -gt 0) {
    $Existing = Get-CimInstance Win32_Process -Filter "ProcessId = $ReplaceProcessId"
    if ($Existing -and ($Existing.Name -ne 'node.exe' -or -not $Existing.CommandLine.Contains($RepoRoot))) {
        throw 'Replacement PID is not a Node process belonging to this DACAIS checkout.'
    }
}
if ($CheckOnly) {
    [pscustomobject]@{ elevated = $IsAdmin; node = $NodePath; entryPoint = $EntryPoint; replaceProcessId = $ReplaceProcessId } | ConvertTo-Json
    exit 0
}

if (-not $IsAdmin) {
    # The owner requested Windows administration. Use the OS UAC prompt; this
    # script does not change UAC, credentials, services, or scheduled tasks.
    $QuotedScript = $PSCommandPath.Replace("'", "''")
    $Launch = "& '$QuotedScript' -ReplaceProcessId $ReplaceProcessId"
    $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Launch))
    $Elevated = Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-EncodedCommand', $Encoded) -PassThru
    # Wait for the launcher only: Start-Process -Wait would also wait for the
    # long-running server descendant and never return after successful startup.
    $Elevated.WaitForExit()
    exit $Elevated.ExitCode
}

$RuntimeDir = Join-Path $RepoRoot '.dacai\runtime'
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$StdoutLog = Join-Path $RuntimeDir "admin-server-$Stamp.stdout.log"
$StderrLog = Join-Path $RuntimeDir "admin-server-$Stamp.stderr.log"

# Stop the explicitly selected old server/watch tree only after UAC succeeds.
if ($ReplaceProcessId -gt 0 -and (Get-Process -Id $ReplaceProcessId -ErrorAction SilentlyContinue)) {
    & taskkill.exe /PID $ReplaceProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the selected previous DACAIS server.' }
}
Set-Location $RepoRoot
$Server = Start-Process -FilePath $NodePath -ArgumentList @('--import', 'tsx', 'apps/server/src/index.ts') `
    -WorkingDirectory $RepoRoot -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -PassThru
Start-Sleep -Seconds 3
$Server.Refresh()
if ($Server.HasExited) { throw "Elevated server exited. Inspect $StderrLog" }
[pscustomobject]@{
    serverPid = $Server.Id
    elevated = $IsAdmin
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    stdout = $StdoutLog
    stderr = $StderrLog
} | ConvertTo-Json | Set-Content (Join-Path $RuntimeDir 'admin-startup.json')
