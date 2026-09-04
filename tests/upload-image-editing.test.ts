import { describe, expect, it } from 'vitest';
import {
  classifyDirectMediaRequest,
  isImageEditRequest,
  isImageGenerationRequest,
} from '../apps/server/src/routes/agent';
import {
  fitGenerationSize,
  readImageDimensions,
  renderUploadsForPrompt,
  selectEditableImage,
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
});
