#!/usr/bin/env bash
# Owner-requested local security toolkit. Uses the distro's signed repositories.
# Installs CLI packages; it does not change firewall rules or initiate scans.
set -euo pipefail
if [[ "$(id -u)" != 0 ]]; then
  echo 'Run as WSL root: wsl.exe -d Ubuntu-24.04 -u root -- bash scripts/install-security-tools-wsl.sh' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  nmap ncat ndiff tcpdump tshark net-tools iproute2 dnsutils traceroute \
  mtr-tiny socat netcat-openbsd iperf3 ethtool whois openssl openssh-client \
  curl wget jq python3 python3-pip python3-venv masscan arp-scan hping3 \
  nikto sqlmap hydra john hashcat aircrack-ng yara binwalk sleuthkit \
  gdb strace ltrace
dpkg-query -W -f='${binary:Package}\t${Version}\n' \
  nmap ncat ndiff tcpdump tshark net-tools iproute2 dnsutils traceroute \
  mtr-tiny socat netcat-openbsd iperf3 ethtool whois openssl openssh-client \
  curl wget jq python3 python3-pip python3-venv masscan arp-scan hping3 \
  nikto sqlmap hydra john hashcat aircrack-ng yara binwalk sleuthkit \
  gdb strace ltrace
