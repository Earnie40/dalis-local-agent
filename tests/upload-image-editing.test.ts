import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyDirectMediaRequest,
  isImageEditRequest,
  isImageGenerationRequest,
  isMultiImageReferenceGenerationRequest,
  lastGeneratedImageFromHistory,
} from '../apps/server/src/routes/agent';
import { uploadFailure } from '../apps/server/src/routes/uploads';
import {
  fitGenerationSize,
  readImageDimensions,
  attachmentsIndicateFaceSwap,
  faceSwapPairs,
  normalizeAgentAttachments,
  renderUploadsForPrompt,
  selectEditableImage,
  workspaceImageDescriptor,
  UploadError,
  type UploadDescriptor,
} from '../apps/server/src/workspace-uploads';

function upload(overrides: Partial<UploadDescriptor> = {}): UploadDescriptor {
  return {
    id: 'stored-id',
    name: 'shot.png',
    path: '.dacai/uploads/stored-id',
    bytes: 1024,
    mimeType: 'image/png',
    kind: 'binary',
    uploadedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal but structurally valid headers for the three accepted formats. */
function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(21);
  buffer.writeUInt16BE(0xffd8, 0);
  // A JFIF APP0 segment the scanner must skip before reaching the frame header.
  buffer.writeUInt16BE(0xffe0, 2);
  buffer.writeUInt16BE(6, 4);
  buffer.writeUInt16BE(0xffc0, 10);
  buffer.writeUInt16BE(11, 12);
  buffer.writeUInt8(8, 14);
  buffer.writeUInt16BE(height, 15);
  buffer.writeUInt16BE(width, 17);
  return buffer;
}

function webpLossyHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8 ', 12, 'ascii');
  buffer.writeUInt8(0x9d, 23);
  buffer.writeUInt8(0x01, 24);
  buffer.writeUInt8(0x2a, 25);
  buffer.writeUInt16LE(width, 26);
  buffer.writeUInt16LE(height, 28);
  return buffer;
}

describe('media intent with an attached image', () => {
  const attached = { hasImageAttachment: true };

  it('treats an edit instruction as an image request once a picture is attached', () => {
    // The regression: none of these name an image, so before the attachment
    // signal they were classified as ordinary coding prompts.
    expect(isImageGenerationRequest('make her hair blonde', [], attached)).toBe(true);
    expect(isImageGenerationRequest('remove the background', [], attached)).toBe(true);
    expect(isImageGenerationRequest('recolor the jacket', [], attached)).toBe(true);
    expect(isImageGenerationRequest('crop it tighter', [], attached)).toBe(true);
    expect(classifyDirectMediaRequest('make her hair blonde', [], attached)).toBe('image');
  });

  it('accepts shorthand that never names the image', () => {
    // With a picture attached, any non-empty instruction is treated as an edit,
    // including terse phrasing that carries no verb at all.
    expect(isImageGenerationRequest('brighter, warmer tone', [], attached)).toBe(true);
    expect(isImageEditRequest('brighter, warmer tone', attached)).toBe(true);
  });

  it('routes the same wording to the edit path', () => {
    expect(isImageEditRequest('make her hair blonde', attached)).toBe(true);
  });

  it('still lets an explicit video request win over an attached image', () => {
    expect(classifyDirectMediaRequest('animate this photo into a clip', [], attached)).toBe('video');
  });

  it('leaves behaviour unchanged when nothing is attached', () => {
    expect(isImageGenerationRequest('make her hair blonde')).toBe(false);
    expect(isImageGenerationRequest('Draw a cinematic portrait of an astronaut')).toBe(true);
    expect(isImageGenerationRequest('Improve this repository documentation')).toBe(false);
    expect(classifyDirectMediaRequest('Improve this repository documentation')).toBeUndefined();
  });

  it('does not classify an empty prompt as an image request', () => {
    expect(isImageGenerationRequest('   ', [], attached)).toBe(false);
    expect(isImageEditRequest('   ', attached)).toBe(false);
  });
});

describe('multiple attached identity references', () => {
  const references = { hasImageAttachment: true, imageAttachmentCount: 2 };

  it('treats a new shared scene as generation with references, not a single-image edit', () => {
    const prompt = 'Create one new complete image using both attached photos as identity references, together in the same kitchen scene.';
    expect(isMultiImageReferenceGenerationRequest(prompt, references)).toBe(true);
    expect(isImageGenerationRequest(prompt, [], references)).toBe(true);
    expect(isImageEditRequest(prompt, references)).toBe(false);
    expect(classifyDirectMediaRequest(prompt, [], references)).toBe('image');
  });

  it('keeps an explicit modification of attached images on the edit path', () => {
    const prompt = 'Edit the attached image to make her hair blonde.';
    expect(isMultiImageReferenceGenerationRequest(prompt, references)).toBe(false);
    expect(isImageEditRequest(prompt, references)).toBe(true);
  });

  it('does not turn an edit of both attachments into reference generation', () => {
    const prompt = 'Edit both attached photos to make their clothing blue.';
    expect(isMultiImageReferenceGenerationRequest(prompt, references)).toBe(false);
    expect(isImageEditRequest(prompt, references)).toBe(true);
  });
});

describe('selectEditableImage', () => {
  it('picks the most recently attached editable image', () => {
    const first = upload({ id: 'a', name: 'first.png' });
    const second = upload({ id: 'b', name: 'second.jpg', mimeType: 'image/jpeg' });
    expect(selectEditableImage([first, second])?.id).toBe('b');
  });

  it('ignores formats image.generate cannot use as a source', () => {
    expect(selectEditableImage([upload({ mimeType: 'application/pdf' })])).toBeUndefined();
    expect(selectEditableImage([upload({ mimeType: 'image/gif' })])).toBeUndefined();
    expect(selectEditableImage([upload({ kind: 'text', mimeType: 'text/plain' })])).toBeUndefined();
  });

  it('returns undefined when nothing is attached', () => {
    expect(selectEditableImage([])).toBeUndefined();
  });
});

describe('readImageDimensions', () => {
  it('reads PNG, JPEG and WebP headers', () => {
    expect(readImageDimensions(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(readImageDimensions(jpegHeader(800, 1200))).toEqual({ width: 800, height: 1200 });
    expect(readImageDimensions(webpLossyHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('returns undefined for data it cannot parse', () => {
    expect(readImageDimensions(Buffer.from('not an image'))).toBeUndefined();
    expect(readImageDimensions(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('fitGenerationSize', () => {
  it('preserves aspect ratio instead of forcing a square', () => {
    const fitted = fitGenerationSize({ width: 1920, height: 1080 });
    expect(fitted.width).toBe(1536);
    expect(fitted.height).toBe(864);
    // The decisive property: a landscape source does not come back square.
    expect(fitted.width).toBeGreaterThan(fitted.height);
  });

  it('keeps a portrait taller than it is wide', () => {
    const fitted = fitGenerationSize({ width: 1080, height: 1920 });
    expect(fitted.height).toBeGreaterThan(fitted.width);
    expect(fitted.height).toBe(1536);
  });

  it('clamps within the range image.generate accepts and snaps to a multiple of 8', () => {
    for (const source of [
      { width: 4000, height: 3000 },
      { width: 100, height: 50 },
      { width: 1023, height: 767 },
    ]) {
      const fitted = fitGenerationSize(source);
      expect(fitted.width).toBeGreaterThanOrEqual(256);
      expect(fitted.height).toBeGreaterThanOrEqual(256);
      expect(fitted.width).toBeLessThanOrEqual(1536);
      expect(fitted.height).toBeLessThanOrEqual(1536);
      expect(fitted.width % 8).toBe(0);
      expect(fitted.height % 8).toBe(0);
    }
  });

  it('leaves an in-range square untouched', () => {
    expect(fitGenerationSize({ width: 1024, height: 1024 })).toEqual({ width: 1024, height: 1024 });
  });
});

describe('renderUploadsForPrompt for images', () => {
  it('tells the model to pass the stored path as sourcePath', () => {
    const rendered = renderUploadsForPrompt([upload({ path: '.dacai/uploads/x.png' })]);
    expect(rendered).toContain('sourcePath');
    expect(rendered).toContain('.dacai/uploads/x.png');
    expect(rendered).toContain('Do not invent a different path');
  });

  it('still describes a non-image binary as tool-readable', () => {
    const rendered = renderUploadsForPrompt([
      upload({ name: 'report.pdf', mimeType: 'application/pdf', path: '.dacai/uploads/report.pdf' }),
    ]);
    expect(rendered).toContain('Read it with a tool');
    expect(rendered).not.toContain('sourcePath');
  });

  it('emits authoritative face-swap paths from composer roles', () => {
    const rendered = renderUploadsForPrompt([
      upload({ id: 'face', name: 'face.png', path: '.dacai/uploads/face.png', role: 'face' }),
      upload({
        id: 'clip', name: 'clip.mp4', path: '.dacai/uploads/clip.mp4',
        mimeType: 'video/mp4', role: 'video', targetFaceIndex: 1,
      }),
    ]);
    expect(rendered).toContain('facePath = .dacai/uploads/face.png');
    expect(rendered).toContain('video.faceSwap videoPath = .dacai/uploads/clip.mp4');
    expect(rendered).toContain('targetFaceIndex = 1');
    expect(rendered).toContain('Do not invent a different path');
  });
});

describe('labeled agent attachments', () => {
  it('accepts both the legacy id list and the role objects', () => {
    expect(normalizeAgentAttachments(['a', { id: 'b', role: 'face' }, { id: 'c', role: 'video', targetFaceIndex: 2 }])).toEqual([
      { id: 'a' },
      { id: 'b', role: 'face', targetFaceIndex: undefined, swapTargetId: undefined },
      { id: 'c', role: 'video', targetFaceIndex: 2, swapTargetId: undefined },
    ]);
  });

  it('detects a marked face plus clip as a face-swap request', () => {
    expect(attachmentsIndicateFaceSwap([
      upload({ role: 'face' }),
      upload({ mimeType: 'video/mp4', role: 'video' }),
    ])).toBe(true);
    expect(attachmentsIndicateFaceSwap([upload({ role: 'face' })])).toBe(false);
  });

  it('maps each face onto a person or character still', () => {
    const clip = upload({ id: 'clip', name: 'clip.mp4', path: '.dacai/uploads/clip.mp4', mimeType: 'video/mp4', role: 'video' });
    const left = upload({ id: 'alice', name: 'alice.png', path: '.dacai/uploads/alice.png', role: 'face', swapTargetId: 'person:0' });
    const right = upload({ id: 'bob', name: 'bob.png', path: '.dacai/uploads/bob.png', role: 'face', swapTargetId: 'char-1' });
    const still = upload({ id: 'char-1', name: 'right.jpg', path: '.dacai/uploads/right.jpg', mimeType: 'image/jpeg', role: 'character' });
    expect(faceSwapPairs([left, right, still, clip])).toEqual([
      {
        facePath: '.dacai/uploads/alice.png', faceName: 'alice.png', videoPath: '.dacai/uploads/clip.mp4',
        targetReferencePath: undefined, targetFaceIndex: 0, targetLabel: 'person 1 from the left',
      },
      {
        facePath: '.dacai/uploads/bob.png', faceName: 'bob.png', videoPath: '.dacai/uploads/clip.mp4',
        targetReferencePath: '.dacai/uploads/right.jpg', targetFaceIndex: undefined, targetLabel: 'character still right.jpg',
      },
    ]);
    const rendered = renderUploadsForPrompt([left, right, still, clip]);
    expect(rendered).toContain('pair 1: facePath = .dacai/uploads/alice.png');
    expect(rendered).toContain('pair 2: facePath = .dacai/uploads/bob.png');
    expect(rendered).toContain('Run video.faceSwap once per pair');
  });
});

describe('uploadFailure', () => {
  it('maps multipart oversize to 413 instead of 500', () => {
    const error = Object.assign(new Error('request file too large'), {
      code: 'FST_REQ_FILE_TOO_LARGE',
      statusCode: 413,
    });
    expect(uploadFailure(error)).toEqual({
      status: 413,
      message: 'Uploads are limited to 25 MB for images and 100 MB for video.',
    });
  });

  it('keeps UploadError status', () => {
    expect(uploadFailure(new UploadError('This workspace is read-only. Enable the write capability before uploading files into it.', 403))).toEqual({
      status: 403,
      message: 'This workspace is read-only. Enable the write capability before uploading files into it.',
    });
  });

  it('keeps unknown failures as 500', () => {
    expect(uploadFailure(new Error('disk full'))).toEqual({
      status: 500,
      message: 'The upload could not be stored.',
    });
  });
});

describe('lastGeneratedImageFromHistory', () => {
  const answer = (path: string) =>
    `TASK_COMPLETE: Generated image saved to ${path} (SHA-256: ${'a'.repeat(64)}).`;

  it('finds the newest image an assistant turn reported', () => {
    expect(lastGeneratedImageFromHistory([
      { role: 'user', content: 'a portrait of a woman' },
      { role: 'assistant', content: answer('generated/image-run_aaa.png') },
      { role: 'user', content: 'update the image so the background is darker' },
      { role: 'assistant', content: answer('generated/image-run_bbb.png') },
    ])).toBe('generated/image-run_bbb.png');
  });

  it('ignores video output and paths outside the generated directory', () => {
    expect(lastGeneratedImageFromHistory([
      { role: 'assistant', content: answer('generated/video-run_aaa.mp4') },
    ])).toBeUndefined();
    expect(lastGeneratedImageFromHistory([
      { role: 'assistant', content: 'I read apps/web/src/logo.png while reviewing the code.' },
    ])).toBeUndefined();
  });

  it('never takes a path a user turn supplied', () => {
    // Only what the run itself saved is evidence; prompt text is not.
    expect(lastGeneratedImageFromHistory([
      { role: 'user', content: 'edit generated/image-run_zzz.png for me' },
    ])).toBeUndefined();
  });

  it('returns undefined for an empty history', () => {
    expect(lastGeneratedImageFromHistory([])).toBeUndefined();
  });
});

describe('workspaceImageDescriptor', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dacai-generated-'));
    mkdirSync(join(root, 'generated'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('describes a generated image the way an upload is described', async () => {
    writeFileSync(join(root, 'generated', 'image-run_a.png'), pngHeader(1024, 768));
    const descriptor = await workspaceImageDescriptor(root, 'generated/image-run_a.png');
    expect(descriptor).toMatchObject({
      path: 'generated/image-run_a.png',
      name: 'image-run_a.png',
      mimeType: 'image/png',
      kind: 'binary',
    });
    // The descriptor has to survive the same selection the attachment path uses.
    expect(selectEditableImage([descriptor!])?.path).toBe('generated/image-run_a.png');
  });

  it('refuses a path that escapes the workspace', async () => {
    expect(await workspaceImageDescriptor(root, '../outside.png')).toBeUndefined();
  });

  it('refuses missing, empty and unusable files', async () => {
    writeFileSync(join(root, 'generated', 'empty.png'), Buffer.alloc(0));
    writeFileSync(join(root, 'generated', 'clip.mp4'), Buffer.from('not an image'));
    expect(await workspaceImageDescriptor(root, 'generated/missing.png')).toBeUndefined();
    expect(await workspaceImageDescriptor(root, 'generated/empty.png')).toBeUndefined();
    expect(await workspaceImageDescriptor(root, 'generated/clip.mp4')).toBeUndefined();
    expect(await workspaceImageDescriptor(root, 'generated')).toBeUndefined();
  });
});
