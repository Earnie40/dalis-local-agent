import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function workspaceManifests(): Promise<string[]> {
  const manifests = ['package.json'];
  for (const group of ['apps', 'packages']) {
    for (const entry of await readdir(group, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(group, entry.name, 'package.json');
      try {
        await access(manifest);
        manifests.push(manifest);
      } catch {
        // A non-package directory does not participate in workspace licensing.
      }
    }
  }
  return manifests.sort();
}

describe('project licensing', () => {
  it('keeps every publishable workspace manifest private and explicitly unlicensed', async () => {
    const manifests = await workspaceManifests();
    expect(manifests.length).toBeGreaterThan(1);
    for (const manifest of manifests) {
      const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { private?: boolean; license?: string };
      expect(parsed.private, `${manifest} must not be accidentally publishable`).toBe(true);
      expect(parsed.license, `${manifest} must state the no-grant policy`).toBe('UNLICENSED');
    }
  });

  it('states the no-grant boundary without replacing third-party terms', async () => {
    const license = await readFile('LICENSE', 'utf8');
    const thirdParty = await readFile('THIRD_PARTY_NOTICES.md', 'utf8');
    expect(license).toMatch(/not offered under an open-source license/i);
    expect(license).toMatch(/No permission is granted/i);
    expect(thirdParty).toMatch(/subject to (?:its|their) own .* license terms/i);
  });
});
