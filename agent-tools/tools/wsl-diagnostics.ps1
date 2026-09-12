$ErrorActionPreference = "Stop"

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL is not installed or wsl.exe is unavailable."
}

$script = @"
echo '=== SYSTEM ==='
uname -a

echo
echo '=== INTERFACES ==='
ip addr 2>/dev/null || true

echo
echo '=== ROUTES ==='
ip route 2>/dev/null || true

echo
echo '=== SOCKETS ==='
ss -tulpn 2>/dev/null || true

echo
echo '=== DNS ==='
cat /etc/resolv.conf 2>/dev/null || true

echo
echo '=== TOP PROCESSES ==='
ps aux --sort=-%cpu 2>/dev/null | head -20
"@

wsl.exe bash -lc $script
