# Host shells and security tools

The DACAIS server executes tools on this Windows machine; the RTX PRO 6000
provides model inference. RunPod inference does not give the pod access to a
Windows Administrator token.

The owner requested general Windows and WSL administration and security tools.
`shell.run` now accepts `shell: "powershell"` or `shell: "cmd"`, returning the
command's stdout, stderr and exit status. `wsl.run` accepts `user: "root"` for
Linux administration and remains available on Windows independently of prompt
wording. Omitting the shell or Linux user preserves the previous default.
These commands can run installed executables, install additional software,
manage services, inspect ports, and configure networking using the selected
OS account's privileges.

`system.privileges` measures Windows Administrator status. `system.network.nmap`
accepts an argument array for all installed native Nmap options, including NSE,
UDP, service/OS discovery, and output reports. Linux tools are available through
`wsl.run`. Existing workspace permissions, process timeouts, output redaction and
the configured approval policy still apply. This change adds no topic or target
allowlist. Legacy `agent-tools` wrappers retain their separate configuration;
they are not required to use the direct runtime tools.

RunPod access is exposed directly to normal agent runs as
`infrastructure.runpod.status`, `infrastructure.runpod.preflight`,
`infrastructure.gpu-routing`, and `infrastructure.runpod.reconnect`. The first
three report live connection, account/pod and routing evidence. Reconnect may
restart the existing pod-side Ollama service and rebuild its local tunnel, so it
is disclosed and classified as a mutation. It does not create or start a stopped
pod. All four reuse the server-side connection and never place RunPod credentials
in model context or tool arguments.

## Windows Administrator

From the checkout, run:

```powershell
powershell.exe -NoProfile -File scripts/Start-DacaiAdmin.ps1
```

Windows displays its UAC prompt. With `-ReplaceProcessId <pid>`, the launcher
first checks that the PID belongs to this checkout's Node server/watch process,
then stops that process tree only after elevation succeeds. Omit it when no
server is running. `-CheckOnly` validates paths and reports current privileges.
The launcher records the new PID in `.dacai/runtime/admin-startup.json` and keeps
timestamped stdout/stderr logs. This is an elevated local server session; it does
not install a startup service or alter UAC. New Windows shells inherit the
server's token. WSL root is separate and is selected with `user: "root"`.

## Installed WSL toolkit

`scripts/install-security-tools-wsl.sh` installs the following through Ubuntu's
configured signed package repositories, and prints package versions:

| Purpose | Tools |
| --- | --- |
| Discovery and ports | Nmap, Ncat, Ndiff, Masscan, arp-scan, hping3 |
| Packets and protocols | tcpdump, TShark, Aircrack-ng |
| Interfaces, routing, DNS | iproute2, net-tools, dnsutils, traceroute, MTR, ethtool, whois |
| Connections and transport | socat, netcat, iperf3, OpenSSH, OpenSSL, curl, wget |
| Security assessment | Nikto, sqlmap, Hydra, John, Hashcat |
| Analysis and forensics | YARA, Binwalk, Sleuth Kit, GDB, strace, ltrace |
| Automation | Python, pip, venv, jq |

Raw packet capture, wireless work, and GPU acceleration depend on the actual
drivers/devices exposed to Windows or WSL. Installing a tool does not establish
hardware support. This is a broad installed toolkit, not every security product
in existence; arbitrary additional tools remain accessible through the shells.

## Verification

```powershell
node --import tsx scripts/verify-host-access.mts
# In the elevated session:
node --import tsx scripts/verify-host-access.mts --require-admin
```

Checks actual PowerShell and CMD output, native Nmap on Windows localhost,
WSL root UID, a Linux localhost SYN scan, and availability of the listed CLI
tools. Results are written to `.dacai/runtime/host-access-verification.json`.
These checks do not scan external networks or certify every tool's functionality.
