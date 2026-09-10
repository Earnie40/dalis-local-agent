import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../packages/skills/src/skill-registry';

describe('Capability Research and Reasoning skill', () => {
  it('is discoverable for vehicle connectivity and unfamiliar-integration research', async () => {
    const registry = new SkillRegistry(Promise.resolve(process.cwd()));
    const skill = await registry.get('capability-research');
    const matches = await registry.findRelevant(
      'research an OBD Bluetooth vehicle OnStar diagnostic connection and determine the required tool',
    );
    const generalMatches = await registry.findRelevant(
      'investigate an unfamiliar protocol, discover its requirements, and determine which adapter or tool is needed',
    );

    expect(skill?.tags).toEqual(expect.arrayContaining([
      'reasoning', 'discovery', 'tools', 'obd', 'bluetooth', 'onstar', 'vehicle',
    ]));
    expect(skill?.content).toContain('Core reasoning loop');
    expect(skill?.content).toContain('Unknown-recovery rule');
    expect(skill?.content).toMatch(/successful skill\s+lookup[\s\S]*procedural progress/);
    expect(skill?.content).toContain('Vehicle and connected-service research');
    expect(skill?.content).toMatch(/implement\s+and register that smallest adapter/);
    expect(matches.map((match) => match.skill.name)).toContain('capability-research');
    expect(generalMatches.map((match) => match.skill.name)).toContain('capability-research');
  });
});
