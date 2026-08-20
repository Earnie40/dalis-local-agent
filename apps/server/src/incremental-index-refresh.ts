import {
  extname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';

import {
  access,
} from 'node:fs/promises';

import {
  execFile,
} from 'node:child_process';

import {
  createPostgresClient,
  RepositoryIndexer,
  SymbolStore,
} from '@dacai-local-agent/repository-index';

import {
  createId,
} from '@dacai-local-agent/shared';

const SOURCE_EXTENSIONS =
  new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.go',
    '.sql',
    '.rs',
    '.java',
    '.rb',
    '.kt',
    '.sh',
    '.ps1',
  ]);

export interface SemanticRefreshResult {
  refreshed: boolean;

  structural?: unknown;

  touchedPaths: string[];

  semanticOutput?: string;

  error?: string;
}

/*
 * Serialize refreshes.
 *
 * This matters if delegated work eventually runs with >1 worker:
 * two completed edits must not concurrently rebuild the same
 * repository-file/symbol rows.
 */
let refreshTail:
  Promise<unknown> =
    Promise.resolve();

function normalizedRelativePath(
  workspaceRoot: string,
  path: string,
): string {
  const absolute =
    isAbsolute(path)
      ? path
      : resolve(
          workspaceRoot,
          path,
        );

  return relative(
    workspaceRoot,
    absolute,
  )
    .replace(
      /\\/g,
      '/',
    );
}

function isSourceFile(
  path: string,
): boolean {
  return SOURCE_EXTENSIONS.has(
    extname(path)
      .toLowerCase(),
  );
}

async function runSemanticEnrichment(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const script =
    resolve(
      workspaceRoot,
      'packages',
      'repository-index',
      'src',
      'semantic-symbol-index.ts',
    );

  await access(script);

  const executable =
    process.platform ===
      'win32'
      ? 'pnpm.cmd'
      : 'pnpm';

  return new Promise<
    string
  >(
    (
      resolvePromise,
      rejectPromise,
    ) => {
      const child =
        execFile(
          executable,

          [
            'exec',
            'tsx',
            script,
          ],

          {
            cwd:
              workspaceRoot,

            windowsHide:
              true,

            timeout:
              900_000,

            env:
              process.env,

            maxBuffer:
              8 * 1024 * 1024,
          },

          (
            error,
            stdout,
            stderr,
          ) => {
            if (error) {
              rejectPromise(
                new Error(
                  [
                    error.message,

                    stderr
                      ?.trim(),
                  ]
                    .filter(
                      Boolean,
                    )
                    .join(
                      '\n',
                    ),
                ),
              );

              return;
            }

            resolvePromise(
              [
                stdout
                  ?.trim(),

                stderr
                  ?.trim(),
              ]
                .filter(
                  Boolean,
                )
                .join(
                  '\n',
                ),
            );
          },
        );

      const abort =
        () => {
          child.kill();

          rejectPromise(
            new Error(
              'Semantic index refresh was cancelled.',
            ),
          );
        };

      if (
        signal?.aborted
      ) {
        abort();

        return;
      }

      signal?.addEventListener(
        'abort',
        abort,
        {
          once: true,
        },
      );

      child.once(
        'exit',
        () => {
          signal
            ?.removeEventListener(
              'abort',
              abort,
            );
        },
      );
    },
  );
}

async function doRefresh(
  workspaceRoot: string,
  touchedPaths: string[],
  signal?: AbortSignal,
): Promise<SemanticRefreshResult> {
  const normalized =
    Array.from(
      new Set(
        touchedPaths
          .filter(Boolean)
          .map(
            (path) =>
              normalizedRelativePath(
                workspaceRoot,
                path,
              ),
          ),
      ),
    );

  const sourcePaths =
    normalized.filter(
      isSourceFile,
    );

  if (
    sourcePaths.length === 0
  ) {
    return {
      refreshed: false,

      touchedPaths:
        normalized,
    };
  }

  if (
    signal?.aborted
  ) {
    throw new Error(
      'Semantic index refresh cancelled.',
    );
  }

  /*
   * Existing RepositoryIndexer already performs hash-based
   * incremental indexing. It walks the repository but only
   * re-extracts files whose contents changed.
   */
  const db =
    createPostgresClient();

  const proposedRepositoryId =
    createId('rep');

  const provisionalStore =
    new SymbolStore(
      db,
      proposedRepositoryId,
    );

  const repositoryId =
    await provisionalStore.upsertRepository({
      id: proposedRepositoryId,
      rootPath: workspaceRoot,
    });

  const store =
    new SymbolStore(
      db,
      repositoryId,
    );

  const indexer =
    new RepositoryIndexer(
      workspaceRoot,
      store,
    );

  const structural =
    await indexer.indexAll();

  if (
    signal?.aborted
  ) {
    throw new Error(
      'Semantic index refresh cancelled after structural indexing.',
    );
  }

  /*
   * semantic-symbol-index.ts enriches code_symbols rows that
   * do not yet have embeddings.
   *
   * In the steady state all existing symbols are already
   * embedded, so after structural replacement this normally
   * embeds only symbols created by the changed file(s).
   */
  const semanticOutput =
    await runSemanticEnrichment(
      workspaceRoot,
      signal,
    );

  return {
    refreshed: true,

    structural,

    touchedPaths:
      sourcePaths,

    semanticOutput,
  };
}

export function refreshSemanticIndex(
  workspaceRoot: string,
  touchedPaths: string[],
  signal?: AbortSignal,
): Promise<SemanticRefreshResult> {
  const operation =
    refreshTail
      .catch(
        () => undefined,
      )
      .then(
        () =>
          doRefresh(
            workspaceRoot,
            touchedPaths,
            signal,
          ),
      );

  refreshTail =
    operation;

  return operation;
}
