param(
    [Parameter(Mandatory=$true)]
    [ValidateSet(
        "windows-diagnostics",
        "network-diagnostics",
        "wsl-diagnostics",
        "nmap-authorized",
        "ssh-readonly",
        "local-find",
        "osint-lookup"
    )]
    [string]$Tool,

    [string]$Target,
    [string]$Mode = "Discovery",
    [string]$HostName,
    [string]$User,
    [string]$Check = "System",

    # local-find
    [string]$Path,
    [string]$Name,
    [string]$Content,
    [int]$MaxResults = 200,
    [int]$MaxDepth = 25,

    # osint-lookup
    [string[]]$Types = @("A", "AAAA", "MX", "TXT", "NS", "CNAME")
)

$ErrorActionPreference = "Stop"

$LogDir = Join-Path $PSScriptRoot "..\logs"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force $LogDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log = Join-Path $LogDir "$timestamp-$Tool.log"

function Invoke-AndLog {

    param(
        [scriptblock]$Action
    )

    try {

        $output = & $Action 2>&1

        $output | Tee-Object -FilePath $log

    }
    catch {

        $_ | Out-String | Tee-Object -FilePath $log
        throw
    }
}

switch ($Tool) {

    "windows-diagnostics" {

        Invoke-AndLog {
            & "$PSScriptRoot\windows-diagnostics.ps1"
        }
    }

    "network-diagnostics" {

        Invoke-AndLog {
            & "$PSScriptRoot\network-diagnostics.ps1" `
                -HostName $HostName
        }
    }

    "wsl-diagnostics" {

        Invoke-AndLog {
            & "$PSScriptRoot\wsl-diagnostics.ps1"
        }
    }

    "nmap-authorized" {

        if (-not $Target) {
            throw "Target is required."
        }

        Invoke-AndLog {
            & "$PSScriptRoot\nmap-authorized.ps1" `
                -Target $Target `
                -Mode $Mode
        }
    }

    "ssh-readonly" {

        if (-not $HostName -or -not $User) {
            throw "HostName and User are required."
        }

        Invoke-AndLog {
            & "$PSScriptRoot\ssh-readonly.ps1" `
                -HostName $HostName `
                -User $User `
                -Check $Check
        }
    }

    "local-find" {

        if (-not $Path) {
            throw "Path is required."
        }

        Invoke-AndLog {
            & "$PSScriptRoot\local-find.ps1" `
                -Path $Path `
                -Name $Name `
                -Content $Content `
                -MaxResults $MaxResults `
                -MaxDepth $MaxDepth
        }
    }

    "osint-lookup" {

        if (-not $Target) {
            throw "Target is required."
        }

        Invoke-AndLog {
            & "$PSScriptRoot\osint-lookup.ps1" `
                -Target $Target `
                -Types $Types
        }
    }
}
