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
    'Trajectory capture is localhost-only.',
  );
}

const durationMs = Math.max(
  250,
  Math.min(
    15000,
    Number(payload.durationMs ?? 2500),
  ),
);

const frameCount = Math.max(
  3,
  Math.min(
    30,
    Number(payload.frames ?? 10),
  ),
);

const stamp =
  new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-');

const root =
  path.resolve(
    '.dacai',
    'browser-artifacts',
    `trajectory-${stamp}`,
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
  await browser.newContext({
    viewport: {
      width: 1440,
      height: 1000,
    },
  });

const page =
  await context.newPage();

await page.goto(
  url.toString(),
  {
    waitUntil: 'domcontentloaded',
  },
);

const frames = [];
const interval =
  durationMs /
  Math.max(
    1,
    frameCount - 1,
  );

for (
  let i = 0;
  i < frameCount;
  i += 1
) {
  const file =
    path.join(
      root,
      `frame-${String(i).padStart(3, '0')}.png`,
    );

  await page.screenshot({
    path: file,
    fullPage: true,
  });

  frames.push({
    index: i,
    timeMs:
      Math.round(i * interval),
    path: path.resolve(file),
  });

  if (
    i < frameCount - 1
  ) {
    await page.waitForTimeout(
      interval,
    );
  }
}

const images = [];

for (
  const frame
  of frames
) {
  const bytes =
    await fs.readFile(
      frame.path,
    );

  images.push(
    `<div class="frame">
      <div>${frame.timeMs} ms</div>
      <img src="data:image/png;base64,${bytes.toString('base64')}" />
    </div>`,
  );
}

const sheetPage =
  await context.newPage();

await sheetPage.setContent(`
<!doctype html>
<html>
<head>
<style>
body {
  margin: 16px;
  background: #111;
  color: white;
  font-family: sans-serif;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.frame {
  border: 1px solid #444;
  padding: 6px;
}
img {
  display: block;
  width: 100%;
  margin-top: 4px;
}
</style>
</head>
<body>
<div class="grid">
${images.join('\n')}
</div>
</body>
</html>
`);

const contactSheetPath =
  path.resolve(
    root,
    'contact-sheet.png',
  );

await sheetPage.screenshot({
  path:
    contactSheetPath,

  fullPage:
    true,
});

await browser.close();

const report = {
  url:
    url.toString(),

  durationMs,

  frameCount,

  frames,

  contactSheetPath,
};

await fs.writeFile(
  path.join(
    root,
    'trajectory.json',
  ),
  JSON.stringify(
    report,
    null,
    2,
  ),
);

console.log(
  'DACAI_TRAJECTORY_JSON:' +
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
