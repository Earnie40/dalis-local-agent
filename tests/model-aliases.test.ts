import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModelAliases } from '../packages/shared/src/model-aliases';

const dir = mkdtempSync(join(tmpdir(), 'dacai-aliases-'));

function writeConfig(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('model alias loading', () => {
  it('maps an alias to a provider instance and model', () => {
    const path = writeConfig(
      'ok.yaml',
      `models:\n  coder:\n    provider: local_ollama\n    model: qwen2.5-coder:latest\n    temperature: 0.1\n`,
    );

    const { models, warnings } = loadModelAliases(path, {});

    expect(models.coder).toMatchObject({
      providerInstanceId: 'local_ollama',
      model: 'qwen2.5-coder:latest',
      temperature: 0.1,
      enabled: true,
    });
    expect(warnings).toHaveLength(0);
  });

  it('interpolates ${VAR} from the environment', () => {
    const path = writeConfig(
      'interp.yaml',
      `models:\n  hf_reasoner:\n    provider: huggingface\n    model: \${HF_DEFAULT_MODEL}\n`,
    );

    const { models } = loadModelAliases(path, { HF_DEFAULT_MODEL: 'meta-llama/Llama-3.1-8B-Instruct' });
    expect(models.hf_reasoner.model).toBe('meta-llama/Llama-3.1-8B-Instruct');
    expect(models.hf_reasoner.enabled).toBe(true);
  });

  it('disables an alias whose placeholder is unset instead of routing to a literal ${VAR}', () => {
    const path = writeConfig(
      'unset.yaml',
      `models:\n  hf_reasoner:\n    provider: huggingface\n    model: \${HF_DEFAULT_MODEL}\n`,
    );

    const { models, warnings } = loadModelAliases(path, {});

    expect(models.hf_reasoner.enabled).toBe(false);
    expect(warnings[0]).toContain('HF_DEFAULT_MODEL');
    expect(warnings[0]).toContain('not set');
  });

  it('warns rather than crashing when the file is missing', () => {
    const { models, warnings } = loadModelAliases(join(dir, 'nope.yaml'), {});
    expect(models).toEqual({});
    expect(warnings[0]).toContain('not found');
  });

  it('warns rather than crashing on malformed YAML', () => {
    const path = writeConfig('bad.yaml', 'models:\n  coder:\n   - this: [is not\n');
    expect(loadModelAliases(path, {}).warnings[0]).toMatch(/not valid YAML|invalid/);
  });

  it('warns when an alias is missing a required field', () => {
    const path = writeConfig('missing.yaml', `models:\n  coder:\n    model: qwen2.5-coder:latest\n`);
    const { models, warnings } = loadModelAliases(path, {});

    expect(models).toEqual({});
    expect(warnings).toHaveLength(1);
  });
});
