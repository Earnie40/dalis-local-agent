import fs from 'node:fs/promises';
import path from 'node:path';

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

const requested =
  path.resolve(
    payload.contractPath,
  );

const allowed =
  path.resolve(
    '.dacai',
    'api-contracts',
  );

const relative =
  path.relative(
    allowed,
    requested,
  );

if (
  relative.startsWith('..') ||
  path.isAbsolute(relative)
) {
  throw new Error(
    'Mock generation only accepts contracts recorded under .dacai/api-contracts.',
  );
}

const contract =
  JSON.parse(
    await fs.readFile(
      requested,
      'utf8',
    ),
  );

function example(shape) {
  if (!shape) return null;

  switch (shape.type) {
    case 'string':
      return 'example';

    case 'number':
      return 0;

    case 'boolean':
      return false;

    case 'null':
      return null;

    case 'array':
      return [
        example(
          shape.item,
        ),
      ];

    case 'object': {
      const result = {};

      for (
        const [
          key,
          nested,
        ]
        of Object.entries(
          shape.properties ?? {},
        )
      ) {
        if (
          nested?.type ===
          'redacted'
        ) {
          continue;
        }

        result[key] =
          example(
            nested,
          );
      }

      return result;
    }

    default:
      return null;
  }
}

const mocks =
  (contract.exchanges ?? [])
    .map(
      (
        exchange,
        index,
      ) => ({
        id:
          `mock_${index + 1}`,

        method:
          exchange.method,

        pathname:
          exchange.route
            ?.pathname,

        status:
          exchange.status,

        response:
          example(
            exchange.responseShape,
          ),
      }),
    );

const outDir =
  path.resolve(
    '.dacai',
    'generated-mocks',
  );

await fs.mkdir(
  outDir,
  { recursive: true },
);

const stamp =
  new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-');

const mockPath =
  path.join(
    outDir,
    `mock-${stamp}.ts`,
  );

const source = `/**
 * AUTO-GENERATED DACAIS API MOCK CANDIDATE
 *
 * NOT PRODUCTION CONFIGURATION.
 * NOT PROOF THAT THE REAL API WORKS.
 * Generated only from sanitized observed contract shapes.
 */

export const generatedApiMocks = ${JSON.stringify(
  mocks,
  null,
  2,
)} as const;

export function findGeneratedMock(
  method: string,
  pathname: string,
) {
  return generatedApiMocks.find(
    (mock) =>
      mock.method === method &&
      mock.pathname === pathname,
  );
}
`;

await fs.writeFile(
  mockPath,
  source,
  'utf8',
);

const report = {
  mockPath:
    path.resolve(
      mockPath,
    ),

  mocks:
    mocks.length,

  activated:
    false,

  realApiVerified:
    false,
};

console.log(
  'DACAI_MOCK_JSON:' +
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
