import { readFileSync, existsSync } from 'node:fs';
const env = {};
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!l.trim() || l.trim().startsWith('#')) continue;
  const m = l.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const mask = (v) => {
  if (!v) return '(unset)';
  const m = v.match(/@([^@\s]+)\s+/);
  const reg = m ? m[1] : undefined;
  let out = reg ? v.replace(reg, '<host>') : v;
  out = out.replace(/-i\s+\S+/i, '-i <key>').replace(/-p\s+\d+/, '-p <p>');
  return out;
};
for (const k of ['RUNPOD_ID', 'RUNPOD_CONNECTION', 'RUNPOD_API_KEY', 'RUNPOD_LOCAL_OLLAMA_PORT', 'RUNPOD_PROVIDER_ENABLED', 'RUNPOD_OLLAMA_MODEL', 'RUNPOD_SSH_KEY', 'RUNPOD_PUBLIC_KEY_PATH']) {
  const v = env[k];
  const shape = /KEY|SECRET|TOKEN/i.test(k) ? (v ? '<set>' : '(unset)') : mask(v);
  console.log(k.padEnd(28), shape);
}
const pub = env.RUNPOD_PUBLIC_KEY_PATH;
const priv = env.RUNPOD_SSH_KEY || '~/.ssh/id_ed25519';
if (pub) console.log('pub exists:', existsSync(pub));
const winHome = process.env['USERPROFILE'] || process.env['HOME'];
console.log('~ resolves to:', winHome);