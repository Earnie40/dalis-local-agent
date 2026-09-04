import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModelAliases } from '@dacai-local-agent/shared';

describe('default model aliases', () => {
  it('uses the low-refusal Qwen checkpoint for chat and coding', () => {
    const result = loadModelAliases(
      resolve(process.cwd(), 'config/models/default.yaml'),
      process.env,
    );

    expect(result.status).toBe('loaded');
    expect(result.models.chat).toMatchObject({
      providerInstanceId: 'local_ollama',
      model: 'huihui_ai/qwen3-abliterated:8b',
      enabled: true,
      temperature: 0.2,
    });
    expect(result.models.coder).toMatchObject({
      providerInstanceId: 'local_ollama',
      model: 'huihui_ai/qwen3-abliterated:8b',
      enabled: true,
      temperature: 0.08,
    });
    expect(result.models.qwen_uncensored).toMatchObject({
      providerInstanceId: 'local_ollama',
      model: 'huihui_ai/qwen3-abliterated:8b',
      enabled: true,
      temperature: 0.2,
    });
    expect(result.models.gpu_qwen_uncensored).toMatchObject({
      providerInstanceId: 'remote_gpu_ollama',
      model: 'huihui_ai/qwen3-abliterated:8b',
      temperature: 0.2,
    });
    expect(result.models.gpu_chat.model).toBe(result.models.chat.model);
    expect(result.models.gpu_coder.model).toBe(result.models.coder.model);
  });
});
