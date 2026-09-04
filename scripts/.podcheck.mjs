import { readFileSync } from 'node:fs';
const env = {};
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const key = env.RUNPOD_API_KEY, podId = 'zxz7yhf6t18knm';
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
try {
  const info = await (await fetch(`https://rest.runpod.io/v1/pods/${podId}`, { headers: H, signal: AbortSignal.timeout(20000) })).json();
  console.log('status   :', info.desiredStatus ?? info.status);
  console.log('gpu      :', info.machine?.gpuTypeId ?? info.gpuTypeId ?? '(unknown)');
  console.log('uptime   :', (info.uptimeSeconds ?? '?') + 's');
  console.log('machineId:', info.machineId ?? info.machine?.id ?? info.runtime?.machineId ?? '?');
} catch (e) { console.log('API error:', e.message); }