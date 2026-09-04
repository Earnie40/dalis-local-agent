import { describe, expect, it } from 'vitest';
import { activityForLoopEvent } from '../apps/server/src/agent-activity';

describe('agent activity mapping', () => {
  it('maps tool lifecycle events to observable start and result records', () => {
    const start = activityForLoopEvent({
      type: 'tool_call', turn: 2,
      toolCall: { name: 'filesystem.read', arguments: { path: 'src/app.ts' } },
    });
    const result = activityForLoopEvent({
      type: 'tool_result', turn: 2,
      toolCall: { name: 'filesystem.read', arguments: { path: 'src/app.ts' } },
      result: { success: true, output: 'read 12 lines' },
    });

    expect(start).toMatchObject({ type: 'file_read', status: 'running', toolName: 'filesystem.read', filePath: 'src/app.ts' });
    expect(result).toMatchObject({ type: 'tool_result', status: 'success', toolName: 'filesystem.read' });
  });

  it('labels generated image activity with its workspace output path', () => {
    const start = activityForLoopEvent({
      type: 'tool_call', turn: 1,
      toolCall: { name: 'image.generate', arguments: { prompt: 'portrait', outputPath: 'output/portrait.png' } },
    });

    expect(start).toMatchObject({
      type: 'file_edit', status: 'running', toolName: 'image.generate', filePath: 'output/portrait.png',
    });
    expect(start?.message).toContain('output/portrait.png');
  });

  it('preserves redacted multiline terminal output and completion status', () => {
    const result = activityForLoopEvent({
      type: 'tool_result', turn: 4,
      toolCall: { name: 'shell.run', arguments: { command: 'pnpm test' } },
      result: {
        success: true,
        output: JSON.stringify({ command: 'pnpm test', exitCode: 0, stdout: 'first line\nsecond line', stderr: '' }),
      },
    });

    expect(result).toMatchObject({
      type: 'command',
      status: 'success',
      command: 'pnpm test',
      metadata: { kind: 'terminal', phase: 'result', stdout: 'first line\nsecond line', exitCode: 0 },
    });
  });

  it('does not expose model content and redacts observable tool output', () => {
    const model = activityForLoopEvent({ type: 'model_response', turn: 3, content: '<think>private</think>I will inspect the route next.' });
    const tool = activityForLoopEvent({
      type: 'tool_result', turn: 3,
      toolCall: { name: 'shell.run', arguments: { command: 'echo OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx' } },
      result: { success: false, output: 'Authorization: Bearer abcdefghijklmnop' },
    });

    expect(model?.message).not.toContain('private');
    expect(model?.message).toContain('I will inspect the route next.');
    expect(tool?.command).toContain('[REDACTED]');
    expect(tool?.message).toContain('[REDACTED]');
  });

  it('renders mode-aware budget progress as observable activity', () => {
    const budget = activityForLoopEvent({
      type: 'budget',
      turn: 61,
      message: '19 turns remain. Broad discovery is closing; consolidate evidence, challenge conclusions, synthesize, and verify.',
      budget: { mode: 'repository_audit', turns: 61, maxTurns: 80, toolCalls: 42, maxToolCalls: 160, reserveTurns: 20 },
    });

    expect(budget).toMatchObject({ type: 'warning', status: 'running', title: 'Budget reserve: synthesis and verification' });
    expect(budget?.metadata).toMatchObject({ turn: '61/80', toolCalls: '42/160' });
  });
});
