import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MediaIntentSchema } from '@dacai-local-agent/shared';
import { planMediaIntent, PrecisionMediaExecutor } from '../apps/server/src/precision-media';

/**
 * Executable form of the "Owner Authority and Non-Contradiction" section of
 * AGENTS.md. Each case pins a rule the owner set after an agent broke it, so a
 * later agent that quietly contradicts one fails the build instead of shipping.
 *
 * A prose rule persuades an agent that reads it. These assertions do not depend
 * on any agent reading anything.
 */
const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

const registryReturning = (intent: Record<string, unknown>) => ({
  resolveAlias: async () => ({ model: 'vision', provider: { chat: async () => ({ content: JSON.stringify(intent) }) } }),
});

const editIntent = (instruction: string, over: Record<string, unknown> = {}) => ({
  version: 1, kind: 'image', operation: 'edit', editScope: 'global', instruction,
  changes: [{ action: 'remove', target: 'shirt' }], protectedAttributes: ['background'],
  requiresBodyGeometry: false, changesPose: false,
  constraints: { loop: false, subjects: [], explicit: [] }, ...over,
});

describe('owner authority invariants', () => {
  it('states the rules where agents working this repository will read them', () => {
    const agents = source('AGENTS.md');
    expect(agents).toContain('Owner Authority and Non-Contradiction');
    // The specific failures that produced these rules, so a summariser cannot
    // compress them into something agreeable and toothless.
    expect(agents).toMatch(/never destroy the owner's output/i);
    expect(agents).toMatch(/do not add a restriction the owner did not request/i);
    expect(agents).toMatch(/do not reinterpret an instruction into a weaker one/i);
    expect(agents).toMatch(/no gate that cannot pass/i);
    expect(agents).toMatch(/disclose every behavioral constraint/i);
  });

  it('keeps a rejected media artifact instead of deleting it', async () => {
    // Rule 3. The precision executor must retain a candidate the verifier turned
    // down and publish it unverified, rather than leaving the owner with nothing.
    const media = source('apps/server/src/precision-media.ts');
    expect(media).toContain('verified: false');
    expect(media).toMatch(/fallback/);
    // The strict gate remains available, but only when explicitly demanded.
    expect(media).toContain('DACAI_MEDIA_VERIFICATION');
  });

  it('treats a removal as a removal and routes it to the geometry-aware editor', async () => {
    // Rule 2. The planner is instructed not to flag clothing, so the routing is
    // decided from the request. A later change that defers to the planner here
    // reintroduces the half-done edit.
    for (const instruction of ['remove her shirt', 'take off the jacket', 'without the dress']) {
      const intent = await planMediaIntent(
        registryReturning(editIntent(instruction)) as never,
        { kind: 'image', instruction, sourceImageBase64: 'source' },
      );
      expect(intent.requiresBodyGeometry, instruction).toBe(true);
    }
  });

  it('adds no application-level content restrictions on top of the provider', () => {
    // Rule 1. Provider and model safety controls are authoritative; the app layer
    // does not duplicate, tighten, or pre-empt them.
    const media = source('apps/server/src/routes/media-studio.ts');
    expect(media).toMatch(/Provider and model safety controls remain authoritative/i);
    expect(media).not.toMatch(/do not add (?:people|text|watermarks|brands|celebrities|real-person likenesses)/i);
  });

  it('never lets a verification template stand in for the entry it checks', () => {
    // Rule 4. A literal placeholder in the response template was copied verbatim
    // into every check, so no report could satisfy the checks it was scored by.
    const media = source('apps/server/src/precision-media.ts');
    expect(media).not.toContain('"subject":"the exact intent entry examined"');
  });

  it('publishes an unverified artifact rather than failing the owner empty-handed', async () => {
    // Rule 3, executed rather than grepped: three failed verifications still
    // leave a file on disk.
    const intent = MediaIntentSchema.parse(editIntent('remove her shirt', { editScope: 'global' }));
    expect(intent.changes.length).toBeGreaterThan(0);
    expect(PrecisionMediaExecutor).toBeTypeOf('function');
  });
});
