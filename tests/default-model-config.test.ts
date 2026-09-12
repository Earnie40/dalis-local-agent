import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModelAliases } from '@dacai-local-agent/shared';

describe('default model aliases', () => {
  it('uses the RunPod low-refusal Qwen checkpoint for chat and coding', () => {
    const result = loadModelAliases(
      resolve(process.cwd(), 'config/models/default.yaml'),
      process.env,
    );

    expect(result.status).toBe('loaded');
    expect(result.models.chat).toMatchObject({
      providerInstanceId: 'remote_gpu_ollama',
      model: 'huihui_ai/qwen3-abliterated:8b',
      enabled: true,
      temperature: 0.2,
    });
    expect(result.models.coder).toMatchObject({
      providerInstanceId: 'remote_gpu_ollama',
      model: 'huihui_ai/qwen3-abliterated:8b',
      enabled: true,
      temperature: 0.08,
    });
    expect(result.models.qwen_uncensored).toMatchObject({
      providerInstanceId: 'remote_gpu_ollama',
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

  it('uses the low-refusal Qwen checkpoint for planner, reasoner, reviewer, and structured roles', () => {
    const result = loadModelAliases(
      resolve(process.cwd(), 'config/models/default.yaml'),
      process.env,
    );

    expect(result.status).toBe('loaded');
    const lowRefusal = 'huihui_ai/qwen3-abliterated:8b';
    for (const alias of ['planner', 'reasoner', 'reviewer', 'structured_agent'] as const) {
      expect(result.models[alias].model, alias).toBe(lowRefusal);
      expect(result.models[alias].providerInstanceId, alias).toBe('remote_gpu_ollama');
    }
    expect(result.models.intelligence_local).toMatchObject({
      model: lowRefusal,
      providerInstanceId: 'local_ollama',
    });
    expect(result.models.gpu_planner.model).toBe(result.models.planner.model);
    expect(result.models.gpu_reasoner.model).toBe(result.models.reasoner.model);
    expect(result.models.gpu_reviewer.model).toBe(result.models.reviewer.model);
    expect(result.models.gpu_structured_agent.model).toBe(result.models.structured_agent.model);
  });
});
