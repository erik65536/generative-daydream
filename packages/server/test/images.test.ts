import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { cutoutSprite, framedness, liftDark, makeSeamless } from '../src/genai/images';
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

  it('clears faint haze around a natively transparent subject', async () => {
    // Transparent canvas: a soft half-transparent fog disc with an opaque figure in it.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><ellipse cx="200" cy="420" rx="180" ry="150" fill="#6a8a8a" fill-opacity="0.2"/>
      <rect x="160" y="120" width="80" height="380" fill="#8a4a2a"/><circle cx="200" cy="100" r="36" fill="#e0b090"/></svg>`;
    const out = await cutoutSprite(await sharp(Buffer.from(svg)).png().toBuffer(), 600);
    const { info } = await sharp(out.png).raw().toBuffer({ resolveWithObject: true });
    // Trimmed to the figure (about 80px wide plus its head), not the 360px fog.
    expect(info.width).toBeLessThan(120);
  });

  it('notes opaque fog pooled around a figure but not smoothly shaded solid items', async () => {
    const fog = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><ellipse cx="200" cy="520" rx="170" ry="60" fill="#5a7a7a"/>
      <rect x="160" y="120" width="80" height="400" fill="#2a2a4a" stroke="#000" stroke-width="6"/><circle cx="200" cy="100" r="36" fill="#e0b090"/></svg>`;
    const foggy = await cutoutSprite(await sharp(Buffer.from(fog)).png().toBuffer(), 600);
    expect(foggy.notes?.some((n) => n.includes('fog'))).toBe(true);
    // A large, smoothly shaded capsule (a flat-vector icon at full resolution) is solid, not fog.
    const pill = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a0c8e8"/><stop offset="1" stop-color="#3050a0"/></linearGradient></defs>
      <rect x="60" y="200" width="520" height="240" rx="120" fill="url(#g)" transform="rotate(25 320 320)"/></svg>`;
    const icon = await cutoutSprite(await sharp(Buffer.from(pill)).png().toBuffer(), 128);
    expect(icon.notes?.some((n) => n.includes('fog')) ?? false).toBe(false);
  });

  it('flags an opaque backdrop panel left behind by a transparent model', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect x="40" y="40" width="320" height="520" rx="30" fill="#203030"/>
      <rect x="160" y="120" width="80" height="380" fill="#8a4a2a"/></svg>`;
    const out = await cutoutSprite(await sharp(Buffer.from(svg)).png().toBuffer(), 600);
    expect(out.problems.some((p) => p.includes('panel'))).toBe(true);
  });

  it('tells a continuous surface from a framed shape', async () => {
    const flat = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#405a70"/><circle cx="60" cy="80" r="20" fill="#4a6478"/><circle cx="190" cy="170" r="26" fill="#3a5266"/></svg>`;
    const pit = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#a0a0a0"/><ellipse cx="128" cy="128" rx="90" ry="80" fill="#080808"/></svg>`;
    expect(await framedness(await sharp(Buffer.from(flat)).png().toBuffer())).toBeLessThan(25);
    expect(await framedness(await sharp(Buffer.from(pit)).png().toBuffer())).toBeGreaterThan(25);
  });

  it('lifts near-black surfaces to a readable brightness and leaves others alone', async () => {
    const mean = async (png: Buffer) => (await sharp(png).stats()).channels.slice(0, 3).reduce((t, c) => t + c.mean, 0) / 3;
    const dark = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#060808"/><rect x="10" y="10" width="20" height="6" fill="#102828"/></svg>`)).png().toBuffer();
    expect(await mean(await liftDark(dark))).toBeGreaterThan(35);
    const mid = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#606a70"/></svg>`)).png().toBuffer();
    expect(await liftDark(mid)).toBe(mid);
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
