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

const url = new URL(payload.url);

if (
  ![
    '127.0.0.1',
    'localhost',
    '::1',
  ].includes(url.hostname)
) {
  throw new Error(
    'Video recording is localhost-only.',
  );
}

const actions =
  Array.isArray(
    payload.actions,
  )
    ? payload.actions
    : [];

const stamp =
  new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-');

const root =
  path.resolve(
    '.dacai',
    'browser-artifacts',
    `video-${stamp}`,
  );

const videoDir =
  path.join(
    root,
    'video',
  );

await fs.mkdir(
  videoDir,
  { recursive: true },
);

const browser =
  await chromium.launch({
    headless: true,
  });

const context =
  await browser.newContext({
    viewport: {
      width: 1440,
      height: 1000,
    },

    recordVideo: {
      dir:
        videoDir,

      size: {
        width: 1440,
        height: 1000,
      },
    },
  });

const page =
  await context.newPage();

await page.goto(
  url.toString(),
  {
    waitUntil:
      'domcontentloaded',
  },
);

const screenshots = [];

async function snap(label) {
  const file =
    path.resolve(
      root,
      `${String(screenshots.length).padStart(3, '0')}-${label}.png`,
    );

  await page.screenshot({
    path:
      file,

    fullPage:
      true,
  });

  screenshots.push({
    label,
    path:
      file,
  });
}

await snap('start');

for (
  let i = 0;
  i < actions.length;
  i += 1
) {
  const action =
    actions[i] ?? {};

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
        Math.max(
          0,
          Math.min(
            10000,
            Number(
              action.ms ??
              500,
            ),
          ),
        ),
      );
      break;

    default:
      throw new Error(
        `Unsupported video action: ${action.type}`,
      );
  }

  await page.waitForTimeout(
    150,
  );

  await snap(
    `action-${i + 1}`,
  );
}

await snap('end');

const cells = [];

for (
  const shot
  of screenshots
) {
  const bytes =
    await fs.readFile(
      shot.path,
    );

  cells.push(`
  <div class="cell">
    <div>${shot.label}</div>
    <img src="data:image/png;base64,${bytes.toString('base64')}">
  </div>`);
}

const sheet =
  await context.newPage();

await sheet.setContent(`
<!doctype html>
<html>
<head>
<style>
body {
  background: #111;
  color: white;
  font-family: sans-serif;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.cell {
  border: 1px solid #555;
  padding: 6px;
}
img {
  width: 100%;
  display: block;
}
</style>
</head>
<body>
<div class="grid">
${cells.join('\n')}
</div>
</body>
</html>
`);

const contactSheetPath =
  path.resolve(
    root,
    'interaction-contact-sheet.png',
  );

await sheet.screenshot({
  path:
    contactSheetPath,

  fullPage:
    true,
});

const video =
  page.video();

await context.close();

const videoPath =
  video
    ? await video.path()
    : null;

await browser.close();

const report = {
  url:
    url.toString(),

  actions:
    actions.length,

  videoPath,

  screenshots,

  contactSheetPath,
};

await fs.writeFile(
  path.join(
    root,
    'interaction.json',
  ),
  JSON.stringify(
    report,
    null,
    2,
  ),
);

console.log(
  'DACAI_VIDEO_JSON:' +
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
