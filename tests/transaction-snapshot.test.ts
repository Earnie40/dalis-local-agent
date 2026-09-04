import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('transaction snapshot helper', () => {
  it('streams post-mutation fingerprints for generated artifacts larger than the backup cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dacai-transaction-'));
    roots.push(root);
    await executeFile('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
    await mkdir(join(root, 'output'), { recursive: true });
    const bytes = Buffer.alloc(17 * 1024 * 1024, 0x5a);
    await writeFile(join(root, 'output', 'large.step'), bytes);
    const request = Buffer.from(JSON.stringify({
      operation: 'fingerprint',
      workspaceRoot: root,
      paths: ['output/large.step'],
    }), 'utf8').toString('base64url');
    const helper = resolve('scripts/transaction-snapshot.mjs');
    const { stdout } = await executeFile(process.execPath, [helper, '--payload', request], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const encoded = stdout.match(/DACAI_TRANSACTION_JSON:([A-Za-z0-9_-]+)/)?.[1];
    expect(encoded).toBeTruthy();
    const result = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as {
      entries: Array<{ path: string; hash: string }>;
    };
    expect(result.entries).toEqual([{
      path: 'output/large.step',
      hash: createHash('sha256').update(bytes).digest('hex'),
    }]);
  });
});
