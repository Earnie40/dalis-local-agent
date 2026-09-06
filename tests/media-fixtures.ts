import { deflateSync } from 'node:zlib';

export function pngFixture(width = 1024, height = 1024, value = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1), value);
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export const VIDEO_FIXTURE = Buffer.from('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', 'base64');
export const mockVideoProbe = async () => ({ width: 1024, height: 576, durationSeconds: 30, frames: 480, fps: 16 });

export function intentFixture(instruction: string, options: { geometry?: boolean; generate?: boolean } = {}) {
  return {
    version: 1, kind: 'image', operation: options.generate ? 'generate' : 'edit', editScope: options.generate ? 'none' : 'localized',
    instruction, changes: [{ action: instruction, target: 'requested target', ...(options.generate ? {} : { region: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.4 } }) }],
    protectedAttributes: options.generate ? [] : ['face', 'pose', 'background'], requiresBodyGeometry: options.geometry ?? false, changesPose: false,
    constraints: { loop: false, subjects: [], explicit: [] },
  };
}
