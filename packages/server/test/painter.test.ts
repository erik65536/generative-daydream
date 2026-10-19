import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { measureAlignment, realign, registerLocal } from '../src/worldgen/painter';

/** A test scene: boxes of different colours on a floor (something with clear edges to align). */
async function scene(W = 800, H = 480, shift = { x: 0, y: 0 }, scale = 1): Promise<Buffer> {
  const boxes = [[100, 80, 120, 90, '#d04040'], [380, 60, 90, 140, '#40a0d0'], [560, 260, 160, 80, '#e0c040'], [150, 300, 70, 70, '#60c060'], [420, 300, 60, 120, '#a060d0']] as const;
  const rects = boxes.map(([x, y, w, h, c]) => {
    const cx = W / 2, cy = H / 2;
    const X = (x - cx) * scale + cx + shift.x, Y = (y - cy) * scale + cy + shift.y;
    return `<rect x="${X}" y="${Y}" width="${w * scale}" height="${h * scale}" fill="${c}"/>`;
  });
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#777"/>${rects.join('')}</svg>`)).png().toBuffer();
}

describe('painting alignment', () => {
  it('measures a painting that is scaled and shifted against its block-out', async () => {
    const block = await scene();
    const painted = await scene(800, 480, { x: 12, y: -16 }, 1.03);
    const a = await measureAlignment(block, painted);
    expect(a.scale).toBeGreaterThan(1.01);
    expect(a.scale).toBeLessThan(1.05);
    expect(Math.abs(a.dx - 12)).toBeLessThanOrEqual(8);
    expect(Math.abs(a.dy + 16)).toBeLessThanOrEqual(8);
  });

  it('puts a drifted painting back on its block-out', async () => {
    const block = await scene();
    const painted = await scene(800, 480, { x: 12, y: -16 }, 1.03);
    const fixed = await registerLocal(block, await realign(painted, await measureAlignment(block, painted)));
    const after = await measureAlignment(block, fixed);
    expect(Math.abs(after.scale - 1)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(after.dx)).toBeLessThanOrEqual(4);
    expect(Math.abs(after.dy)).toBeLessThanOrEqual(4);
  });

  it('leaves an aligned painting alone', async () => {
    const block = await scene();
    const a = await measureAlignment(block, block);
    expect(a).toMatchObject({ scale: 1, dx: 0, dy: 0 });
  });
});
