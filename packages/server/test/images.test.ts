import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { cutoutSprite, makeSeamless } from '../src/genai/images';
import { parseModelJson } from '../src/genai/json';

async function synthSprite(w: number, h: number, opts: { cut?: boolean } = {}) {
  // Gray background with a dark "character" blob in the middle.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#c8c8c8"/>
    <ellipse cx="${w / 2}" cy="${opts.cut ? h * 0.95 : h * 0.55}" rx="${w * 0.18}" ry="${h * 0.32}" fill="#4a3020"/>
    <circle cx="${w / 2}" cy="${opts.cut ? h * 0.55 : h * 0.18}" r="${w * 0.1}" fill="#e0b090"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('image post-processing', () => {
  it('removes a flat background and trims to the subject', async () => {
    const out = await cutoutSprite(await synthSprite(512, 768), 256);
    expect(out.problems).toEqual([]);
    const meta = await sharp(out.png).metadata();
    expect(meta.height).toBeLessThanOrEqual(256);
    const { data, info } = await sharp(out.png).raw().toBuffer({ resolveWithObject: true });
    // Corners are transparent, center is opaque.
    expect(data[3]).toBe(0);
    const c = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    expect(data[c + 3]).toBeGreaterThan(200);
  });

  it('flags subjects cut off by the frame', async () => {
    const out = await cutoutSprite(await synthSprite(512, 512, { cut: true }), 256);
    expect(out.problems.some((p) => p.includes('cut off'))).toBe(true);
  });

  it('makes textures tile seamlessly', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#406020"/><rect x="0" y="0" width="100" height="300" fill="#a0c060"/></svg>`;
    const png = await makeSeamless(await sharp(Buffer.from(svg)).png().toBuffer(), 128);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data[(y * info.width + x) * info.channels]!;
    // Left and right edges now match (they wrap seamlessly).
    for (const y of [10, 64, 120]) expect(Math.abs(px(0, y) - px(info.width - 1, y))).toBeLessThan(12);
  });
});

describe('model JSON parsing', () => {
  it('handles fences, think tags, trailing commas and truncation', () => {
    expect(parseModelJson('```json\n{"a": 1,}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('<think>hmm {"x":2}</think>Here: {"a": [1, 2,], "b": "ok"}')).toEqual({ a: [1, 2], b: 'ok' });
    expect(parseModelJson('{"a": {"b": "unterminated')).toEqual({ a: { b: 'unterminated' } });
    expect(() => parseModelJson('no json here')).toThrow();
  });
});
