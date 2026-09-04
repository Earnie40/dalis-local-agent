/**
 * Brings up the RunPod GPU inference path: restores the pod-side Ollama service
 * if needed, opens the loopback-only SSH tunnel, and reports GPU status.
 * Prints no credentials.
 */
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const { RunpodService } = await import('../apps/server/src/infrastructure/runpod-service.ts');

const service = new RunpodService();
const status = await service.initialize();

console.log('configured      ', status.configured);
console.log('connected       ', status.connected);
console.log('tunnel healthy  ', status.tunnelHealthy);
console.log('gpu             ', JSON.stringify(status.gpu));
console.log('cuda            ', status.cuda ?? '(n/a)');
console.log('ollama          ', status.ollama.installed ? status.ollama.version : '(not installed)');
console.log('ollama serving  ', status.inference.ollama);
console.log('models          ', status.inference.models.join(', ') || '(none)');
if (status.error) console.log('error           ', status.error);

// Keep the tunnel alive for the caller when asked.
if (process.argv.includes('--hold') && status.tunnelHealthy) {
  console.log('\nTunnel held open. Ctrl+C to close.');
  await new Promise(() => {});
}
process.exit(status.tunnelHealthy ? 0 : 1);
