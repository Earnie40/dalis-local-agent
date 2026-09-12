param(
    [Parameter(Mandatory=$true)]
    [string]$Target,

    [ValidateSet("Discovery","Services","Ports")]
    [string]$Mode = "Discovery"
)

$ErrorActionPreference = "Stop"

$PolicyPath = Join-Path $PSScriptRoot "..\policy\authorization.json"

$Policy = Get-Content $PolicyPath -Raw | ConvertFrom-Json

if ($Target -notin $Policy.targets) {
    throw "Target '$Target' is not present in authorization.json. Explicit authorization is required."
}

$nmap = Get-Command nmap.exe -ErrorAction SilentlyContinue

if (-not $nmap) {
    $nmap = Get-Command nmap -ErrorAction SilentlyContinue
}

if (-not $nmap) {
    throw "Nmap is not installed or not available in PATH."
}

switch ($Mode) {

    "Discovery" {
        & $nmap.Source -sn $Target
    }

    "Services" {
        & $nmap.Source -sT -sV --version-light $Target
    }

    "Ports" {
        & $nmap.Source -sT --top-ports 100 $Target
    }
}
