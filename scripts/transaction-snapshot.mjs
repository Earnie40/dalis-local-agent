import {
  createHash,
} from 'node:crypto';

import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';

import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  execFileSync,
} from 'node:child_process';

import process from 'node:process';

function payload() {
  const index =
    process.argv.indexOf(
      '--payload',
    );

  if (
    index < 0 ||
    !process.argv[index + 1]
  ) {
    throw new Error(
      'Missing --payload.',
    );
  }

  return JSON.parse(
    Buffer.from(
      process.argv[index + 1],
      'base64url',
    ).toString(
      'utf8',
    ),
  );
}

async function exists(
  path,
) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function contained(
  root,
  target,
) {
  const r =
    resolve(root);

  const t =
    resolve(target);

  return (
    t === r ||
    t.startsWith(
      r + sep,
    )
  );
}

function gitDirectory(
  root,
) {
  const value =
    execFileSync(
      'git',
      [
        'rev-parse',
        '--git-dir',
      ],

      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();

  return isAbsolute(value)
    ? resolve(value)
    : resolve(
        root,
        value,
      );
}

function absoluteTarget(
  root,
  path,
) {
  const target =
    isAbsolute(path)
      ? resolve(path)
      : resolve(
          root,
          path,
        );

  if (
    !contained(
      root,
      target,
    )
  ) {
    throw new Error(
      `Transaction target escapes workspace: ${path}`,
    );
  }

  return target;
}

function relativeTarget(
  root,
  path,
) {
  return relative(
    root,
    absoluteTarget(
      root,
      path,
    ),
  ).replace(
    /\\/g,
    '/',
  );
}

async function hashFile(
  path,
) {
  if (
    !await exists(path)
  ) {
    return null;
  }

  const info =
    await stat(path);

  if (
    !info.isFile()
  ) {
    throw new Error(
      `Transactional mutation currently supports files only: ${path}`,
    );
  }

  /*
   * Repository source/config files should remain bounded.
   * Large generated/binary artifacts should use a different
   * recovery strategy rather than bloating transaction backups.
   */
  if (
    info.size >
    16 * 1024 * 1024
  ) {
    throw new Error(
      `File exceeds 16 MiB transaction snapshot limit: ${path}`,
    );
  }

  const bytes =
    await readFile(path);

  return createHash(
    'sha256',
  )
    .update(bytes)
    .digest('hex');
}

function backupName(
  relativePath,
) {
  return (
    createHash(
      'sha256',
    )
      .update(
        relativePath,
      )
      .digest('hex')
      .slice(
        0,
        32,
      ) +
    '.bak'
  );
}

async function snapshot(
  root,
  transactionId,
  paths,
) {
  const gitDir =
    gitDirectory(root);

  const transactionDir =
    resolve(
      gitDir,
      'dacai-transactions',
      transactionId,
    );

  await mkdir(
    transactionDir,
    {
      recursive: true,
    },
  );

  const entries = [];

  for (
    const inputPath
    of paths
  ) {
    const path =
      relativeTarget(
        root,
        inputPath,
      );

    const target =
      absoluteTarget(
        root,
        path,
      );

    const present =
      await exists(
        target,
      );

    if (!present) {
      entries.push({
        path,

        existedBefore:
          false,

        backupPath:
          null,

        preHash:
          null,

        postHash:
          null,
      });

      continue;
    }

    const info =
      await stat(
        target,
      );

    if (
      !info.isFile()
    ) {
      throw new Error(
        `Cannot transactionally snapshot non-file path "${path}".`,
      );
    }

    if (
      info.size >
      16 * 1024 * 1024
    ) {
      throw new Error(
        `Cannot transactionally snapshot "${path}" because it exceeds 16 MiB.`,
      );
    }

    const backupPath =
      resolve(
        transactionDir,
        backupName(path),
      );

    await mkdir(
      dirname(
        backupPath,
      ),
      {
        recursive: true,
      },
    );

    await copyFile(
      target,
      backupPath,
    );

    entries.push({
      path,

      existedBefore:
        true,

      backupPath,

      preHash:
        await hashFile(
          target,
        ),

      postHash:
        null,

      size:
        info.size,
    });
  }

  return {
    transactionId,
    transactionDir,
    entries,
  };
}

async function fingerprint(
  root,
  paths,
) {
  const entries = [];

  for (
    const inputPath
    of paths
  ) {
    const path =
      relativeTarget(
        root,
        inputPath,
      );

    const target =
      absoluteTarget(
        root,
        path,
      );

    entries.push({
      path,

      hash:
        await hashFile(
          target,
        ),
    });
  }

  return {
    entries,
  };
}

async function verify(
  root,
  entries,
) {
  const conflicts = [];

  const current = [];

  for (
    const entry
    of entries
  ) {
    const target =
      absoluteTarget(
        root,
        entry.path,
      );

    const currentHash =
      await hashFile(
        target,
      );

    current.push({
      path:
        entry.path,

      currentHash,

      expectedPostHash:
        entry.postHash,
    });

    if (
      currentHash !==
      (
        entry.postHash ??
        null
      )
    ) {
      conflicts.push({
        path:
          entry.path,

        expected:
          entry.postHash ??
          null,

        observed:
          currentHash,
      });
    }
  }

  return {
    safe:
      conflicts.length ===
      0,

    conflicts,

    current,
  };
}

async function cleanup(
  root,
  transactionId,
) {
  const gitDir =
    gitDirectory(root);

  const transactionDir =
    resolve(
      gitDir,
      'dacai-transactions',
      transactionId,
    );

  await rm(
    transactionDir,
    {
      recursive: true,
      force: true,
    },
  );

  return {
    removed:
      transactionDir,
  };
}

async function main() {
  const request =
    payload();

  const root =
    resolve(
      request.workspaceRoot ??
      process.cwd(),
    );

  if (
    !await exists(
      resolve(
        root,
        '.git',
      ),
    )
  ) {
    /*
     * rev-parse below also supports worktrees where .git
     * may be a file, but the workspace must still be in Git.
     */
    try {
      gitDirectory(root);
    } catch {
      throw new Error(
        'Transactional mutation requires a Git workspace.',
      );
    }
  }

  let result;

  switch (
    request.operation
  ) {
    case 'snapshot':
      result =
        await snapshot(
          root,
          request.transactionId,
          request.paths ??
            [],
        );
      break;

    case 'fingerprint':
      result =
        await fingerprint(
          root,
          request.paths ??
            [],
        );
      break;

    case 'verify':
      result =
        await verify(
          root,
          request.entries ??
            [],
        );
      break;

    case 'cleanup':
      result =
        await cleanup(
          root,
          request.transactionId,
        );
      break;

    default:
      throw new Error(
        `Unknown transaction operation "${request.operation}".`,
      );
  }

  console.log(
    'DACAI_TRANSACTION_JSON:' +
      Buffer.from(
        JSON.stringify(
          result,
        ),
        'utf8',
      ).toString(
        'base64url',
      ),
  );
}

main().catch(
  (error) => {
    console.error(
      error instanceof Error
        ? error.stack ??
          error.message
        : String(error),
    );

    process.exitCode =
      1;
  },
);
