import { describe, expect, it } from 'vitest';
import { mediaStoryboardSystemPrompt } from '../apps/server/src/routes/media-studio';

describe('Media Studio storyboard policy', () => {
  it('preserves requested composition without adding application content bans', () => {
    const prompt = mediaStoryboardSystemPrompt(60, 2);

    expect(prompt).toContain('Preserve every requested subject, identity, action, interaction');
    expect(prompt).toContain('visible text, brand, likeness, clothing, pose, camera angle, composition, style');
    expect(prompt).toContain('Provider and model safety controls remain authoritative');
    expect(prompt).not.toMatch(/\bplan safe\b/i);
    expect(prompt).not.toMatch(/do not add (?:people|text|watermarks|brands|celebrities|real-person likenesses)/i);
    expect(prompt).not.toContain('never claim two supplied people');
  });
});
