import { readFileSync } from 'node:fs';
const env = {};
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const key = env.RUNPOD_API_KEY, podId = 'zxz7yhf6t18knm';
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
async function podStatus() {
  const info = await (await fetch(`https://rest.runpod.io/v1/pods/${podId}`, { headers: H, signal: AbortSignal.timeout(20000) })).json();
  return { status: info.desiredStatus ?? info.status, gpu: info.machine?.gpuTypeId ?? info.gpuTypeId ?? '?', id: info.machineId ?? info.runtime?.machineId ?? '?' };
}
const pollMs = 15_000, maxPolls = 20;
let current = await podStatus();
console.log('initial:', current.status, 'on', current.id);
for (let i = 1; i <= maxPolls; i++) {
  if (current.status !== 'RUNNING') {
    const r = await fetch(`https://rest.runpod.io/v1/pods/${podId}/start`, { method: 'POST', headers: H, signal: AbortSignal.timeout(60000) });
    if (!r.ok) {
      const t = await r.text();
      console.log(`poll ${i} start HTTP ${r.status}: ${t.slice(0, 120)}`);
    }
  }
  await new Promise((res) => setTimeout(res, pollMs));
  current = await podStatus();
  console.log(`poll ${i}: status=${current.status} gpu=${current.gpu} id=${current.id}`);
  if (current.status === 'RUNNING') { console.log('RUNNING'); break; }
}
if (current.status !== 'RUNNING') { console.log('GAVE UP — pod not running after retries'); process.exit(1); }