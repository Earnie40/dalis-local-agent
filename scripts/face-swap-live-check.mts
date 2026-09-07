/**
 * Live end-to-end proof for video.faceSwap against the DACAIS media service.
 *
 * Fixtures are generated on the pod itself — a synthetic presenter for the
 * source face and an SVD-animated synthetic person for the target clip — so the
 * check never needs a real person's likeness. Then it drives the real
 * ToolDefinition, not a hand-rolled request, so path containment, artifact
 * validation and the swapped-frame check are all exercised.
 *
 * Usage: node --import tsx scripts/face-swap-live-check.mts [--keep]
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

for (const envFile of ['.env', '.env.local']) {
  if (!existsSync(envFile)) continue;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const { createFaceSwapTools } = await import('../packages/tools/src/face-swap-tools');
const { probeVideo } = await import('../packages/tools/src/media-artifacts');

const base = (process.env.DACAI_MEDIA_BASE_URL ?? 'http://127.0.0.1:18090').replace(/\/+$/, '');
const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
if (process.env.DACAI_MEDIA_TOKEN?.trim()) headers.Authorization = `Bearer ${process.env.DACAI_MEDIA_TOKEN.trim()}`;
const workspaceRoot = process.cwd();
const directory = join(workspaceRoot, 'generated', 'face-swap-live');
const relative = 'generated/face-swap-live';

async function media(path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 400)}`);
  console.log(`  ${path} ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return JSON.parse(text);
}

const stamp = Date.now().toString(36);
// Regenerating the fixtures costs a minute of SVD time, so a re-run against the
// same clip can reuse them; only the swap output is always rebuilt.
const reuse = process.argv.includes('--reuse')
  && existsSync(join(directory, 'face.png'))
  && existsSync(join(directory, 'clip.mp4'));
if (!reuse) await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await rm(join(directory, 'swapped.mp4'), { force: true });

if (reuse) {
  console.log('1-3/4 reusing the existing face and target clip');
  console.log('  target clip', await probeVideo(join(directory, 'clip.mp4')));
} else {
console.log('1/4 generating the source face (synthetic presenter)');
const face = await media('/v1/generate-presenter', {
  jobId: `faceswap-src-${stamp}`,
  descriptor: 'woman in her thirties with short dark hair',
  width: 1024, height: 1024, steps: 34, seed: 20260906,
});
await writeFile(join(directory, 'face.png'), Buffer.from(String(face.imageBase64), 'base64'));

console.log('2/4 generating the target person still');
const target = await media('/v1/generate-backdrop', {
  jobId: `faceswap-tgt-${stamp}`,
  prompt: 'photorealistic medium shot photograph of a bearded man in his forties standing in a bright office, '
    + 'facing the camera, neutral expression, sharp focus on the face, natural skin texture, 50mm lens',
  negativePrompt: 'cartoon, 3d render, illustration, anime, text, watermark, blurry, lowres, deformed, extra limbs',
  width: 1024, height: 576, steps: 34, guidanceScale: 5.5, seed: 40260906,
});
await writeFile(join(directory, 'target.png'), Buffer.from(String(target.imageBase64), 'base64'));

console.log('3/4 animating the target still into a clip (SVD)');
const clip = await media('/v1/animate-image', {
  jobId: `faceswap-clip-${stamp}`,
  sourceMediaBase64: String(target.imageBase64),
  sourceMimeType: 'image/png',
  width: 1024, height: 576, frames: 25, durationSeconds: 4, sourceFps: 6,
  motionBucket: 40, noiseAug: 0.02, animate: true, mode: 'auto',
});
await writeFile(join(directory, 'clip.mp4'), Buffer.from(String(clip.videoBase64), 'base64'));
console.log('  target clip', await probeVideo(join(directory, 'clip.mp4')));
}

console.log('4/4 running video.faceSwap through the real tool definition');
const tool = createFaceSwapTools()[0];
const started = Date.now();
const result = await tool.execute({
  facePath: `${relative}/face.png`,
  videoPath: `${relative}/clip.mp4`,
  outputPath: `${relative}/swapped.mp4`,
}, { workspaceRoot }) as Record<string, unknown>;

console.log(`\nswap completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(result, null, 2));

const framesSwapped = Number(result.framesSwapped);
const framesTotal = Number(result.framesTotal);
if (!(framesSwapped >= 1)) throw new Error('no frame was swapped');
console.log(`\nPASS  ${framesSwapped}/${framesTotal} frames swapped -> ${result.path}`);
if (!process.argv.includes('--keep')) {
  console.log('(pass --keep to retain the intermediate fixtures)');
}
