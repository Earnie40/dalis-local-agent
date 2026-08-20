import {
  createHash,
  randomUUID,
} from 'node:crypto';

import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';

import {
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  spawn,
  spawnSync,
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function inside(
  root,
  target,
) {
  const rootPath =
    resolve(root);

  const targetPath =
    resolve(target);

  return (
    targetPath ===
      rootPath ||
    targetPath.startsWith(
      rootPath + sep,
    )
  );
}

async function readJson(path) {
  return JSON.parse(
    await readFile(
      path,
      'utf8',
    ),
  );
}

async function rootPackage(
  root,
) {
  return readJson(
    join(
      root,
      'package.json',
    ),
  );
}

function dependencies(pkg) {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
}

async function frontendScore(
  root,
  packageDir,
  pkg,
) {
  let score = 0;

  const deps =
    dependencies(pkg);

  const dev =
    String(
      pkg.scripts?.dev ??
      '',
    );

  const relativePath =
    relative(
      root,
      packageDir,
    ).replace(
      /\\/g,
      '/',
    );

  const reasons = [];

  if (
    relativePath.startsWith(
      'apps/',
    )
  ) {
    score += 4;
    reasons.push(
      'package is under apps/',
    );
  }

  for (
    const [
      dependency,
      value,
    ]
    of [
      ['vite', 8],
      ['next', 8],
      ['react', 5],
      ['react-dom', 3],
      ['vue', 6],
      ['svelte', 6],
      ['astro', 6],
      ['@angular/core', 6],
    ]
  ) {
    if (
      dependency in deps
    ) {
      score += value;

      reasons.push(
        `depends on ${dependency}`,
      );
    }
  }

  if (
    pkg.scripts?.dev
  ) {
    score += 3;

    reasons.push(
      'has dev script',
    );
  }

  if (
    await exists(
      join(
        packageDir,
        'index.html',
      ),
    )
  ) {
    score += 5;

    reasons.push(
      'contains index.html',
    );
  }

  for (
    const entry
    of [
      'src/main.tsx',
      'src/main.jsx',
      'src/main.ts',
      'src/main.js',
      'src/App.tsx',
      'src/App.jsx',
    ]
  ) {
    if (
      await exists(
        join(
          packageDir,
          entry,
        ),
      )
    ) {
      score += 4;

      reasons.push(
        `contains ${entry}`,
      );

      break;
    }
  }

  /*
   * Do not choose a monorepo root script that launches
   * several services together while the agent server is
   * already running.
   */
  if (
    resolve(packageDir) ===
    resolve(root)
  ) {
    score -= 10;

    reasons.push(
      'repository root penalized',
    );

    if (
      /\bconcurrently\b/i.test(
        dev,
      )
    ) {
      score -= 20;

      reasons.push(
        'root dev script launches multiple services',
      );
    }
  }

  return {
    score,
    reasons,
  };
}

function defaultPort(
  pkg,
) {
  const deps =
    dependencies(pkg);

  const scripts = [
    pkg.scripts?.dev,
    pkg.scripts?.start,
    pkg.scripts?.preview,
  ]
    .filter(Boolean)
    .join(
      ' ',
    );

  const explicit =
    scripts.match(
      /(?:--port(?:=|\s+)|-p\s+)(\d{2,5})/i,
    );

  if (explicit) {
    return Number(
      explicit[1],
    );
  }

  if (
    'vite' in deps
  ) {
    return 5173;
  }

  if (
    'next' in deps
  ) {
    return 3000;
  }

  if (
    'astro' in deps
  ) {
    return 4321;
  }

  if (
    '@angular/core' in deps
  ) {
    return 4200;
  }

  if (
    'react-scripts' in deps
  ) {
    return 3000;
  }

  return undefined;
}

async function configuredVitePort(
  packageDir,
) {
  for (
    const file
    of [
      'vite.config.ts',
      'vite.config.js',
      'vite.config.mjs',
      'vite.config.cjs',
    ]
  ) {
    const path =
      join(
        packageDir,
        file,
      );

    if (
      !await exists(path)
    ) {
      continue;
    }

    const text =
      await readFile(
        path,
        'utf8',
      );

    const match =
      text.match(
        /\bport\s*:\s*(\d{2,5})/,
      );

    if (match) {
      return Number(
        match[1],
      );
    }
  }

  return undefined;
}

async function packageDirs(
  root,
) {
  const dirs = [
    root,
  ];

  const apps =
    join(
      root,
      'apps',
    );

  if (
    await exists(apps)
  ) {
    for (
      const entry
      of await readdir(
        apps,
        {
          withFileTypes: true,
        },
      )
    ) {
      if (
        entry.isDirectory()
      ) {
        dirs.push(
          join(
            apps,
            entry.name,
          ),
        );
      }
    }
  }

  return dirs;
}

async function discover(
  root,
) {
  const candidates = [];

  for (
    const dir
    of await packageDirs(
      root,
    )
  ) {
    const packagePath =
      join(
        dir,
        'package.json',
      );

    if (
      !await exists(
        packagePath,
      )
    ) {
      continue;
    }

    let pkg;

    try {
      pkg =
        await readJson(
          packagePath,
        );
    } catch {
      continue;
    }

    const scoring =
      await frontendScore(
        root,
        dir,
        pkg,
      );

    if (
      scoring.score <= 0
    ) {
      continue;
    }

    const port =
      await configuredVitePort(
        dir,
      ) ??
      defaultPort(pkg);

    candidates.push({
      packageDir:
        dir,

      packagePath,

      relativePath:
        relative(
          root,
          dir,
        ).replace(
          /\\/g,
          '/',
        ) || '.',

      packageName:
        pkg.name,

      score:
        scoring.score,

      reasons:
        scoring.reasons,

      scripts:
        {
          dev:
            pkg.scripts?.dev,
          start:
            pkg.scripts?.start,
          preview:
            pkg.scripts?.preview,
        },

      preferredScript:
        pkg.scripts?.dev
          ? 'dev'
          : pkg.scripts?.start
            ? 'start'
            : pkg.scripts?.preview
              ? 'preview'
              : undefined,

      expectedPort:
        port,

      expectedUrl:
        port
          ? `http://127.0.0.1:${port}/`
          : undefined,
    });
  }

  return candidates.sort(
    (a, b) =>
      b.score -
      a.score,
  );
}

async function probe(
  url,
  timeoutMs = 1000,
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs,
    );

  try {
    const response =
      await fetch(
        url,
        {
          method:
            'GET',

          redirect:
            'manual',

          signal:
            controller.signal,
        },
      );

    return {
      reachable: true,
      status:
        response.status,
    };
  } catch {
    return {
      reachable: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

function stateDir(
  root,
) {
  return join(
    root,
    '.dacai',
    'local-apps',
  );
}

function receiptId(
  packageDir,
) {
  return createHash(
    'sha256',
  )
    .update(
      resolve(
        packageDir,
      ),
    )
    .digest(
      'hex',
    )
    .slice(
      0,
      20,
    );
}

function receiptPath(
  root,
  packageDir,
) {
  return join(
    stateDir(root),
    `${receiptId(
      packageDir,
    )}.json`,
  );
}

async function readReceipt(
  root,
  packageDir,
) {
  const path =
    receiptPath(
      root,
      packageDir,
    );

  try {
    return JSON.parse(
      await readFile(
        path,
        'utf8',
      ),
    );
  } catch {
    return undefined;
  }
}

function processExists(
  pid,
) {
  if (
    !Number.isInteger(
      pid,
    ) ||
    pid <= 0
  ) {
    return false;
  }

  try {
    process.kill(
      pid,
      0,
    );

    return true;
  } catch {
    return false;
  }
}

function packageManager(
  rootPkg,
) {
  const declared =
    String(
      rootPkg.packageManager ??
      'pnpm',
    );

  const name =
    declared.split(
      '@',
    )[0];

  if (
    ![
      'pnpm',
      'npm',
      'yarn',
    ].includes(
      name,
    )
  ) {
    return 'pnpm';
  }

  return name;
}

function executableFor(
  manager,
) {
  if (
    process.platform !==
    'win32'
  ) {
    return manager;
  }

  return `${manager}.cmd`;
}

function managerArgs(
  manager,
  packageDir,
  script,
) {
  if (
    manager ===
    'npm'
  ) {
    return [
      '--prefix',
      packageDir,
      'run',
      script,
    ];
  }

  if (
    manager ===
    'yarn'
  ) {
    return [
      '--cwd',
      packageDir,
      script,
    ];
  }

  return [
    '--dir',
    packageDir,
    'run',
    script,
  ];
}

async function logDetectedUrl(
  logPath,
) {
  if (
    !await exists(
      logPath,
    )
  ) {
    return undefined;
  }

  const text =
    (
      await readFile(
        logPath,
        'utf8',
      )
    ).slice(
      -100_000,
    );

  const matches =
    text.match(
      /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{2,5})?\/?[^\s]*/gi,
    );

  if (!matches?.length) {
    return undefined;
  }

  for (
    const candidate
    of matches.reverse()
  ) {
    try {
      const url =
        new URL(
          candidate.replace(
            /[),.;]+$/,
            '',
          ),
        );

      const host =
        url.hostname
          .replace(
            /^\[|\]$/g,
            '',
          )
          .toLowerCase();

      if (
        host ===
          'localhost' ||
        host ===
          '127.0.0.1' ||
        host ===
          '::1' ||
        host.startsWith(
          '127.',
        )
      ) {
        return url.href;
      }
    } catch {
      // Continue.
    }
  }

  return undefined;
}

async function stopPid(
  pid,
) {
  if (
    !processExists(pid)
  ) {
    return;
  }

  if (
    process.platform ===
    'win32'
  ) {
    const result =
      spawnSync(
        'taskkill',
        [
          '/PID',
          String(pid),
          '/T',
          '/F',
        ],
        {
          windowsHide:
            true,
        },
      );

    if (
      result.status !== 0 &&
      processExists(pid)
    ) {
      throw new Error(
        `Unable to stop owned process ${pid}.`,
      );
    }

    return;
  }

  try {
    process.kill(
      -pid,
      'SIGTERM',
    );
  } catch {
    process.kill(
      pid,
      'SIGTERM',
    );
  }
}

async function chooseCandidate(
  root,
  requestedPath,
) {
  const candidates =
    await discover(root);

  if (
    !candidates.length
  ) {
    throw new Error(
      'No frontend application package was discovered.',
    );
  }

  if (
    requestedPath
  ) {
    const wanted =
      resolve(
        root,
        requestedPath,
      );

    if (
      !inside(
        root,
        wanted,
      )
    ) {
      throw new Error(
        'Requested frontend package is outside the workspace.',
      );
    }

    const match =
      candidates.find(
        (candidate) =>
          resolve(
            candidate.packageDir,
          ) === wanted,
      );

    if (!match) {
      throw new Error(
        `Requested package "${requestedPath}" was not discovered as a frontend application.`,
      );
    }

    return {
      candidate:
        match,

      candidates,
    };
  }

  return {
    candidate:
      candidates[0],

    candidates,
  };
}

async function ensureApp(
  root,
  request,
) {
  const {
    candidate,
    candidates,
  } =
    await chooseCandidate(
      root,
      request.packagePath,
    );

  const rootPkg =
    await rootPackage(root);

  const pkg =
    await readJson(
      candidate.packagePath,
    );

  const script =
    request.script ??
    candidate.preferredScript;

  if (
    !script ||
    typeof pkg.scripts?.[
      script
    ] !== 'string'
  ) {
    throw new Error(
      `No usable "${script ?? 'dev'}" script exists in ${candidate.relativePath}.`,
    );
  }

  const expectedUrl =
    candidate.expectedUrl;

  /*
   * First reuse any already-running app.
   */
  if (expectedUrl) {
    const current =
      await probe(
        expectedUrl,
      );

    if (
      current.reachable
    ) {
      const receipt =
        await readReceipt(
          root,
          candidate.packageDir,
        );

      return {
        kind:
          'local_app_ready',

        package:
          candidate,

        url:
          expectedUrl,

        reused:
          true,

        owned:
          Boolean(
            receipt &&
            processExists(
              receipt.pid,
            ),
          ),

        pid:
          receipt?.pid,

        status:
          current.status,

        candidates,
      };
    }
  }

  const previous =
    await readReceipt(
      root,
      candidate.packageDir,
    );

  if (
    previous &&
    processExists(
      previous.pid,
    )
  ) {
    const previousUrl =
      previous.url;

    if (previousUrl) {
      const health =
        await probe(
          previousUrl,
        );

      if (
        health.reachable
      ) {
        return {
          kind:
            'local_app_ready',

          package:
            candidate,

          url:
            previousUrl,

          reused:
            true,

          owned:
            true,

          pid:
            previous.pid,

          status:
            health.status,

          candidates,
        };
      }
    }
  }

  await mkdir(
    stateDir(root),
    {
      recursive:
        true,
    },
  );

  const id =
    receiptId(
      candidate.packageDir,
    );

  const logPath =
    join(
      stateDir(root),
      `${id}.log`,
    );

  const logHandle =
    await open(
      logPath,
      'a',
    );

  const manager =
    packageManager(
      rootPkg,
    );

  const child =
    spawn(
      executableFor(
        manager,
      ),

      managerArgs(
        manager,
        candidate.packageDir,
        script,
      ),

      {
        cwd:
          candidate.packageDir,

        detached:
          true,

        windowsHide:
          true,

        stdio: [
          'ignore',
          logHandle.fd,
          logHandle.fd,
        ],

        env: {
          ...process.env,

          /*
           * Encourage loopback-only binding where frameworks
           * honor HOST without requiring arbitrary script edits.
           */
          HOST:
            '127.0.0.1',
        },
      },
    );

  child.unref();

  const ownershipToken =
    randomUUID();

  const startedAt =
    new Date()
      .toISOString();

  let receipt = {
    kind:
      'dacai-owned-local-app',

    ownershipToken,

    pid:
      child.pid,

    packageDir:
      candidate.packageDir,

    packageName:
      candidate.packageName,

    script,

    manager,

    logPath,

    startedAt,

    url:
      expectedUrl,
  };

  await writeFile(
    receiptPath(
      root,
      candidate.packageDir,
    ),

    JSON.stringify(
      receipt,
      null,
      2,
    ),

    'utf8',
  );

  await logHandle.close();

  const started =
    Date.now();

  let readyUrl =
    expectedUrl;

  while (
    Date.now() -
      started <
    30_000
  ) {
    if (
      !processExists(
        child.pid,
      )
    ) {
      break;
    }

    readyUrl =
      await logDetectedUrl(
        logPath,
      ) ??
      readyUrl;

    if (readyUrl) {
      const health =
        await probe(
          readyUrl,
          1200,
        );

      if (
        health.reachable
      ) {
        receipt = {
          ...receipt,
          url:
            readyUrl,
        };

        await writeFile(
          receiptPath(
            root,
            candidate.packageDir,
          ),

          JSON.stringify(
            receipt,
            null,
            2,
          ),

          'utf8',
        );

        return {
          kind:
            'local_app_ready',

          package:
            candidate,

          url:
            readyUrl,

          reused:
            false,

          owned:
            true,

          pid:
            child.pid,

          status:
            health.status,

          logPath,

          candidates,
        };
      }
    }

    await new Promise(
      (resolvePromise) =>
        setTimeout(
          resolvePromise,
          300,
        ),
    );
  }

  /*
   * Never leave a process behind when startup verification
   * itself failed.
   */
  if (
    processExists(
      child.pid,
    )
  ) {
    await stopPid(
      child.pid,
    );
  }

  await rm(
    receiptPath(
      root,
      candidate.packageDir,
    ),
    {
      force: true,
    },
  );

  const tail =
    await readFile(
      logPath,
      'utf8',
    )
      .then(
        (value) =>
          value.slice(
            -8000,
          ),
      )
      .catch(
        () => '',
      );

  throw new Error(
    [
      `Frontend process did not become ready within 30 seconds.`,
      tail,
    ]
      .filter(Boolean)
      .join(
        '\n',
      ),
  );
}

async function status(
  root,
) {
  const candidates =
    await discover(root);

  const applications = [];

  for (
    const candidate
    of candidates
  ) {
    const receipt =
      await readReceipt(
        root,
        candidate.packageDir,
      );

    const url =
      receipt?.url ??
      candidate.expectedUrl;

    const health =
      url
        ? await probe(url)
        : {
            reachable:
              false,
          };

    applications.push({
      ...candidate,

      reachable:
        health.reachable,

      httpStatus:
        health.status,

      url,

      owned:
        Boolean(
          receipt &&
          processExists(
            receipt.pid,
          ),
        ),

      pid:
        receipt?.pid,

      ownedSince:
        receipt?.startedAt,

      logPath:
        receipt?.logPath,
    });
  }

  return {
    kind:
      'local_app_status',

    applications,
  };
}

async function stopOwned(
  root,
  request,
) {
  const {
    candidate,
  } =
    await chooseCandidate(
      root,
      request.packagePath,
    );

  const path =
    receiptPath(
      root,
      candidate.packageDir,
    );

  const receipt =
    await readReceipt(
      root,
      candidate.packageDir,
    );

  if (!receipt) {
    return {
      kind:
        'local_app_stop',

      stopped:
        false,

      owned:
        false,

      reason:
        'No DACAIS lifecycle ownership receipt exists. External process was left untouched.',

      package:
        candidate,
    };
  }

  if (
    receipt.kind !==
      'dacai-owned-local-app' ||
    !inside(
      root,
      receipt.packageDir,
    ) ||
    resolve(
      receipt.packageDir,
    ) !==
      resolve(
        candidate.packageDir,
      )
  ) {
    throw new Error(
      'Lifecycle ownership receipt failed validation. Process was not stopped.',
    );
  }

  const ageMs =
    Date.now() -
    Date.parse(
      receipt.startedAt,
    );

  /*
   * Reduce PID-reuse risk. Very old receipts require human
   * cleanup instead of an automatic taskkill.
   */
  if (
    !Number.isFinite(
      ageMs,
    ) ||
    ageMs >
      12 * 60 * 60 * 1000
  ) {
    throw new Error(
      'Owned-process receipt is older than 12 hours. Refusing automatic stop because the PID may have been reused.',
    );
  }

  const wasRunning =
    processExists(
      receipt.pid,
    );

  if (wasRunning) {
    await stopPid(
      receipt.pid,
    );
  }

  await rm(
    path,
    {
      force: true,
    },
  );

  return {
    kind:
      'local_app_stop',

    stopped:
      wasRunning,

    owned:
      true,

    pid:
      receipt.pid,

    package:
      candidate,

    reason:
      wasRunning
        ? 'Stopped process created by DACAIS local-app lifecycle manager.'
        : 'Owned process had already exited; stale ownership receipt removed.',
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
      join(
        root,
        'package.json',
      ),
    )
  ) {
    throw new Error(
      'Workspace package.json was not found.',
    );
  }

  let result;

  switch (
    request.operation
  ) {
    case 'discover': {
      result = {
        kind:
          'local_app_discovery',

        candidates:
          await discover(root),
      };

      break;
    }

    case 'ensure': {
      result =
        await ensureApp(
          root,
          request,
        );

      break;
    }

    case 'status': {
      result =
        await status(root);

      break;
    }

    case 'stop': {
      result =
        await stopOwned(
          root,
          request,
        );

      break;
    }

    default:
      throw new Error(
        `Unsupported lifecycle operation "${request.operation}".`,
      );
  }

  const encoded =
    Buffer.from(
      JSON.stringify(
        result,
      ),
      'utf8',
    ).toString(
      'base64url',
    );

  console.log(
    `DACAI_LOCAL_APP_JSON:${encoded}`,
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
