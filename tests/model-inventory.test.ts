import { describe, expect, it } from 'vitest';
import type { ModelDescriptor } from '../packages/agent-core/src/types';
import { groupModels, toolCapableModels } from '../packages/providers/src/model-inventory';

function model(name: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    name,
    providerInstanceId: 'local_ollama',
    declaredCapabilities: ['completion'],
    ...overrides,
  };
}

/** Mirrors the real local inventory: 28 tags over 3 genuine artifacts. */
describe('model inventory grouping', () => {
  it('collapses same-digest tags into one artifact with aliases', () => {
    const inventory = groupModels([
      model('qwen2.5-coder:7b', { digest: 'dae161', family: 'qwen2' }),
      model('qwen2.5-coder:latest', { digest: 'dae161', family: 'qwen2' }),
    ]);

    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0].aliases).toEqual(['qwen2.5-coder:latest']);
    expect(inventory.baseCount).toBe(1);
    expect(inventory.tagCount).toBe(2);
  });

  it('attaches personas to the base they were built from', () => {
    const inventory = groupModels([
      model('phi4-mini:latest', { digest: '78fad5' }),
      model('threat-intel:latest', { digest: 'a7e7e2', parentModel: 'phi4-mini:latest' }),
      model('privacy-agent:latest', { digest: '11ebbe', parentModel: 'phi4-mini:latest' }),
    ]);

    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0].personas).toEqual(['privacy-agent:latest', 'threat-intel:latest']);
  });

  it('follows a persona built on another persona back to the base', () => {
    const inventory = groupModels([
      model('qwen2.5-coder:7b', { digest: 'dae161' }),
      model('cyber-investigator:latest', { digest: 'ada581', parentModel: 'qwen2.5-coder:7b' }),
      model('deep-investigator:latest', { digest: 'bbb222', parentModel: 'cyber-investigator:latest' }),
    ]);

    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0].baseModel).toBe('qwen2.5-coder:7b');
    expect(inventory.groups[0].personas).toEqual(['cyber-investigator:latest', 'deep-investigator:latest']);
  });

  it('resolves a persona whose parent is named by an alias tag', () => {
    const inventory = groupModels([
      model('qwen2.5-coder:7b', { digest: 'dae161' }),
      model('qwen2.5-coder:latest', { digest: 'dae161' }),
      model('secure-reviewer:latest', { digest: '2a0900', parentModel: 'qwen2.5-coder:latest' }),
    ]);

    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0].personas).toEqual(['secure-reviewer:latest']);
  });

  it('keeps an orphaned persona visible when its base is gone', () => {
    const inventory = groupModels([model('orphan:latest', { parentModel: 'deleted-base:latest' })]);

    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0].baseModel).toBe('deleted-base:latest');
    expect(inventory.groups[0].personas).toEqual(['orphan:latest']);
  });

  it('does not loop on a self-referential parent', () => {
    const inventory = groupModels([model('weird:latest', { digest: 'x', parentModel: 'weird:latest' })]);
    expect(inventory.groups).toHaveLength(1);
  });

  it('separates genuinely distinct base models', () => {
    const inventory = groupModels([
      model('phi3:mini', { digest: '4f2222' }),
      model('phi4-mini:latest', { digest: '78fad5' }),
      model('qwen2.5-coder:7b', { digest: 'dae161' }),
    ]);

    expect(inventory.baseCount).toBe(3);
  });

  it('identifies which models are worth spending a probe on', () => {
    const candidates = toolCapableModels([
      model('phi3:mini'),
      model('qwen2.5-coder:7b', { declaredCapabilities: ['completion', 'tools', 'insert'] }),
    ]);

    expect(candidates.map((m) => m.name)).toEqual(['qwen2.5-coder:7b']);
  });
});
