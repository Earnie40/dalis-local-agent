import { describe, expect, it } from 'vitest';
import { sseFrame } from '../apps/server/src/routes/chat';
import { deriveTitle } from '../packages/shared/src/db/conversation-store';

/**
 * The client parses these frames by splitting on a blank line, so the exact
 * framing is a contract between server and browser, not a formatting detail.
 */
describe('SSE framing', () => {
  it('emits an event/data pair terminated by a blank line', () => {
    expect(sseFrame('chunk', { content: 'hi' })).toBe('event: chunk\ndata: {"content":"hi"}\n\n');
  });

  it('keeps newline-bearing content on a single data line', () => {
    const frame = sseFrame('chunk', { content: 'line one\nline two' });

    // A literal newline inside data would terminate the frame early; JSON
    // encoding is what prevents that.
    expect(frame.split('\n')).toHaveLength(4);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('round-trips through the same parsing the browser client uses', () => {
    const stream = [
      sseFrame('start', { conversationId: 'conv_1' }),
      sseFrame('chunk', { content: 'Hello ' }),
      sseFrame('chunk', { content: 'world' }),
      sseFrame('done', { cancelled: false }),
    ].join('');

    const frames = stream.split('\n\n').filter(Boolean);
    const parsed = frames.map((frame) => {
      const lines = frame.split('\n');
      return {
        event: lines.find((l) => l.startsWith('event: '))!.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)),
      };
    });

    expect(parsed.map((p) => p.event)).toEqual(['start', 'chunk', 'chunk', 'done']);
    expect(parsed[1].data.content + parsed[2].data.content).toBe('Hello world');
  });

  it('survives being split across arbitrary network chunk boundaries', () => {
    const stream = [sseFrame('chunk', { content: 'abc' }), sseFrame('done', {})].join('');

    // Feed one character at a time, as the browser reader would in the worst case.
    let buffer = '';
    const events: string[] = [];
    for (const char of stream) {
      buffer += char;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        events.push(frame.split('\n')[0].slice(7));
      }
    }

    expect(events).toEqual(['chunk', 'done']);
  });
});

describe('conversation titles', () => {
  it('uses the first line of the opening message', () => {
    expect(deriveTitle('Explain the router\nand then the loop')).toBe('Explain the router');
  });

  it('truncates a long line', () => {
    const title = deriveTitle('x'.repeat(200));
    expect(title).toHaveLength(58);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back when the message is blank', () => {
    expect(deriveTitle('   \n  ')).toBe('New conversation');
  });
});
