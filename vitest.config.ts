import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSrc = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@dacai-local-agent/shared', replacement: packageSrc('shared') },
      { find: '@dacai-local-agent/agent-core', replacement: packageSrc('agent-core') },
      { find: '@dacai-local-agent/security', replacement: packageSrc('security') },
      { find: '@dacai-local-agent/providers', replacement: packageSrc('providers') },
      { find: '@dacai-local-agent/telemetry', replacement: packageSrc('telemetry') },
      { find: '@dacai-local-agent/training-traces', replacement: packageSrc('training-traces') },
      { find: '@dacai-local-agent/workspace', replacement: packageSrc('workspace') },
      { find: '@dacai-local-agent/tools', replacement: packageSrc('tools') },
      { find: '@dacai-local-agent/orchestrator', replacement: packageSrc('orchestrator') },
      { find: '@dacai-local-agent/agents', replacement: packageSrc('agents') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
