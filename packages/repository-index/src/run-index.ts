import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createId } from '@dacai-local-agent/shared';
import { RepositoryIndexer } from './indexer.js';
import { SymbolStore, createPostgresClient } from './repository-store.js';

async function main(): Promise<void> {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const requestedRoot = process.env.DACAIS_REPOSITORY_ROOT?.trim() || defaultRoot;
  const rootPath = realpathSync(resolve(requestedRoot));

  let gitRoot: string;
  try {
    gitRoot = realpathSync(execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootPath, encoding: 'utf8' },
    ).trim());
  } catch {
    throw new Error(`Refusing to index a non-Git directory: ${rootPath}`);
  }

  if (gitRoot.toLowerCase() !== rootPath.toLowerCase()) {
    throw new Error(`Refusing to index ${rootPath}; the repository root is ${gitRoot}`);
  }

  let branch: string | undefined;
  let headCommit: string | undefined;

  try {
    branch = execFileSync(
      'git',
      ['branch', '--show-current'],
      { cwd: rootPath, encoding: 'utf8' },
    ).trim() || undefined;

    headCommit = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: rootPath, encoding: 'utf8' },
    ).trim() || undefined;
  } catch {
    // Git metadata is optional for indexing.
  }

  const db = createPostgresClient();

  const proposedId = createId('rep');
  const provisionalStore = new SymbolStore(db, proposedId);

  const repositoryId = await provisionalStore.upsertRepository({
    id: proposedId,
    rootPath,
    branch,
    headCommit,
  });

  // Important: ON CONFLICT(root_path) can return an existing repository id.
  const store = new SymbolStore(db, repositoryId);

  console.log('Repository:', rootPath);
  console.log('Repository ID:', repositoryId);
  console.log('Branch:', branch ?? '(unknown)');
  console.log('HEAD:', headCommit ?? '(unknown)');
  console.log('Indexing source files...');

  const indexer = new RepositoryIndexer(rootPath, store);
  const result = await indexer.indexAll();

  console.log('INDEX COMPLETE');
  console.table(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
