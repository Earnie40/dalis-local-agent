import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createId } from '@dacai-local-agent/shared';
import { RepositoryIndexer } from './indexer.js';
import { SymbolStore, createPostgresClient } from './repository-store.js';

async function main(): Promise<void> {
  const rootPath = resolve(process.cwd(), '../..');

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
