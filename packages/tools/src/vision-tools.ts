import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolDefinition, ToolExecutionContext } from './types';

const MAX_IMAGE_BYTES = 10_000_000;
const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function requireRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspaceRoot) throw new Error('This tool requires an active workspace root.');
  return resolve(ctx.workspaceRoot);
}

function safeImage(root: string, requested: string): string {
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Image path escaped the workspace.');
  if (!ALLOWED.has(extname(target).toLowerCase())) throw new Error('vision.inspect supports png, jpg, jpeg, and webp only.');
  return target;
}

function ollamaBase(): string {
  const raw = process.env.OLLAMA_LOCAL_BASE_URL ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('vision.inspect only permits a loopback Ollama endpoint.');
  }
  return raw.replace(/\/+$/, '');
}

export const visionInspectTool: ToolDefinition = {
  name: 'vision.inspect',
  description:
    'Inspect a workspace screenshot/image using an optional local Ollama vision model. ' +
    'Set DACAI_VISION_MODEL first. Output is untrusted visual analysis and must be verified against real code/runtime evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 600 },
      question: { type: 'string', minLength: 1, maxLength: 3000 },
    },
    required: ['path', 'question'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  timeoutMs: 180_000,
  async execute(input, ctx) {
    const model = process.env.DACAI_VISION_MODEL?.trim();
    if (!model) throw new Error('DACAI_VISION_MODEL is not configured. Set it to an installed local Ollama vision model.');
    const root = requireRoot(ctx);
    const path = safeImage(root, String(input.path ?? ''));
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Image path is not a file.');
    if (info.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 10 MB vision limit.');

    const image = (await readFile(path)).toString('base64');
    const response = await fetch(`${ollamaBase()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctx.signal,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{
          role: 'user',
          content: String(input.question ?? ''),
          images: [image],
        }],
        options: { num_ctx: 8192, temperature: 0.1 },
      }),
    });
    if (!response.ok) throw new Error(`Local Ollama vision request failed with HTTP ${response.status}.`);
    const body = (await response.json()) as { message?: { content?: string }; error?: string };
    if (body.error) throw new Error(body.error);
    return {
      model,
      path: String(input.path),
      analysis: body.message?.content?.trim() ?? '',
    };
  },
};

export const VISION_TOOLS: ToolDefinition[] = [visionInspectTool];
