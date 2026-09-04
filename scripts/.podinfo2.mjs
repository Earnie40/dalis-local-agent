import { readFileSync } from 'node:fs';
const env = {};
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const key = env.RUNPOD_API_KEY, podId = env.RUNPOD_ID;
if (!podId) { console.log('no RUNPOD_ID'); process.exit(1); }
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
try {
  const info = await (await fetch(`https://rest.runpod.io/v1/pods/${podId}`, { headers: H, signal: AbortSignal.timeout(20000) })).json();
  console.log('pod       :', podId);
  console.log('status    :', info.desiredStatus ?? info.status);
  console.log('gpu       :', info.machine?.gpuTypeId ?? info.gpuTypeId ?? '(unknown)');
  console.log('machineId :', info.machineId ?? info.runtime?.machineId ?? '?');
  console.log('uptime    :', (info.uptimeSeconds ?? '?') + 's');
} catch (e) { console.log('API error:', e.message); }