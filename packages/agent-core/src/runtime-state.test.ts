import { describe, expect, it } from 'vitest';
import {
  chooseInitialReasoningMode,
  compactMessagesForRequest,
  extractChangedPaths,
  isMutationTool,
  isValidationTool,
  escalateReasoningMode,
  validationPassed,
} from './runtime-state';

describe('runtime state', () => {
  it('escalates complex work and repeated failures to deep reasoning', () => {
    expect(chooseInitialReasoningMode('read one file')).toBe('fast');
    expect(chooseInitialReasoningMode('1. inspect\n2. implement\n3. test\n4. verify\n5. review\n6. fix')).toBe('deep');
    expect(escalateReasoningMode('fast', { failures: 2 })).toBe('deep');
  });

  it('compacts old context while preserving the recent tail', () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? 'tool' as const : 'assistant' as const,
      toolName: index % 2 ? 'filesystem.read' : undefined,
      content: `turn-${index} ${'x'.repeat(900)}`,
    }));
    const result = compactMessagesForRequest({
      messages,
      systemPrompt: 'goal must survive in system prompt',
      maxContextTokens: 5000,
    });
    expect(result.compacted).toBe(true);
    expect(result.messages[0].content).toContain('CONTEXT COMPACTION');
    expect(result.messages.at(-1)?.content).toContain('turn-29');
  });

  it('requires objective exit evidence for validation', () => {
    expect(validationPassed({ success: true, output: JSON.stringify({ exitCode: 0 }) })).toBe(true);
    expect(validationPassed({ success: true, output: JSON.stringify({ exitCode: 1 }) })).toBe(false);
    expect(validationPassed({ success: true, output: 'looks good' })).toBe(false);
    expect(validationPassed({
      success: true,
      output: '{}',
      evidence: [{ kind: 'validation_result', detail: { filesPresent: true, contentHashed: true } }],
    })).toBe(true);
  });

  it('tracks engineering outputs as mutations and requires separate artifact validation', () => {
    expect(isMutationTool('cad.execute')).toBe(true);
    expect(isValidationTool('cad.execute')).toBe(false);
    expect(isValidationTool('engineering.artifact.inspect')).toBe(true);
    expect(extractChangedPaths('cad.execute', {
      expectedArtifacts: ['output/part.step', 'output/part.stl'],
      outputPath: 'output/part.step',
      scriptPath: 'models/part.py',
    })).toEqual(['output/part.step', 'output/part.stl']);
    expect(isMutationTool('image.generate')).toBe(true);
    expect(extractChangedPaths('image.generate', { outputPath: 'output/person.png' })).toEqual(['output/person.png']);
    expect(isMutationTool('video.generate')).toBe(true);
    expect(extractChangedPaths('video.generate', { outputPath: 'output/person.mp4' })).toEqual(['output/person.mp4']);
  });
});
