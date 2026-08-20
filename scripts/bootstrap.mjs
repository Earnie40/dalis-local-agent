import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const targets = [
  'data/memory',
  'data/indexes',
  'data/logs',
  'data/db',
  'docs',
  'config/agents',
  'config/models',
  'config/permissions',
  'tests',
  'apps/server/src',
  'apps/web/src',
  'packages/shared/src',
  'packages/agent-core/src',
  'packages/orchestrator/src',
  'packages/providers/src',
  'packages/agents/src',
  'packages/tools/src',
  'packages/mcp/src',
  'packages/workspace/src',
  'packages/memory/src',
  'packages/rag/src',
  'packages/security/src',
  'packages/telemetry/src',
  'packages/shared/src',
];

for (const target of targets) {
  mkdirSync(resolve(target), { recursive: true });
}

writeFileSync(resolve('data/.gitkeep'), '');
writeFileSync(resolve('docs/.gitkeep'), '');
writeFileSync(resolve('config/.gitkeep'), '');
writeFileSync(resolve('scripts/.gitkeep'), '');
console.log('Bootstrap directories initialized.');
