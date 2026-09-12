import { mkdir, writeFile } from 'node:fs/promises';
import { shellRunTool } from '../packages/tools/src/shell-tools';
import { wslRunTool } from '../packages/tools/src/wsl-tools';
import { networkNmapTool, systemPrivilegesTool } from '../packages/tools/src/security-tools';

const ctx = { workspaceRoot: process.cwd() };
const checks: Record<string, unknown> = {};
const privileges = await systemPrivilegesTool.execute({}, ctx) as { elevated: boolean };
checks.privileges = privileges;
const calls = [
  ['powershell', shellRunTool, { shell: 'powershell', command: 'Write-Output (6 * 7)' }],
  ['cmd', shellRunTool, { shell: 'cmd', command: 'echo CMD_READY' }],
  ['nmap', networkNmapTool, { args: ['-sT', '-Pn', '-p', '3001', '127.0.0.1'] }],
  ['wslRoot', wslRunTool, { distro: 'Ubuntu-24.04', user: 'root', command: 'id -u' }],
  ['wslQuoting', wslRunTool, { distro: 'Ubuntu-24.04', user: 'root', command: 'value="spaces and café"\nprintf "%s\\n" "$value"' }],
  ['wslRawScan', wslRunTool, { distro: 'Ubuntu-24.04', user: 'root', command: 'nmap -sS -Pn -p 22 127.0.0.1' }],
  ['toolkit', wslRunTool, { distro: 'Ubuntu-24.04', user: 'root', command:
    'for tool in nmap ncat ndiff tcpdump tshark ip ss netstat dig traceroute mtr socat nc iperf3 ethtool whois openssl ssh curl wget jq python3 masscan arp-scan hping3 nikto sqlmap hydra john hashcat aircrack-ng yara binwalk fls gdb strace ltrace; do command -v "$tool" || exit 1; done' }],
] as const;
let passed = !process.argv.includes('--require-admin') || privileges.elevated;
for (const [name, tool, input] of calls) {
  const result = await tool.execute(input, ctx) as { exitCode: number; stdout: string };
  checks[name] = result;
  const outputMatches = name === 'powershell' ? result.stdout.trim() === '42'
    : name === 'cmd' ? result.stdout.trim() === 'CMD_READY'
      : name === 'wslRoot' ? result.stdout.trim() === '0'
        : name === 'wslQuoting' ? result.stdout.trim() === 'spaces and café'
        : name === 'nmap' || name === 'wslRawScan' ? result.stdout.includes('Nmap done:') : true;
  passed &&= result.exitCode === 0 && outputMatches;
}
await mkdir('.dacai/runtime', { recursive: true });
await writeFile('.dacai/runtime/host-access-verification.json', JSON.stringify({ at: new Date().toISOString(), passed, checks }, null, 2));
console.log(JSON.stringify({ passed, elevated: privileges.elevated, checks }, null, 2));
if (!passed) process.exitCode = 1;
