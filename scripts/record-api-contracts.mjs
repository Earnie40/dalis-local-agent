import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const payload = JSON.parse(
  Buffer.from(
    arg('--payload') ?? '',
    'base64url',
  ).toString('utf8'),
);

const startUrl =
  new URL(
    payload.url,
  );

if (
  ![
    '127.0.0.1',
    'localhost',
    '::1',
  ].includes(
    startUrl.hostname,
  )
) {
  throw new Error(
    'API contract recording is localhost-only.',
  );
}

const SECRET_KEYS =
  /token|secret|password|authorization|cookie|api.?key|credential|signature/i;

function shape(value, depth = 0) {
  if (depth > 6) {
    return {
      type:
        'truncated',
    };
  }

  if (value === null) {
    return {
      type:
        'null',
    };
  }

  if (
    Array.isArray(value)
  ) {
    return {
      type:
        'array',

      item:
        value.length
          ? shape(
              value[0],
              depth + 1,
            )
          : {
              type:
                'unknown',
            },
    };
  }

  switch (
    typeof value
  ) {
    case 'object': {
      const properties = {};

      for (
        const [
          key,
          nested,
        ]
        of Object.entries(value)
      ) {
        properties[key] =
          SECRET_KEYS.test(key)
            ? {
                type:
                  'redacted',
              }
            : shape(
                nested,
                depth + 1,
              );
      }

      return {
        type:
          'object',

        properties,
      };
    }

    case 'string':
      return {
        type:
          'string',
      };

    case 'number':
      return {
        type:
          'number',
      };

    case 'boolean':
      return {
        type:
          'boolean',
      };

    default:
      return {
        type:
          typeof value,
      };
  }
}

function routeFor(raw) {
  const url =
    new URL(raw);

  const queryKeys =
    Array.from(
      url.searchParams.keys(),
    );

  return {
    origin:
      url.origin,

    pathname:
      url.pathname,

    queryKeys,
  };
}

const stamp =
  new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-');

const root =
  path.resolve(
    '.dacai',
    'api-contracts',
  );

await fs.mkdir(
  root,
  { recursive: true },
);

const browser =
  await chromium.launch({
    headless: true,
  });

const context =
  await browser.newContext();

const page =
  await context.newPage();

const exchanges = [];
const pending =
  new Map();

page.on(
  'request',
  (request) => {
    if (
      ![
        'fetch',
        'xhr',
      ].includes(
        request.resourceType(),
      )
    ) {
      return;
    }

    const route =
      routeFor(
        request.url(),
      );

    if (
      route.origin !==
      startUrl.origin
    ) {
      return;
    }

    let requestBody = null;

    try {
      requestBody =
        request.postDataJSON();
    } catch {
      requestBody = null;
    }

    pending.set(
      request,
      {
        method:
          request.method(),

        route,

        requestShape:
          requestBody ===
          null
            ? null
            : shape(
                requestBody,
              ),
      },
    );
  },
);

page.on(
  'response',
  async (
    response,
  ) => {
    const request =
      response.request();

    const base =
      pending.get(
        request,
      );

    if (!base) {
      return;
    }

    pending.delete(
      request,
    );

    const headers =
      response.headers();

    let responseShape =
      null;

    if (
      /application\/json/i.test(
        headers[
          'content-type'
        ] ?? '',
      )
    ) {
      try {
        const body =
          await response.json();

        responseShape =
          shape(
            body,
          );
      } catch {
        responseShape =
          null;
      }
    }

    exchanges.push({
      ...base,

      status:
        response.status(),

      contentType:
        headers[
          'content-type'
        ] ?? null,

      responseShape,
    });
  },
);

await page.goto(
  startUrl.toString(),
  {
    waitUntil:
      'domcontentloaded',
  },
);

const actions =
  Array.isArray(
    payload.actions,
  )
    ? payload.actions
    : [];

for (
  const action
  of actions
) {
  switch (
    action.type
  ) {
    case 'click':
      await page.locator(
        action.selector,
      ).click();
      break;

    case 'fill':
      await page.locator(
        action.selector,
      ).fill(
        String(
          action.value ?? '',
        ),
      );
      break;

    case 'press':
      await page.locator(
        action.selector,
      ).press(
        String(
          action.key ?? 'Enter',
        ),
      );
      break;

    case 'wait':
      await page.waitForTimeout(
        Math.min(
          10000,
          Number(
            action.ms ?? 500,
          ),
        ),
      );
      break;

    default:
      throw new Error(
        `Unsupported contract action: ${action.type}`,
      );
  }
}

await page.waitForTimeout(
  Math.max(
    500,
    Math.min(
      30000,
      Number(
        payload.durationMs ??
        1000,
      ),
    ),
  ),
);

await browser.close();

const contract = {
  source:
    startUrl.origin,

  recordedAt:
    new Date()
      .toISOString(),

  exchanges,
};

const contractPath =
  path.resolve(
    root,
    `contract-${stamp}.json`,
  );

await fs.writeFile(
  contractPath,
  JSON.stringify(
    contract,
    null,
    2,
  ),
);

const report = {
  contractPath,

  exchangeCount:
    exchanges.length,
};

console.log(
  'DACAI_CONTRACT_JSON:' +
  Buffer
    .from(
      JSON.stringify(
        report,
      ),
    )
    .toString(
      'base64url',
    ),
);
