import type { StudioFiles } from '@dacai-local-agent/shared';

export type StudioFileKey = 'html' | 'css' | 'javascript';
/** Mirrors the server boundary without importing the Node-only shared barrel. */
export const STUDIO_MAX_FILE_CHARS = 60_000;
export type { StudioFiles };
export const STUDIO_IFRAME_SANDBOX = 'allow-scripts';
export const STUDIO_MESSAGE_CHANNEL = 'dacais-studio-preview';

const SANDBOX_CSP = [
  "default-src 'none'",
  "connect-src 'none'",
  "img-src data: blob:",
  "media-src 'none'",
  "font-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export const DEFAULT_STUDIO_FILES: StudioFiles = {
  html: `<main class="scene-shell">
  <canvas id="scene" aria-label="Interactive 3D cube"></canvas>
  <section class="scene-hud">
    <span class="eyebrow">DACAIS SANDBOX</span>
    <h1>Orbit study</h1>
    <p>Drag to rotate · double-click to reset</p>
  </section>
</main>`,
  css: `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #06090f;
  color: #f6f7fb;
}

* { box-sizing: border-box; }

html, body {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
}

.scene-shell {
  position: relative;
  width: 100%;
  height: 100%;
  background:
    radial-gradient(circle at 62% 34%, rgba(64, 136, 255, 0.2), transparent 34%),
    linear-gradient(145deg, #0b1220, #05070b 68%);
}

#scene {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

#scene:active { cursor: grabbing; }

.scene-hud {
  position: absolute;
  left: clamp(24px, 6vw, 72px);
  bottom: clamp(22px, 7vh, 64px);
  pointer-events: none;
}

.eyebrow {
  color: #72a7ff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
}

h1 {
  margin: 7px 0 2px;
  font-size: clamp(30px, 6vw, 66px);
  font-weight: 620;
  letter-spacing: -0.055em;
}

p { margin: 0; color: #94a2b8; font-size: 13px; }`,
  javascript: `const canvas = document.querySelector('#scene');
const context = canvas.getContext('2d');

const vertices = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1,  1], [1, -1,  1], [1, 1,  1], [-1, 1,  1],
];

const faces = [
  { points: [0, 1, 2, 3], color: '#2d6cdf' },
  { points: [4, 5, 6, 7], color: '#69a0ff' },
  { points: [0, 4, 7, 3], color: '#224d9a' },
  { points: [1, 5, 6, 2], color: '#4b82e5' },
  { points: [3, 2, 6, 7], color: '#8bb6ff' },
  { points: [0, 1, 5, 4], color: '#173769' },
];

let yaw = -0.65;
let pitch = 0.42;
let dragging = false;
let previous = { x: 0, y: 0 };

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function rotate([x, y, z]) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  const x1 = x * cy - z * sy;
  const z1 = x * sy + z * cy;
  return [x1, y * cx - z1 * sx, y * sx + z1 * cx];
}

function frame(time) {
  if (!dragging) yaw += 0.0022;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.clearRect(0, 0, width, height);

  const size = Math.min(width, height) * 0.22;
  const transformed = vertices.map((point) => rotate(point));
  const projected = transformed.map(([x, y, z]) => {
    const perspective = 4.8 / (5.8 + z);
    return [width * 0.58 + x * size * perspective, height * 0.45 + y * size * perspective];
  });

  const ordered = faces
    .map((face) => ({ ...face, depth: face.points.reduce((sum, index) => sum + transformed[index][2], 0) }))
    .sort((a, b) => a.depth - b.depth);

  context.lineJoin = 'round';
  for (const face of ordered) {
    context.beginPath();
    face.points.forEach((index, pointIndex) => {
      const [x, y] = projected[index];
      if (pointIndex === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.globalAlpha = 0.78;
    context.fillStyle = face.color;
    context.fill();
    context.globalAlpha = 0.8;
    context.strokeStyle = '#cfe0ff';
    context.lineWidth = 1.2;
    context.stroke();
  }

  context.globalAlpha = 1;
  requestAnimationFrame(frame);
}

canvas.addEventListener('pointerdown', (event) => {
  dragging = true;
  previous = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  yaw += (event.clientX - previous.x) * 0.009;
  pitch = Math.max(-1.25, Math.min(1.25, pitch + (event.clientY - previous.y) * 0.009));
  previous = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointercancel', () => { dragging = false; });
canvas.addEventListener('dblclick', () => { yaw = -0.65; pitch = 0.42; });
window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
console.log('Interactive 3D scene ready');`,
};

function assertFiles(files: StudioFiles): void {
  for (const [name, value] of Object.entries(files)) {
    if (typeof value !== 'string') throw new Error(`${name} must be text.`);
    if (value.length > STUDIO_MAX_FILE_CHARS) {
      throw new Error(`${name} exceeds the ${STUDIO_MAX_FILE_CHARS.toLocaleString()} character sandbox limit.`);
    }
  }
}

function escapeClosingTag(value: string, tag: 'script' | 'style'): string {
  return value.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8_192));
  }
  return btoa(binary);
}

function authoredSourceBootstrap(files: StudioFiles): string {
  const html = encodeUtf8Base64(files.html);
  const css = encodeUtf8Base64(files.css);
  const javascript = encodeUtf8Base64(files.javascript);
  return `(() => {
  const decode = (value) => {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };
  const style = document.createElement('style');
  style.textContent = decode(${JSON.stringify(css)});
  document.head.append(style);
  document.querySelector('#studio-root').innerHTML = decode(${JSON.stringify(html)});
  const authoredScript = document.createElement('script');
  authoredScript.textContent = decode(${JSON.stringify(javascript)});
  document.body.append(authoredScript);
})();`;
}

function consoleBridge(runId: string): string {
  return `(() => {
  const channel = ${JSON.stringify(STUDIO_MESSAGE_CHANNEL)};
  const runId = ${JSON.stringify(runId)};
  let sent = 0;
  const stringify = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const send = (type, values) => {
    if (sent >= 100) return;
    sent += 1;
    const text = (Array.isArray(values) ? values : [values]).map(stringify).join(' ').slice(0, 4000);
    parent.postMessage({ channel, runId, type, text }, '*');
  };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...values) => { original(...values); send(level, values); };
  }
  addEventListener('error', (event) => send('error', event.error || event.message));
  addEventListener('unhandledrejection', (event) => send('error', event.reason));
  send('ready', 'Preview connected');
})();`;
}

export function isStudioFiles(value: unknown): value is StudioFiles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StudioFiles>;
  return (
    typeof candidate.html === 'string' && candidate.html.length <= STUDIO_MAX_FILE_CHARS &&
    typeof candidate.css === 'string' && candidate.css.length <= STUDIO_MAX_FILE_CHARS &&
    typeof candidate.javascript === 'string' && candidate.javascript.length <= STUDIO_MAX_FILE_CHARS
  );
}

export type StudioPreviewMessageType = 'ready' | 'log' | 'info' | 'warn' | 'error';

export interface StudioPreviewMessage {
  channel: typeof STUDIO_MESSAGE_CHANNEL;
  runId: string;
  type: StudioPreviewMessageType;
  text: string;
}

export function parseStudioPreviewMessage(value: unknown, currentRunId: string): StudioPreviewMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['channel', 'runId', 'type', 'text'].includes(key))) return undefined;
  if (record.channel !== STUDIO_MESSAGE_CHANNEL || record.runId !== currentRunId) return undefined;
  if (!['ready', 'log', 'info', 'warn', 'error'].includes(String(record.type))) return undefined;
  if (typeof record.text !== 'string' || record.text.length > 4_000) return undefined;
  return record as unknown as StudioPreviewMessage;
}

/**
 * Builds an opaque-origin iframe document. The CSP is emitted before any
 * authored markup, and the parent bridge only accepts bounded display data.
 */
export function buildStudioDocument(files: StudioFiles, runId: string): string {
  assertFiles(files);
  const bridge = escapeClosingTag(consoleBridge(runId), 'script');
  const bootstrap = escapeClosingTag(authoredSourceBootstrap(files), 'script');

  return `<!doctype html>
<html lang="en">
<head>
  <meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>html, body, #studio-root { width: 100%; height: 100%; margin: 0; }</style>
</head>
<body>
  <script>${bridge}</script>
  <div id="studio-root"></div>
  <script>${bootstrap}</script>
</body>
</html>`;
}

/** A self-contained export with the same no-network policy and no host bridge. */
export function buildStandaloneStudioDocument(files: StudioFiles): string {
  assertFiles(files);
  const bootstrap = escapeClosingTag(authoredSourceBootstrap(files), 'script');
  return `<!doctype html>
<html lang="en">
<head>
  <meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>html, body, #studio-root { width: 100%; height: 100%; margin: 0; }</style>
</head>
<body>
  <div id="studio-root"></div>
  <script>${bootstrap}</script>
</body>
</html>`;
}
