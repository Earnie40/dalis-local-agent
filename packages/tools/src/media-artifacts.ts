import { execFile } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate chunk integrity and every decompressed scanline, including Adam7 passes. */
export function inspectPng(image: Buffer): { width: number; height: number } {
  const invalid = () => new Error('The image backend did not return a valid PNG file.');
  if (!image.subarray(0, 8).equals(PNG_SIGNATURE)) throw invalid();
  let offset = 8;
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  let ended = false, palette = false, dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= image.length) {
    const size = image.readUInt32BE(offset);
    if (size > image.length - offset - 12) throw invalid();
    const type = image.toString('ascii', offset + 4, offset + 8);
    const chunk = image.subarray(offset + 8, offset + 8 + size);
    if (crc32(image.subarray(offset + 4, offset + 8 + size)) !== image.readUInt32BE(offset + 8 + size)) throw invalid();
    if (!width && type !== 'IHDR') throw invalid();
    if (type === 'IHDR') {
      if (width || size !== 13) throw invalid();
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      depth = chunk[8]; color = chunk[9]; interlace = chunk[12];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width * height > 40_000_000 || !depths[color]?.includes(depth) || chunk[10] || chunk[11] || interlace > 1) throw invalid();
    } else if (type === 'PLTE') {
      if (palette || compressed.length || !size || size % 3 || size > 768 || [0, 4].includes(color)) throw invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) throw invalid();
      compressed.push(chunk);
    } else if (type === 'IEND') {
      if (size || !compressed.length) throw invalid();
      ended = true; offset += 12; break;
    } else {
      if (!/^[A-Za-z]{4}$/.test(type) || type[0] === type[0].toUpperCase()) throw invalid();
      if (compressed.length) dataEnded = true;
    }
    offset += 12 + size;
  }
  if (!ended || offset !== image.length) throw invalid();
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    return { count: columns ? Math.max(0, Math.ceil((height - y) / dy)) : 0, bytes: Math.ceil(columns * channels * depth / 8) + 1 };
  });
  const expected = rows.reduce((total, row) => total + row.count * row.bytes, 0);
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }); } catch { throw invalid(); }
  if (raw.length !== expected) throw invalid();
  let cursor = 0;
  for (const row of rows) for (let index = 0; index < row.count; index++, cursor += row.bytes) if (raw[cursor] > 4) throw invalid();
  return { width, height };
}

export interface VideoMetadata { width: number; height: number; durationSeconds: number; frames: number; fps: number }
export type VideoProbe = (path: string, signal?: AbortSignal) => Promise<VideoMetadata>;

/** Counting decoded frames rejects containers that merely have an MP4 signature. */
export const probeVideo: VideoProbe = async (path, signal) => {
  const output = await new Promise<string>((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,duration,nb_read_frames,avg_frame_rate:format=duration', '-of', 'json', path],
      { signal, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => error || stderr.trim()
        ? reject(new Error(`Video validation failed; a working ffprobe and decodable video are required: ${error?.message ?? stderr.trim()}`))
        : resolve(stdout));
  });
  const body = JSON.parse(output) as { streams?: Array<Record<string, unknown>>; format?: { duration?: unknown } };
  const stream = body.streams?.[0];
  const [numerator, denominator] = String(stream?.avg_frame_rate).split('/').map(Number);
  const metadata = { width: Number(stream?.width), height: Number(stream?.height), durationSeconds: Number(stream?.duration ?? body.format?.duration), frames: Number(stream?.nb_read_frames), fps: numerator / denominator };
  if (Object.values(metadata).some((value) => !Number.isFinite(value) || value <= 0) || !Number.isInteger(metadata.frames)) throw new Error('The media service did not return a decodable video with valid dimensions, frame count, and duration.');
  return metadata;
};

export function validateVideoConstraints(actual: VideoMetadata, expected: { width?: number; height?: number; durationSeconds?: number }): void {
  if ((expected.width !== undefined && actual.width !== expected.width) || (expected.height !== undefined && actual.height !== expected.height)) throw new Error(`Video dimensions ${actual.width}x${actual.height} do not match the requested dimensions ${expected.width}x${expected.height}.`);
  if (expected.durationSeconds !== undefined && Math.abs(actual.durationSeconds - expected.durationSeconds) > Math.max(0.1, 1 / actual.fps)) throw new Error(`Video duration ${actual.durationSeconds}s does not match requested duration ${expected.durationSeconds}s.`);
}
