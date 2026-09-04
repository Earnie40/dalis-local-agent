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
      { find: '@dacai-local-agent/domain-knowledge', replacement: packageSrc('domain-knowledge') },
      { find: '@dacai-local-agent/rag', replacement: packageSrc('rag') },
      { find: '@dacai-local-agent/smart-contract', replacement: packageSrc('smart-contract') },
      { find: '@dacai-local-agent/datasets', replacement: packageSrc('datasets') },
      { find: '@dacai-local-agent/market-intelligence', replacement: packageSrc('market-intelligence') },
      { find: '@dacai-local-agent/model-registry', replacement: packageSrc('model-registry') },
      { find: '@dacai-local-agent/investor-intelligence', replacement: packageSrc('investor-intelligence') },
    ],
  },
  test: {
    environment: 'node',
    // Package-local tests exercise private state-machine helpers that are not
    // exposed through the public test tree. Keep both locations discoverable.
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
