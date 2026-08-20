import {
  access,
  mkdir,
  writeFile,
} from 'node:fs/promises';

import {
  join,
  resolve,
} from 'node:path';

import process from 'node:process';

import {
  chromium,
} from 'playwright-core';

function decodePayload() {
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

function isLoopbackHost(
  hostname,
) {
  const host =
    hostname
      .toLowerCase()
      .replace(
        /^\[|\]$/g,
        '',
      );

  return (
    host ===
      'localhost' ||
    host ===
      '127.0.0.1' ||
    host ===
      '::1' ||
    host.startsWith(
      '127.',
    )
  );
}

function requireLocalUrl(
  value,
) {
  let url;

  try {
    url =
      new URL(value);
  } catch {
    throw new Error(
      `Invalid browser URL: ${value}`,
    );
  }

  if (
    (
      url.protocol !==
        'http:' &&
      url.protocol !==
        'https:'
    ) ||
    !isLoopbackHost(
      url.hostname,
    )
  ) {
    throw new Error(
      'browser.capture accepts only localhost/loopback HTTP(S) URLs.',
    );
  }

  return url;
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

async function findBrowser() {
  if (
    process.env
      .DACAI_BROWSER_EXECUTABLE_PATH
  ) {
    if (
      await exists(
        process.env
          .DACAI_BROWSER_EXECUTABLE_PATH,
      )
    ) {
      return process.env
        .DACAI_BROWSER_EXECUTABLE_PATH;
    }

    throw new Error(
      'DACAI_BROWSER_EXECUTABLE_PATH is set but the file does not exist.',
    );
  }

  const programFiles =
    process.env.ProgramFiles ??
    'C:\\Program Files';

  const programFilesX86 =
    process.env[
      'ProgramFiles(x86)'
    ] ??
    'C:\\Program Files (x86)';

  const localAppData =
    process.env.LOCALAPPDATA ??
    '';

  const candidates = [
    join(
      programFiles,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),

    join(
      programFilesX86,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),

    join(
      localAppData,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),

    join(
      programFiles,
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe',
    ),

    join(
      programFilesX86,
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe',
    ),
  ];

  for (
    const candidate
    of candidates
  ) {
    if (
      await exists(
        candidate,
      )
    ) {
      return candidate;
    }
  }

  throw new Error(
    [
      'No supported local Chromium browser was found.',
      'Install Chrome/Edge or set DACAI_BROWSER_EXECUTABLE_PATH.',
    ].join(
      ' ',
    ),
  );
}

function sanitizeSegment(
  value,
) {
  return String(value)
    .replace(
      /[^a-zA-Z0-9_-]+/g,
      '-',
    )
    .replace(
      /^-+|-+$/g,
      '',
    )
    .slice(
      0,
      80,
    ) ||
    'capture';
}

const VIEWPORTS = {
  desktop: {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    isMobile: false,
  },

  mobile: {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  },
};

async function main() {
  const payload =
    decodePayload();

  const target =
    requireLocalUrl(
      payload.url,
    );

  const mode =
    payload.mode ===
      'desktop' ||
    payload.mode ===
      'mobile'
      ? payload.mode
      : 'both';

  const waitMs =
    Math.min(
      10_000,
      Math.max(
        0,
        Number(
          payload.waitMs ??
          800,
        ),
      ),
    );

  const browserExecutable =
    await findBrowser();

  const artifactRoot =
    resolve(
      process.cwd(),
      '.dacai',
      'browser-artifacts',
    );

  const captureId =
    `${Date.now()}-${sanitizeSegment(
      target.pathname,
    )}`;

  const outputDir =
    join(
      artifactRoot,
      captureId,
    );

  await mkdir(
    outputDir,
    {
      recursive: true,
    },
  );

  const browser =
    await chromium.launch({
      executablePath:
        browserExecutable,

      headless: true,

      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
      ],
    });

  const requestedViewports =
    mode === 'both'
      ? [
          'desktop',
          'mobile',
        ]
      : [
          mode,
        ];

  const captures = [];

  try {
    for (
      const viewportName
      of requestedViewports
    ) {
      const viewport =
        VIEWPORTS[
          viewportName
        ];

      const context =
        await browser
          .newContext({
            viewport: {
              width:
                viewport.width,

              height:
                viewport.height,
            },

            deviceScaleFactor:
              viewport
                .deviceScaleFactor,

            isMobile:
              viewport.isMobile,

            hasTouch:
              viewport.hasTouch ??
              false,

            acceptDownloads:
              false,

            serviceWorkers:
              'block',
          });

      /*
       * Hard network boundary:
       * local HTTP(S), data:, blob: and browser-internal
       * resources only.
       */
      await context.route(
        '**/*',
        async (route) => {
          const requestUrl =
            route.request()
              .url();

          let parsed;

          try {
            parsed =
              new URL(
                requestUrl,
              );
          } catch {
            await route.abort(
              'blockedbyclient',
            );

            return;
          }

          if (
            parsed.protocol ===
              'data:' ||
            parsed.protocol ===
              'blob:' ||
            parsed.protocol ===
              'about:'
          ) {
            await route
              .continue();

            return;
          }

          if (
            (
              parsed.protocol ===
                'http:' ||
              parsed.protocol ===
                'https:'
            ) &&
            isLoopbackHost(
              parsed.hostname,
            )
          ) {
            await route
              .continue();

            return;
          }

          await route.abort(
            'blockedbyclient',
          );
        },
      );

      const page =
        await context
          .newPage();

      const consoleMessages =
        [];

      const pageErrors =
        [];

      const failedRequests =
        [];

      const badResponses =
        [];

      page.on(
        'console',
        (message) => {
          if (
            [
              'error',
              'warning',
            ].includes(
              message.type(),
            )
          ) {
            consoleMessages.push({
              type:
                message.type(),

              text:
                message.text()
                  .slice(
                    0,
                    3000,
                  ),
            });
          }
        },
      );

      page.on(
        'pageerror',
        (error) => {
          pageErrors.push(
            String(
              error?.message ??
              error,
            ).slice(
              0,
              3000,
            ),
          );
        },
      );

      page.on(
        'requestfailed',
        (request) => {
          failedRequests.push({
            url:
              request.url()
                .slice(
                  0,
                  2000,
                ),

            method:
              request.method(),

            error:
              request
                .failure()
                ?.errorText ??
              'request failed',
          });
        },
      );

      page.on(
        'response',
        (response) => {
          if (
            response.status() >=
            400
          ) {
            badResponses.push({
              url:
                response.url()
                  .slice(
                    0,
                    2000,
                  ),

              status:
                response.status(),
            });
          }
        },
      );

      let navigationError;

      try {
        await page.goto(
          target.href,
          {
            waitUntil:
              'domcontentloaded',

            timeout:
              30_000,
          },
        );

        if (
          waitMs > 0
        ) {
          await page.waitForTimeout(
            waitMs,
          );
        }
      } catch (error) {
        navigationError =
          error instanceof Error
            ? error.message
            : String(error);
      }

      /*
       * Never accept a redirect outside the local boundary.
       */
      let finalUrl =
        page.url();

      try {
        const final =
          new URL(finalUrl);

        if (
          (
            final.protocol ===
              'http:' ||
            final.protocol ===
              'https:'
          ) &&
          !isLoopbackHost(
            final.hostname,
          )
        ) {
          throw new Error(
            `Local UI redirected to disallowed host: ${final.hostname}`,
          );
        }
      } catch (error) {
        navigationError ??=
          error instanceof Error
            ? error.message
            : String(error);
      }

      const screenshotPath =
        join(
          outputDir,
          `${viewportName}.png`,
        );

      let screenshotCreated =
        false;

      try {
        await page.screenshot({
          path:
            screenshotPath,

          fullPage:
            true,

          animations:
            'disabled',
        });

        screenshotCreated =
          true;
      } catch (error) {
        navigationError ??=
          `Screenshot failed: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`;
      }

      const title =
        await page.title()
          .catch(
            () => '',
          );

      captures.push({
        viewport:
          viewportName,

        viewportSize: {
          width:
            viewport.width,

          height:
            viewport.height,
        },

        requestedUrl:
          target.href,

        finalUrl,

        title,

        screenshotPath:
          screenshotCreated
            ? screenshotPath
            : undefined,

        navigationError,

        consoleMessages:
          consoleMessages.slice(
            0,
            50,
          ),

        pageErrors:
          pageErrors.slice(
            0,
            50,
          ),

        failedRequests:
          failedRequests.slice(
            0,
            50,
          ),

        badResponses:
          badResponses.slice(
            0,
            50,
          ),
      });

      await context.close();
    }
  } finally {
    await browser.close();
  }

  const report = {
    kind:
      'local_browser_capture',

    captureId,

    browserExecutable,

    outputDir,

    captures,

    hasRuntimeErrors:
      captures.some(
        (capture) =>
          Boolean(
            capture
              .navigationError,
          ) ||
          capture.pageErrors
            .length > 0 ||
          capture.consoleMessages
            .some(
              (entry) =>
                entry.type ===
                'error',
            ) ||
          capture.badResponses
            .length > 0,
      ),

    createdAt:
      new Date()
        .toISOString(),
  };

  await writeFile(
    join(
      outputDir,
      'report.json',
    ),

    JSON.stringify(
      report,
      null,
      2,
    ),

    'utf8',
  );

  /*
   * Shell wrapper extracts this marker without depending on
   * shell.run's human-readable formatting.
   */
  const encoded =
    Buffer.from(
      JSON.stringify(
        report,
      ),
      'utf8',
    ).toString(
      'base64url',
    );

  console.log(
    `DACAI_BROWSER_CAPTURE_JSON:${encoded}`,
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
