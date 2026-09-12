param(
    [Parameter(Mandatory=$true)]
    [string]$HostName,

    [Parameter(Mandatory=$true)]
    [string]$User,

    [ValidateSet(
        "System",
        "Uptime",
        "Disk",
        "Memory",
        "Processes",
        "Network"
    )]
    [string]$Check = "System"
)

$ErrorActionPreference = "Stop"

$PolicyPath = Join-Path $PSScriptRoot "..\policy\authorization.json"
$Policy = Get-Content $PolicyPath -Raw | ConvertFrom-Json

if ($HostName -notin $Policy.ssh_hosts) {
    throw "SSH host '$HostName' is not in the authorization allowlist."
}

if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw "OpenSSH client is not installed or unavailable."
}

switch ($Check) {

    "System" {
        $Command = "uname -a"
    }

    "Uptime" {
        $Command = "uptime"
    }

    "Disk" {
        $Command = "df -h"
    }

    "Memory" {
        $Command = "free -h"
    }

    "Processes" {
        $Command = "ps aux --sort=-%cpu | head -25"
    }

    "Network" {
        $Command = "ip addr; echo; ip route; echo; ss -tulpn"
    }
}

ssh "$User@$HostName" $Command
