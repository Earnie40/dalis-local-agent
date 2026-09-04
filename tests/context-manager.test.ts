import { describe, it, expect } from 'vitest';
import { ContextManager } from '../packages/context/src/context-manager';

describe('ContextManager', () => {
  it('initializes successfully', () => {
    const manager = new ContextManager();
    expect(manager).toBeDefined();
  });

  it('builds context with goal and sections', async () => {
    const manager = new ContextManager();

    const context = await manager.buildContext({
      goal: 'Fix a bug in the authentication module',
      scope: { workspaceId: 'test-workspace' },
      options: {
        enableRag: false,
        enableMemory: false,
        maxContextTokens: 6000,
      },
    });

    expect(context).toBeDefined();
    expect(context.sections).toBeDefined();
    expect(context.sections.length).toBeGreaterThan(0);
    // Should have at least critical and goal sections
    const priorities = context.sections.map((s) => s.priority);
    expect(priorities).toContain('critical');
    expect(priorities).toContain('goal');
  });

  it('formats context sections into a string', async () => {
    const manager = new ContextManager();

    const context = await manager.buildContext({
      goal: 'Test goal',
      scope: { workspaceId: 'test-workspace' },
      options: {
        enableRag: false,
        enableMemory: false,
      },
    });

    const formatted = manager.formatContextString(context);
    expect(formatted).toBeDefined();
    expect(formatted).toContain('SYSTEM / RETRIEVAL BOUNDARY');
    expect(formatted).toContain('Test goal');
    expect(typeof formatted).toBe('string');
  });

  it('respects maxContextTokens budget', async () => {
    const manager = new ContextManager();

    const context = await manager.buildContext({
      goal: 'Test goal',
      scope: { workspaceId: 'test-workspace' },
      conversationHistory: [
        { role: 'user', content: 'A'.repeat(1000) },
        { role: 'assistant', content: 'B'.repeat(1000) },
      ],
      options: {
        enableRag: false,
        enableMemory: false,
        enableSkills: false,
        maxContextTokens: 500,
      },
    });

    expect(context.totalTokens).toBeLessThanOrEqual(500);
    expect(context.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ priority: 'critical', label: 'SYSTEM / RETRIEVAL BOUNDARY' }),
      expect.objectContaining({ priority: 'goal' }),
    ]));
    expect(context.truncated).toBe(true);
  });

  it('includes plan context when provided', async () => {
    const manager = new ContextManager();

    const context = await manager.buildContext({
      goal: 'Fix bug',
      scope: { workspaceId: 'test-workspace' },
      planContext: 'Step 1: Identify the issue\nStep 2: Write a test\nStep 3: Fix the code',
      options: {
        enableRag: false,
        enableMemory: false,
      },
    });

    const hasPlanSection = context.sections.some((s) => s.priority === 'plan');
    expect(hasPlanSection).toBe(true);
  });

  it('includes state context when provided', async () => {
    const manager = new ContextManager();

    const context = await manager.buildContext({
      goal: 'Debug an issue',
      scope: { workspaceId: 'test-workspace' },
      currentStateContext: 'Current error: NullPointerException at line 42\nRelevant code:\n...',
      options: {
        enableRag: false,
        enableMemory: false,
      },
    });

    const hasStateSection = context.sections.some((s) => s.priority === 'state');
    expect(hasStateSection).toBe(true);
  });

  it('gracefully handles RAG retrieval errors', async () => {
    const manager = new ContextManager();

    // This should not throw, even if RAG is enabled but fails
    const context = await manager.buildContext({
      goal: 'Test goal',
      scope: { workspaceId: 'nonexistent' },
      options: {
        enableRag: true,
        enableMemory: false,
      },
    });

    expect(context).toBeDefined();
    expect(Array.isArray(context.sections)).toBe(true);
  });
});
