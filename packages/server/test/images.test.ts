import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { KEY_COLOURS, backdropSentence, cutout, cutoutProblems, finishCutout } from '../src/genai/cutout';
import { buildPrompt, canvasOf, type ImageRecord } from '../src/genai/images';
import { parseModelJson } from '../src/genai/json';
import { ComfyUIProvider } from '../src/genai/providers';

const W = 600, H = 800;
/** Krea's rendering of the magenta key (a hot pink, not #ff00ff): the cut must read the real backdrop. */
const MAGENTA = '#e04aa8';
const svg = (body: string, bg?: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : ''}${body}</svg>`);

/** A painting on `bg` with a cutter's mask as alpha (the mask drawn from `mask`, white on black). */
async function painted(bg: string, shapes: string, mask: string): Promise<Buffer> {
  const rgb = await sharp(svg(shapes, bg)).removeAlpha().raw().toBuffer();
  const m = await sharp(svg(mask, '#000')).removeAlpha().extractChannel(0).raw().toBuffer();
  return sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).joinChannel(m, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}
const alphaAt = (c: { data: Buffer; width: number }, x: number, y: number) => c.data[(y * c.width + x) * 4 + 3]!;

describe('cutting assets out of their chroma-key backdrop', () => {
  it('cuts a figure out, trims the cutter’s loose edge and un-mixes the backdrop from soft edges', async () => {
    const body = '<ellipse cx="300" cy="420" rx="110" ry="300" fill="#4a3020"/>';
    // The cutter's mask runs 4 px beyond the figure, as BiRefNet's often does.
    const c = await cutout(await painted(MAGENTA, body, '<ellipse cx="300" cy="420" rx="114" ry="304" fill="#fff"/>'));
    expect(c.judgeable).toBe(true);
    expect(cutoutProblems(c)).toEqual([]);
    expect(alphaAt(c, 300, 420)).toBe(255);
    // The backdrop the cutter kept is gone.
    expect(alphaAt(c, 300 + 113, 420)).toBe(0);
    // Soft edge pixels carry the figure's colour, not pink.
    let blue = 0, n = 0;
    for (let k = 0; k < W * H; k++) {
      const a = c.data[k * 4 + 3]!;
      if (a > 20 && a < 235) (blue += c.data[k * 4 + 2]!), n++;
    }
    expect(n).toBeGreaterThan(50);
    expect(blue / n).toBeLessThan(70);
  });

  it('cuts out the backdrop the cutter filled in (the middle of a ring)', async () => {
    const ring = '<circle cx="300" cy="400" r="150" fill="none" stroke="#c0c4c8" stroke-width="30"/>';
    const c = await cutout(await painted(KEY_COLOURS.green.hex, ring, '<circle cx="300" cy="400" r="168" fill="#fff"/>'));
    expect(cutoutProblems(c)).toEqual([]);
    expect(alphaAt(c, 300, 400)).toBe(0);
    expect(alphaAt(c, 450, 400)).toBe(255);
  });

  it('keeps every separate piece of a subject', async () => {
    const coins = [[150, 300], [300, 260], [450, 320], [220, 520], [400, 560]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="45" fill="#b08840"/>`).join('');
    const c = await cutout(await painted(KEY_COLOURS.blue.hex, coins, coins.replaceAll('#b08840', '#fff')));
    expect(cutoutProblems(c)).toEqual([]);
    for (const [x, y] of [[150, 300], [300, 260], [450, 320], [220, 520], [400, 560]]) expect(alphaAt(c, x!, y!)).toBe(255);
  });

  it('notices a thin part the cutter chopped off', async () => {
    const figure = '<ellipse cx="260" cy="420" rx="70" ry="260" fill="#3a3a5a"/>';
    const staff = '<rect x="420" y="60" width="14" height="700" fill="#503020"/>';
    const c = await cutout(await painted(KEY_COLOURS.green.hex, figure + staff, figure.replace('#3a3a5a', '#fff')));
    expect(c.missing).toBeGreaterThan(0.06);
    expect(cutoutProblems(c)).toContain('part of the subject was cut away');
  });

  it('will not judge a subject patterned in the key colour (it is painted again on another)', async () => {
    const cloak = `<defs><pattern id="p" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#302040"/><circle cx="6" cy="6" r="3" fill="${MAGENTA}"/></pattern></defs><ellipse cx="300" cy="420" rx="160" ry="300" fill="url(#p)"/>`;
    const c = await cutout(await painted(MAGENTA, cloak, '<ellipse cx="300" cy="420" rx="166" ry="306" fill="#fff"/>'));
    expect(c.judgeable).toBe(false);
    expect(cutoutProblems(c)).toEqual(['the backdrop colour clashes with the subject']);
  });

  it('needs the cutter mask', async () => {
    await expect(cutout(await sharp(svg('<circle cx="300" cy="400" r="100" fill="#333"/>', MAGENTA)).removeAlpha().png().toBuffer())).rejects.toThrow(/mask/);
  });

  it('trims to the subject and flags one cut off by the frame', async () => {
    const whole = await finishCutout(await cutout(await painted(KEY_COLOURS.green.hex, '<rect x="200" y="100" width="200" height="600" fill="#553322"/>', '<rect x="196" y="96" width="208" height="608" fill="#fff"/>')), 256);
    expect(whole.problems).toEqual([]);
    expect(whole.height).toBe(256);
    expect(whole.width).toBeLessThan(100);
    expect(whole.anchorY).toBeGreaterThan(0.95);
    const cut = await finishCutout(await cutout(await painted(KEY_COLOURS.green.hex, '<rect x="200" y="300" width="200" height="500" fill="#553322"/>', '<rect x="196" y="296" width="208" height="504" fill="#fff"/>')), 256);
    expect(cut.problems.some((p) => p.includes('cut off'))).toBe(true);
  });
});

describe('asset prompts', () => {
  const rec = (over: Partial<ImageRecord>): ImageRecord => ({ key: 'k', kind: 'sprite', prompt: 'a marsh hound', status: 'pending', ...over }) as ImageRecord;
  it('ends every prompt with its key-colour backdrop', () => {
    const p = buildPrompt(rec({ imagePrompt: 'A painterly hound.' }), 'painterly', 'blue');
    expect(p.startsWith('A painterly hound.')).toBe(true);
    expect(p.endsWith(backdropSentence('blue'))).toBe(true);
    expect(p).toContain('#0047bb');
  });
  it('paints people upright and animals side-on', () => {
    expect(canvasOf(rec({ view: 'front' }))).toEqual({ width: 832, height: 1216 });
    expect(canvasOf(rec({ view: 'side' }))).toEqual({ width: 1216, height: 832 });
    expect(canvasOf(rec({ kind: 'icon' }))).toEqual({ width: 1024, height: 1024 });
  });
});

describe('the asset workflow', () => {
  it('must cut out what it paints', () => {
    expect(() => new ComfyUIProvider({ type: 'comfyui', workflow: 'config/comfyui/krea2_cutout.json' })).not.toThrow();
    expect(() => new ComfyUIProvider({ type: 'comfyui', workflow: 'config/comfyui/krea2_turbo_t2i.json' })).toThrow(/cutter/);
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
