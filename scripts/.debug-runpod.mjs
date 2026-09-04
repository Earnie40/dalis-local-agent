import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env','utf8').split(/\r?\n/)) { const m=l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const { parseRunpodConnection, buildSshBaseArgs } = await import('../apps/server/src/infrastructure/runpod-connection.ts');
const { defaultRunCommand } = await import('../apps/server/src/infrastructure/runpod-service.ts');
const conn = parseRunpodConnection(process.env.RUNPOD_CONNECTION);
console.log('parsed:', JSON.stringify({ ...conn, identityFile: conn.identityFile ? '(set)' : '(none)' }));

const run = (cmd) => defaultRunCommand('ssh', [...buildSshBaseArgs(conn), cmd], 15000);

console.log('\n--- SEQUENTIAL ---');
for (const c of ['printf READY', 'nvidia-smi --query-gpu=name --format=csv,noheader', 'command -v ollama']) {
  const r = await run(c);
  console.log(`  code=${r.code} out="${r.stdout.trim().slice(0,50)}" err="${r.stderr.trim().slice(0,80)}"`);
}

console.log('\n--- 7 CONCURRENT (what status() does) ---');
const cmds = ['printf A','printf B','printf C','printf D','printf E','printf F','printf G'];
const results = await Promise.all(cmds.map(c => run(c)));
results.forEach((r,i) => console.log(`  [${i}] code=${r.code} out="${r.stdout.trim()}" err="${r.stderr.trim().slice(0,70)}"`));
