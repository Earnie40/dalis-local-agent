<#
.SYNOPSIS
    Passive public-record lookup for the DACAIS local-agent skill pack
    (skill family: osint.public.lookup).

.DESCRIPTION
    Resolves public records for a domain or IP that the user is authorized to
    research: forward DNS, reverse DNS, and (when a whois client is available)
    registration/allocation data. These are passive queries against public
    resolvers and registries -- the tool sends no traffic that probes, scans,
    or authenticates to the target itself.

    Read-only and logged. It does NOT locate people or devices, and it is not
    a substitute for the authorized active-discovery tool (nmap-authorized),
    which remains allowlist-gated.
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Target,

    # Record types to resolve for a domain.
    [string[]]$Types = @("A", "AAAA", "MX", "TXT", "NS", "CNAME")
)

$ErrorActionPreference = "Stop"

$isIp = [System.Net.IPAddress]::TryParse($Target, [ref]([System.Net.IPAddress]$null))

Write-Output "OBSERVATION: osint-lookup"
Write-Output "target : $Target"
Write-Output ("kind   : {0}" -f $(if ($isIp) { 'ip-address' } else { 'domain' }))
Write-Output ("-" * 60)

# --- Forward DNS (domain) ----------------------------------------------------
if (-not $isIp) {
    Write-Output "FORWARD DNS:"
    foreach ($t in $Types) {
        try {
            $records = Resolve-DnsName -Name $Target -Type $t -ErrorAction Stop 2>$null
            foreach ($r in $records) {
                $val = $r.IPAddress ?? $r.NameHost ?? $r.NameExchange ?? ($r.Strings -join ' ') ?? $r.NameTarget
                if ($val) { Write-Output ("  {0,-6} {1}" -f $t, $val) }
            }
        }
        catch {
            Write-Output ("  {0,-6} (no record / not resolvable)" -f $t)
        }
    }
    Write-Output ""
}

# --- Reverse DNS (ip) --------------------------------------------------------
if ($isIp) {
    Write-Output "REVERSE DNS:"
    try {
        $ptr = Resolve-DnsName -Name $Target -Type PTR -ErrorAction Stop 2>$null
        foreach ($r in $ptr) { if ($r.NameHost) { Write-Output ("  PTR    {0}" -f $r.NameHost) } }
    }
    catch {
        Write-Output "  (no PTR record)"
    }
    Write-Output ""
}

# --- WHOIS (best-effort, passive) --------------------------------------------
Write-Output "WHOIS:"
$whois = Get-Command whois -ErrorAction SilentlyContinue
if ($whois) {
    & $whois.Source $Target 2>$null | Select-Object -First 60
}
elseif (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    $has = (wsl.exe -e bash -lc "command -v whois" 2>$null)
    if ($has) {
        wsl.exe -e bash -lc "whois '$Target'" 2>$null | Select-Object -First 60
    }
    else {
        Write-Output "  (no whois client found; install with: wsl -e sudo apt install -y whois)"
    }
}
else {
    Write-Output "  (no whois client found on Windows or WSL)"
}

Write-Output ""
Write-Output "CONFIDENCE: passive public-record observations only (no active probing)."
