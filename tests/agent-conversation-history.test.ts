import { describe, expect, it } from 'vitest';
import { normalizeAgentConversationHistory } from '../apps/server/src/routes/agent';

describe('agent conversation history boundary', () => {
  it('accepts only bounded visible user and assistant messages', () => {
    const history = normalizeAgentConversationHistory([
      { role: 'user', content: '  first question  ' },
      { role: 'assistant', content: 'first answer' },
      ...Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 ? 'assistant' as const : 'user' as const,
        content: `message ${index}`,
      })),
    ]);

    expect(history).toHaveLength(16);
    expect(history[0]?.content).toBe('message 4');
    expect(history.at(-1)?.content).toBe('message 19');
  });
});
