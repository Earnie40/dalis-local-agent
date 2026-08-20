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
    String(hostname)
      .toLowerCase()
      .replace(
        /^\[|\]$/g,
        '',
      );

  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('127.')
  );
}

function requireLocalUrl(
  value,
) {
  const url =
    new URL(value);

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
      'browser.interact accepts only localhost/loopback HTTP(S) URLs.',
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
  const explicit =
    process.env
      .DACAI_BROWSER_EXECUTABLE_PATH;

  if (explicit) {
    if (
      await exists(
        explicit,
      )
    ) {
      return explicit;
    }

    throw new Error(
      'DACAI_BROWSER_EXECUTABLE_PATH does not exist.',
    );
  }

  const pf =
    process.env.ProgramFiles ??
    'C:\\Program Files';

  const pfx86 =
    process.env[
      'ProgramFiles(x86)'
    ] ??
    'C:\\Program Files (x86)';

  const local =
    process.env.LOCALAPPDATA ??
    '';

  const candidates = [
    join(
      pf,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),

    join(
      pfx86,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),

    join(
      local,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    ),

    join(
      pf,
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe',
    ),

    join(
      pfx86,
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
    'No local Chrome/Edge executable found.',
  );
}

function safeSegment(
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
    'interaction';
}

function selectorFor(
  action,
) {
  const selector =
    typeof action.selector ===
      'string'
      ? action.selector.trim()
      : '';

  if (!selector) {
    throw new Error(
      `Action "${action.type}" requires selector.`,
    );
  }

  return selector;
}

function allowedKey(
  value,
) {
  return [
    'Enter',
    'Escape',
    'Tab',
    'Space',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Backspace',
    'Delete',
  ].includes(
    value,
  );
}

async function elementSnapshot(
  page,
  selector,
) {
  const locator =
    page.locator(
      selector,
    );

  const count =
    await locator.count();

  if (!count) {
    return {
      selector,
      exists: false,
      count: 0,
    };
  }

  const first =
    locator.first();

  return {
    selector,
    exists: true,
    count,

    visible:
      await first
        .isVisible()
        .catch(
          () => false,
        ),

    text:
      (
        await first
          .textContent()
          .catch(
            () => null,
          )
      )
        ?.slice(
          0,
          3000,
        ),

    value:
      await first
        .inputValue()
        .catch(
          () => undefined,
        ),

    ariaExpanded:
      await first
        .getAttribute(
          'aria-expanded',
        )
        .catch(
          () => null,
        ),

    ariaSelected:
      await first
        .getAttribute(
          'aria-selected',
        )
        .catch(
          () => null,
        ),

    disabled:
      await first
        .isDisabled()
        .catch(
          () => undefined,
        ),
  };
}

async function main() {
  const payload =
    decodePayload();

  const target =
    requireLocalUrl(
      payload.url,
    );

  const actions =
    Array.isArray(
      payload.actions,
    )
      ? payload.actions.slice(
          0,
          30,
        )
      : [];

  if (!actions.length) {
    throw new Error(
      'At least one interaction action is required.',
    );
  }

  const viewportName =
    payload.viewport ===
      'mobile'
      ? 'mobile'
      : 'desktop';

  const viewport =
    viewportName ===
      'mobile'
      ? {
          width: 390,
          height: 844,
          isMobile: true,
          hasTouch: true,
        }
      : {
          width: 1440,
          height: 1000,
          isMobile: false,
          hasTouch: false,
        };

  const executable =
    await findBrowser();

  const outputDir =
    resolve(
      process.cwd(),
      '.dacai',
      'browser-artifacts',
      `${Date.now()}-${safeSegment(
        target.pathname,
      )}`,
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
        executable,

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

  const context =
    await browser.newContext({
      viewport: {
        width:
          viewport.width,

        height:
          viewport.height,
      },

      isMobile:
        viewport.isMobile,

      hasTouch:
        viewport.hasTouch,

      acceptDownloads:
        false,

      serviceWorkers:
        'block',
    });

  /*
   * Same hard network boundary as browser.capture.
   */
  await context.route(
    '**/*',
    async (route) => {
      let parsed;

      try {
        parsed =
          new URL(
            route.request()
              .url(),
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
        await route.continue();

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
        await route.continue();

        return;
      }

      await route.abort(
        'blockedbyclient',
      );
    },
  );

  const page =
    await context.newPage();

  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const badResponses = [];

  page.on(
    'console',
    (message) => {
      if (
        [
          'warning',
          'error',
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
        method:
          request.method(),

        url:
          request.url()
            .slice(
              0,
              2000,
            ),

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
          status:
            response.status(),

          url:
            response.url()
              .slice(
                0,
                2000,
              ),
        });
      }
    },
  );

  const steps = [];

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

    const beforeScreenshot =
      join(
        outputDir,
        'before.png',
      );

    await page.screenshot({
      path:
        beforeScreenshot,

      fullPage:
        true,

      animations:
        'disabled',
    });

    for (
      let index = 0;
      index <
      actions.length;
      index += 1
    ) {
      const action =
        actions[index];

      const started =
        Date.now();

      let success =
        true;

      let message =
        '';

      let observed;

      try {
        switch (
          action.type
        ) {
          case 'click': {
            const selector =
              selectorFor(
                action,
              );

            await page
              .locator(
                selector,
              )
              .first()
              .click({
                timeout:
                  10_000,
              });

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            break;
          }

          case 'type': {
            const selector =
              selectorFor(
                action,
              );

            const value =
              typeof action.value ===
                'string'
                ? action.value
                : '';

            /*
             * Bounded length prevents accidental giant payloads.
             */
            if (
              value.length >
              10_000
            ) {
              throw new Error(
                'type value exceeds 10,000 characters.',
              );
            }

            await page
              .locator(
                selector,
              )
              .first()
              .fill(
                value,
                {
                  timeout:
                    10_000,
                },
              );

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            break;
          }

          case 'select': {
            const selector =
              selectorFor(
                action,
              );

            if (
              typeof action.value !==
              'string'
            ) {
              throw new Error(
                'select requires string value.',
              );
            }

            await page
              .locator(
                selector,
              )
              .first()
              .selectOption(
                action.value,
              );

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            break;
          }

          case 'check':
          case 'uncheck': {
            const selector =
              selectorFor(
                action,
              );

            const locator =
              page
                .locator(
                  selector,
                )
                .first();

            if (
              action.type ===
              'check'
            ) {
              await locator.check({
                timeout:
                  10_000,
              });
            } else {
              await locator.uncheck({
                timeout:
                  10_000,
              });
            }

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            break;
          }

          case 'press': {
            const key =
              typeof action.key ===
                'string'
                ? action.key
                : '';

            if (
              !allowedKey(
                key,
              )
            ) {
              throw new Error(
                `Keyboard key "${key}" is not allowed.`,
              );
            }

            if (
              typeof action.selector ===
                'string' &&
              action.selector.trim()
            ) {
              await page
                .locator(
                  action.selector,
                )
                .first()
                .press(
                  key,
                );
            } else {
              await page
                .keyboard
                .press(
                  key,
                );
            }

            break;
          }

          case 'navigate': {
            if (
              typeof action.url !==
              'string'
            ) {
              throw new Error(
                'navigate requires url.',
              );
            }

            const destination =
              requireLocalUrl(
                action.url,
              );

            await page.goto(
              destination.href,
              {
                waitUntil:
                  'domcontentloaded',

                timeout:
                  30_000,
              },
            );

            break;
          }

          case 'wait': {
            const milliseconds =
              Math.min(
                5000,
                Math.max(
                  0,
                  Number(
                    action.ms ??
                    250,
                  ),
                ),
              );

            await page.waitForTimeout(
              milliseconds,
            );

            break;
          }

          case 'wait_for': {
            const selector =
              selectorFor(
                action,
              );

            await page
              .locator(
                selector,
              )
              .first()
              .waitFor({
                state:
                  action.state ===
                    'hidden'
                    ? 'hidden'
                    : 'visible',

                timeout:
                  Math.min(
                    15_000,
                    Math.max(
                      100,
                      Number(
                        action.timeoutMs ??
                        10_000,
                      ),
                    ),
                  ),
              });

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            break;
          }

          case 'assert_visible': {
            const selector =
              selectorFor(
                action,
              );

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            if (
              !observed.exists ||
              !observed.visible
            ) {
              throw new Error(
                `Expected "${selector}" to be visible.`,
              );
            }

            break;
          }

          case 'assert_hidden': {
            const selector =
              selectorFor(
                action,
              );

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            if (
              observed.exists &&
              observed.visible
            ) {
              throw new Error(
                `Expected "${selector}" to be hidden.`,
              );
            }

            break;
          }

          case 'assert_text': {
            const selector =
              selectorFor(
                action,
              );

            if (
              typeof action.value !==
              'string'
            ) {
              throw new Error(
                'assert_text requires value.',
              );
            }

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            if (
              !String(
                observed.text ??
                '',
              ).includes(
                action.value,
              )
            ) {
              throw new Error(
                `Expected "${selector}" to contain text "${action.value}".`,
              );
            }

            break;
          }

          case 'assert_value': {
            const selector =
              selectorFor(
                action,
              );

            if (
              typeof action.value !==
              'string'
            ) {
              throw new Error(
                'assert_value requires value.',
              );
            }

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            if (
              observed.value !==
              action.value
            ) {
              throw new Error(
                `Expected "${selector}" value "${action.value}", observed "${observed.value ?? ''}".`,
              );
            }

            break;
          }

          case 'assert_url': {
            if (
              typeof action.value !==
              'string'
            ) {
              throw new Error(
                'assert_url requires value.',
              );
            }

            if (
              !page
                .url()
                .includes(
                  action.value,
                )
            ) {
              throw new Error(
                `Expected URL to contain "${action.value}", observed "${page.url()}".`,
              );
            }

            break;
          }

          case 'inspect': {
            const selector =
              selectorFor(
                action,
              );

            observed =
              await elementSnapshot(
                page,
                selector,
              );

            break;
          }

          default:
            throw new Error(
              `Unsupported action type "${action.type}".`,
            );
        }

        /*
         * Prevent post-click redirects from escaping loopback.
         */
        const current =
          new URL(
            page.url(),
          );

        if (
          (
            current.protocol ===
              'http:' ||
            current.protocol ===
              'https:'
          ) &&
          !isLoopbackHost(
            current.hostname,
          )
        ) {
          throw new Error(
            `Interaction navigated to disallowed host "${current.hostname}".`,
          );
        }
      } catch (error) {
        success =
          false;

        message =
          error instanceof Error
            ? error.message
            : String(error);
      }

      steps.push({
        index,
        type:
          action.type,
        selector:
          action.selector,
        success,
        message,
        observed,
        url:
          page.url(),
        durationMs:
          Date.now() -
          started,
      });

      /*
       * Stop at first failed assertion/action.
       * Continuing could destroy useful failure state.
       */
      if (!success) {
        break;
      }
    }

    const afterScreenshot =
      join(
        outputDir,
        'after.png',
      );

    await page.screenshot({
      path:
        afterScreenshot,

      fullPage:
        true,

      animations:
        'disabled',
    });

    const finalUrl =
      page.url();

    const final =
      new URL(
        finalUrl,
      );

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
        `Final browser URL escaped loopback: ${final.hostname}`,
      );
    }

    const failedSteps =
      steps.filter(
        (step) =>
          !step.success,
      );

    const report = {
      kind:
        'local_browser_interaction',

      requestedUrl:
        target.href,

      finalUrl,

      viewport:
        viewportName,

      screenshots: {
        before:
          beforeScreenshot,

        after:
          afterScreenshot,
      },

      steps,

      actionCount:
        steps.length,

      failedActionCount:
        failedSteps.length,

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

      interactionPassed:
        failedSteps.length ===
          0 &&
        pageErrors.length ===
          0 &&
        consoleMessages
          .filter(
            (entry) =>
              entry.type ===
              'error',
          )
          .length ===
          0,

      outputDir,

      createdAt:
        new Date()
          .toISOString(),
    };

    await writeFile(
      join(
        outputDir,
        'interaction-report.json',
      ),

      JSON.stringify(
        report,
        null,
        2,
      ),

      'utf8',
    );

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
      `DACAI_BROWSER_INTERACTION_JSON:${encoded}`,
    );
  } finally {
    await context.close();
    await browser.close();
  }
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
