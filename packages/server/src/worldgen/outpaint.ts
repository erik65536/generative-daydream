/**
 * Large painted zones by outpainting: Luna plans the place as a grid of overlapping chunks (one shared style, what
 * each part holds, what closes the place in), Qwen paints the first chunk over the isometric grid, and every later
 * chunk keeps what is already painted and fills the rest, starting from the grid so the angle stays locked. Only
 * the sides on the zone's outer border are closed in; inner sides stay open for the next chunk.
 */
import sharp from 'sharp';
import { z } from 'zod';
import type { WorldDefinition, ZoneDef } from '@gd/shared';
import { genai } from '../genai/service';
import { edit, freeGpu, inpaint, kreaAnyPaint, kreaInpaint, kreaTextToImage, outpaintEdit, textToImage } from './comfy';
import { isoGrid, needsOf, PH as PH0, PW as PW0 } from './zonepaint';
/** Window size (ZP_W × ZP_H, multiples of 32; default one full painting). */
const PW = Number(process.env.ZP_W ?? PW0);
const PH = Number(process.env.ZP_H ?? PH0);

const ChunkPlanSchema = z.object({
  layout: z.string().min(80).max(1200).describe('The whole place as one design: its major structures, rooms or areas, and how the routes run through it as a whole'),
  style: z.string().min(80).max(900).describe('Shared by every part: art style, light (direction, colour), palette, materials of the ground'),
  border: z.string().min(10).max(300).describe('What closes the place in along its outer edges (dense forest, cliffs, a wall)'),
  parts: z.array(z.object({ col: z.number().int(), row: z.number().int(), content: z.string().min(40).max(700) })),
});
export type ChunkPlan = z.infer<typeof ChunkPlanSchema> & { cols: number; rows: number; indoor?: boolean };

export async function planChunks(w: WorldDefinition, zone: ZoneDef, cols: number, rows: number): Promise<ChunkPlan> {
  const n = needsOf(w, zone);
  const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `(col ${c}, row ${r})`).join(' ')).join('\n');
  const out = await genai().structured('world.design', {
    system: 'You are the level designer and art director of a 2D isometric RPG. Each place is painted by an image model as one large illustration, part by part, seen from above.',
    prompt: `WORLD: ${w.concept.title}. ${w.concept.pitch}
Art style: ${w.concept.artStyle}
PLACE: ${zone.name} (${zone.kind}${zone.indoor ? ', indoors' : ''}): ${zone.description}
${zone.lore ? `History: ${zone.lore}\n` : ''}${n.buildings.length ? `Buildings that can be entered (each needs a clearly visible door on a wall facing the viewer): ${n.buildings.map((b) => `${b.name} (${b.purpose})`).join('; ')}.\n` : ''}${n.exits.length ? `Ways out: ${n.exits.map((e) => `to ${e.to}`).join('; ')}.\n` : ''}
The picture is painted as a grid of ${cols}×${rows} overlapping parts (col 0 is the left of the picture, row 0 the top):
${cells}
Plan the place as one real, believable location first, then cut it into the parts:
- layout: one paragraph describing the whole place as a single design: its major structures, rooms or areas, where they sit in the picture, and how the routes run through it as a whole. Routes follow the logic of the place (a main street with side lanes, a trail winding between clearings, corridors between rooms), never the same grid repeated in every part. ${zone.indoor ? 'This place is indoors: divide it into rooms and areas with walls and doorways, shown as a cutaway with no ceiling. ' : ''}
- style: one paragraph every part shares (art style, light direction and colour, palette, ground materials).
- border: what closes the place in along the picture's outer edges.
- parts: for each part, 2-4 sentences describing exactly the slice of the layout that falls inside it, in plain spatial words, naming what carries on into the neighbouring parts (a corridor continuing to the right, a wall running down into the part below). A part can be mostly open ground, mostly building or mostly wall if that is where the layout puts it. Keep the scale close: a door is about a twentieth of a part's height; give counts ("two houses", "a cluster of four cubicles").
Everything must be ordinary, physically plausible things that read clearly from above: no surreal or magical effects on the ground, no drifts of loose debris, nothing floating. Ways out and connections are doors, archways, stairs or lifts set into walls or the edge of the place, never free-standing.
The painter is an image model that reads every word literally and paints each word's most common picture. Describe things by what they look like (material, shape, colour, size), never by names that commonly picture something else: write "a packed dirt road", not "a cart track" (it paints a railway); "stone steps", not "a stair passage". Leave out fine marks drawn as long parallel lines (wheel ruts, grooves, tracks in the ground): they turn into rails too. Never mention anything that should not appear, not even to exclude it.
The game draws its own people, creatures, chests, loot, shrines and signs, so never put them in. No text.`,
    schema: ChunkPlanSchema,
    name: 'chunk_plan',
    maxTokens: 3000,
  });
  return { ...out, cols, rows, indoor: !!zone.indoor };
}

const CAMERA =
  'An isometric video game level, orthographic 2:1 isometric projection with parallel lines and no perspective, seen from above like a classic isometric RPG, no sky and no horizon. Every wall, building and object follows the isometric grid. No people, no creatures, no text.' +
  // ZP_FILL=1: a close view inside the level, never a model or diorama floating on a background.
  (process.env.ZP_FILL === '1' ? ' A close view from inside the level: it fills the whole frame edge to edge and continues past every edge of the picture, with no background, border or empty space around it.' : '');

export type EdgeMode = 'closed' | 'open' | 'none';

const EVEN = 'Evenly lit from edge to edge, with consistent brightness across the whole picture.';

export function chunkPrompt(plan: ChunkPlan, col: number, row: number, first: boolean, mode: EdgeMode = 'closed'): string {
  const part = plan.parts.find((p) => p.col === col && p.row === row)?.content ?? '';
  const sides: string[] = [];
  if (mode === 'closed') {
  if (col === 0) sides.push('left');
  if (col === plan.cols - 1) sides.push('right');
  if (row === 0) sides.push('top');
  if (row === plan.rows - 1) sides.push('bottom');
  }
  const open = ['left', 'right', 'top', 'bottom'].filter((s) => !sides.includes(s));
  const edges = `${sides.length ? `Along the picture's ${sides.join(' and ')} edge${sides.length > 1 ? 's' : ''} the place is closed in: ${plan.border}. ` : ''}${open.length ? `The ${open.join(', ')} side${open.length > 1 ? 's' : ''} stay${open.length > 1 ? '' : 's'} open: the ground and the scene carry on past the picture's edge there, with nothing closing them off.` : ''}`;
  const lead = first
    ? 'Paint the level so it sits exactly on the isometric floor grid in image 1; the grid is only a guide and must not be visible.'
    : 'Part of this level is already painted. Continue it seamlessly into the rest of the picture with the same style, light, scale and materials, joining every path, wall and surface across the boundary.';
  return `${lead} ${CAMERA} ${EVEN}\n\n${plan.style}\n\nThis part: ${part}${mode === 'none' ? '' : `\n\n${edges}`}`;
}

export interface OutpaintResult {
  canvas: Buffer;
  width: number;
  height: number;
}

/** Paint the zone chunk by chunk (row by row, left to right) onto one canvas. */
export async function outpaintZone(plan: ChunkPlan, seed: number, opts: { report?: (m: string) => void; onChunk?: (canvas: Buffer, i: number) => void; edges?: EdgeMode } = {}): Promise<OutpaintResult> {
  const say = opts.report ?? (() => {});
  // Tuning (experiments): BAND = painted pixels next to the unknown area that are repainted, where the new paint
  // wins except for a RAMP at the band's far end; MARGIN = pixels painted past the kept area on sides that lead to
  // more chunks, then discarded (they carry the picture's darkened edge); FLAT = flatten each chunk's vignette.
  const BAND = Number(process.env.ZP_BAND ?? 96);
  const RAMP = Math.min(BAND, Number(process.env.ZP_RAMP ?? 64));
  const MX = Number(process.env.ZP_MARGIN ?? 0), MY = Math.round((MX * PH) / PW);
  const FLAT = process.env.ZP_FLAT !== '0';
  // Window positions: each window overlaps the kept part of the previous one by half a window.
  const place = (n: number, win: number, margin: number) => {
    const keep = win - margin; // kept width of a window that has more windows after it
    const xs: number[] = [0];
    for (let k = 1; k < n; k++) xs.push(xs[k - 1]! + keep - win / 2);
    return { xs, size: xs[n - 1]! + win };
  };
  const px0 = place(plan.cols, PW, MX), py0 = place(plan.rows, PH, MY);
  const W = px0.size, H = py0.size;
  // The canvas starts as the isometric grid everywhere; `done` tracks painted pixels (1 byte per pixel).
  let canvas = await sharp(await isoGrid(W, H, 64)).removeAlpha().raw().toBuffer();
  const done = new Uint8Array(W * H);
  // ZP_CUT: hard-cut compositing (px into the old paint); `seams` records the cut lines (ZP_SEAMS saves them).
  const CUT = Number(process.env.ZP_CUT ?? (process.env.ZP_METHOD === 'anypaint' ? 48 : 0));
  const seams = new Uint8Array(W * H);
  // Chunk order: row by row, or centre-out (ZP_ORDER=centre: the middle first, then alternately outwards), so drift
  // spreads both ways instead of piling up in one corner.
  const outward = (n: number) => {
    if (process.env.ZP_ORDER !== 'centre') return Array.from({ length: n }, (_, k) => k);
    const mid = Math.floor((n - 1) / 2);
    const out = [mid];
    for (let d = 1; out.length < n; d++) {
      if (mid - d >= 0) out.push(mid - d);
      if (mid + d < n) out.push(mid + d);
    }
    return out;
  };
  const order = outward(plan.rows).flatMap((row) => outward(plan.cols).map((col) => [col, row] as const));
  const painted = new Set<string>();
  const pending = (c: number, r: number) => c >= 0 && r >= 0 && c < plan.cols && r < plan.rows && !painted.has(`${c},${r}`);
  let i = 0;
  for (const [col, row] of order) {
    {
      const x0 = px0.xs[col]!, y0 = py0.xs[row]!;
      // What this window keeps: all of it, except the margin on sides that face chunks not painted yet.
      const kx0 = pending(col - 1, row) ? MX : 0, kx1 = pending(col + 1, row) ? PW - MX : PW;
      const ky0 = pending(col, row - 1) ? MY : 0, ky1 = pending(col, row + 1) ? PH - MY : PH;
      painted.add(`${col},${row}`);
      const prompt = chunkPrompt(plan, col, row, i === 0, opts.edges);
      let out: Buffer;
      // The mask: unknown pixels plus a band of painted ones next to them.
      const known = new Uint8Array(PW * PH);
      for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) known[y * PW + x] = done[(y0 + y) * W + x0 + x]!;
      const distK = distanceFrom(known, PW, PH);
      const mask = new Uint8Array(PW * PH);
      // SOFT (base model only: turbo cannot repaint partially): repaint strength fades from full at the unknown
      // area to none over SOFT pixels of the old paint, so the model eases its work into the old pixels.
      const SOFT = Number(process.env.ZP_SOFT ?? 0);
      for (let k = 0; k < mask.length; k++) mask[k] = !known[k] ? 255 : SOFT > 0 ? Math.max(0, Math.round(255 * (1 - distK[k]! / SOFT))) : distK[k]! <= BAND ? 255 : 0;
      const t0 = Date.now();
      // Free VRAM only before the first chunk (another model may be loaded); every chunk uses the same Qwen model.
      // Also when the workflow switches after the first chunk (t2i/edit → outpaint, possibly with a LoRA): two
      // differently patched copies of the model do not fit in 16 GB.
      if (i <= 1) await freeGpu();
      if (i === 0) {
        out = await paintZoneImageRaw(prompt, seed);
      } else {
        const win = await sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).extract({ left: x0, top: y0, width: PW, height: PH }).png().toBuffer();
        const maskPng = await sharp(Buffer.from(mask), { raw: { width: PW, height: PH, channels: 1 } }).png().toBuffer();
        // A reference image showing only the painted part gets copied into the open area (an edit model places its
        // reference), so the model sees either nothing extra or the whole window, encoded small.
        const mode = process.env.ZP_REF ?? 'none';
        if (process.env.ZP_ENGINE === 'krea') {
          // Krea 2 Turbo has no local edit mode: plain mask inpainting over the window.
          const scene = prompt.replace(/^Part of this level is already painted\.[^.]*\.\s*/, '');
          if (process.env.ZP_METHOD === 'anypaint') {
            // AnyPaint: the mask is only the unknown area; the node redraws its own boundary band.
            const unk = Buffer.alloc(PW * PH);
            for (let k = 0; k < unk.length; k++) unk[k] = known[k] ? 0 : 255;
            const unkPng = await sharp(unk, { raw: { width: PW, height: PH, channels: 1 } }).png().toBuffer();
            out = await kreaAnyPaint(win, unkPng, scene, seed + i, Number(process.env.ZP_REDRAW ?? 32));
          } else out = await kreaInpaint(win, maskPng, `Part of this level is already painted. Continue it seamlessly into the rest of the picture. ${scene}`, seed + i);
        } else if (process.env.ZP_METHOD === 'edit') {
          // Edit-mode outpainting: unknown pixels flat grey, the window is the reference at its own size, and the
          // model repaints the whole window from noise (ZP_LORA: an outpaint LoRA trained for exactly this).
          const raw = await sharp(win).removeAlpha().raw().toBuffer();
          for (let k = 0; k < known.length; k++) if (!known[k]) raw.fill(0x80, k * 3, k * 3 + 3);
          const grey = await sharp(raw, { raw: { width: PW, height: PH, channels: 3 } }).png().toBuffer();
          const scene = prompt.replace(/^Part of this level is already painted\.[^.]*\.\s*/, '');
          const editPrompt = `Outpaint the image: replace the solid gray areas with a seamless continuation of the scene, keeping the existing picture unchanged.\n\nScene: ${scene}`;
          if (process.env.ZP_RAW) await sharp(grey).toFile(`${process.env.ZP_RAW}_in${i}.png`);
          out = await outpaintEdit(grey, editPrompt, PW, PH, seed + i, process.env.ZP_LORA || undefined);
        } else out = mode === 'window' ? await inpaint(win, maskPng, prompt, PW, PH, seed + i, win, 1024) : await inpaint(win, maskPng, prompt, PW, PH, seed + i, null);
      }
      say(`chunk ${col},${row} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      // Paste the masked area back, feathered across the band so the join is soft.
      let px: Buffer = await sharp(out).resize(PW, PH).removeAlpha().raw().toBuffer();
      if (process.env.ZP_FLAT === 'anchor') {
        // Anchored: the first chunk is flattened fully; a later chunk only away from the old paint (none at the
        // boundary, where the model already matched it, full 400 px out), so tone evens out without a step.
        if (i === 0) px = await flattenVignette(px, PW, PH);
        else {
          const unknown = new Uint8Array(PW * PH);
          for (let k = 0; k < unknown.length; k++) unknown[k] = known[k] ? 0 : 1;
          const away = distanceFrom(unknown, PW, PH);
          px = await flattenVignette(px, PW, PH, 1, (x, y) => Math.min(1, away[y * PW + x]! / 400));
        }
      } else if (FLAT) px = await flattenVignette(px, PW, PH);
      if (i > 0 && process.env.ZP_MATCH !== '0') matchColours(px, canvas, known, mask, (k) => ((y0 + ((k / PW) | 0)) * W + x0 + (k % PW)) * 3);
      if (process.env.ZP_RAW) {
        await sharp(out).toFile(`${process.env.ZP_RAW}_raw${i}.png`);
        await sharp(Buffer.from(mask), { raw: { width: PW, height: PH, channels: 1 } }).png().toFile(`${process.env.ZP_RAW}_mask${i}.png`);
      }
      // Two-band blend (as panorama stitchers do): in the band the new paint wins. Its broad tone (a heavy blur)
      // fades in over the whole band, so brightness shifts gradually; its detail fades in over a short ramp at the
      // band's far end, so two different paintings never ghost over each other.
      const old = await sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).extract({ left: x0, top: y0, width: PW, height: PH }).raw().toBuffer();
      const LOW = 24;
      const oldLow = await sharp(old, { raw: { width: PW, height: PH, channels: 3 } }).blur(LOW).raw().toBuffer();
      const newLow = await sharp(px, { raw: { width: PW, height: PH, channels: 3 } }).blur(LOW).raw().toBuffer();
      // ZP_PATHCUT=1: the margins are cut along the cheapest path through low-detail pixels instead of a straight line.
      const keep = process.env.ZP_PATHCUT === '1' ? await pathKeep(px, PW, PH, { left: kx0 > 0, right: kx1 < PW, top: ky0 > 0, bottom: ky1 < PH }, MX, MY) : null;
      for (let y = keep ? 0 : ky0; y < (keep ? PH : ky1); y++)
        for (let x = keep ? 0 : kx0; x < (keep ? PW : kx1); x++) {
          const k = y * PW + x;
          if (keep && !keep[k]) continue;
          const fresh = i === 0 || !known[k];
          if (CUT > 0) {
            // Hard cut CUT px into the old paint: inside the model's restored zone (past its own boundary redraw),
            // where its output already matches the old pixels, so nothing is cross-faded.
            if (!fresh && distK[k]! > CUT) continue;
            const c = ((y0 + y) * W + x0 + x) * 3;
            for (let ch = 0; ch < 3; ch++) canvas[c + ch] = px[k * 3 + ch]!;
            done[(y0 + y) * W + x0 + x] = 1;
            if (!fresh && distK[k]! > CUT - 1.5) seams[(y0 + y) * W + x0 + x] = 255;
            continue;
          }
          if (SOFT > 0) {
            // The model's output already eases into the old paint; take it in proportion to the mask.
            const a = fresh ? 1 : mask[k]! / 255;
            if (a <= 0) continue;
            const c = ((y0 + y) * W + x0 + x) * 3;
            for (let ch = 0; ch < 3; ch++) canvas[c + ch] = Math.round(old[k * 3 + ch]! * (1 - a) + px[k * 3 + ch]! * a);
            done[(y0 + y) * W + x0 + x] = 1;
            continue;
          }
          const aHigh = fresh ? 1 : Math.max(0, Math.min(1, (BAND - distK[k]!) / RAMP));
          const aLow = fresh ? 1 : Math.max(0, Math.min(1, (BAND - distK[k]!) / BAND));
          if (aHigh <= 0 && aLow <= 0) continue;
          const c = ((y0 + y) * W + x0 + x) * 3;
          for (let ch = 0; ch < 3; ch++) {
            const j = k * 3 + ch;
            const low = oldLow[j]! * (1 - aLow) + newLow[j]! * aLow;
            const high = (old[j]! - oldLow[j]!) * (1 - aHigh) + (px[j]! - newLow[j]!) * aHigh;
            canvas[c + ch] = Math.max(0, Math.min(255, Math.round(low + high)));
          }
          done[(y0 + y) * W + x0 + x] = 1;
          if (!fresh && distK[k]! > BAND - 1.5) seams[(y0 + y) * W + x0 + x] = 255;
        }
      opts.onChunk?.(await sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), i);
      i++;
    }
  }
  if (process.env.ZP_SEAMS) await sharp(Buffer.from(seams), { raw: { width: W, height: H, channels: 1 } }).png().toFile(process.env.ZP_SEAMS);
  return { canvas: await sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), width: W, height: H };
}

/**
 * Seam pass: repaint a strip of ±HALF px along every seam with AnyPaint, the surrounding window as context. Seam
 * pixels are shared out to the nearest window centre, so each strip sits well inside its window.
 */
export async function repaintSeams(png: Buffer, seamPng: Buffer, prompt: string, seed: number, opts: { half?: number; report?: (m: string) => void } = {}): Promise<Buffer> {
  const HALF = opts.half ?? 32;
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const canvas = Buffer.from(data);
  const line = await sharp(seamPng).extractChannel(0).raw().toBuffer();
  // The strip: within HALF of a seam line.
  const notLine = new Uint8Array(W * H);
  for (let k = 0; k < notLine.length; k++) notLine[k] = line[k]! > 127 ? 0 : 1;
  const d = distanceFrom(notLine, W, H);
  const strip = new Uint8Array(W * H);
  for (let k = 0; k < strip.length; k++) strip[k] = d[k]! <= HALF ? 1 : 0;
  const ww = Math.min(PW, W), wh = Math.min(PH, H);
  const starts = (size: number, win: number) => {
    const out: number[] = [];
    for (let p = 0; p + win < size; p += win / 2) out.push(p);
    out.push(size - win);
    return [...new Set(out)];
  };
  const wins = starts(H, wh).flatMap((y) => starts(W, ww).map((x) => ({ x, y })));
  const owner = new Int32Array(W * H).fill(-1);
  for (let k = 0; k < strip.length; k++) {
    if (!strip[k]) continue;
    const x = k % W, y = (k / W) | 0;
    let best = -1, bd = Infinity;
    wins.forEach((w, j) => {
      const dd = (x - (w.x + ww / 2)) ** 2 + (y - (w.y + wh / 2)) ** 2;
      if (dd < bd) (bd = dd), (best = j);
    });
    owner[k] = best;
  }
  for (let j = 0; j < wins.length; j++) {
    const w = wins[j]!;
    const m = Buffer.alloc(ww * wh);
    let n = 0;
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) if (owner[(w.y + y) * W + w.x + x] === j) (m[y * ww + x] = 255), n++;
    if (!n) continue;
    const t0 = Date.now();
    const win = await sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).extract({ left: w.x, top: w.y, width: ww, height: wh }).png().toBuffer();
    const maskPng = await sharp(m, { raw: { width: ww, height: wh, channels: 1 } }).png().toBuffer();
    const out = await sharp(await kreaAnyPaint(win, maskPng, prompt, seed + j, 8)).resize(ww, wh).removeAlpha().raw().toBuffer();
    for (let y = 0; y < wh; y++)
      for (let x = 0; x < ww; x++) {
        if (!m[y * ww + x]) continue;
        const c = ((w.y + y) * W + w.x + x) * 3;
        for (let ch = 0; ch < 3; ch++) canvas[c + ch] = out[(y * ww + x) * 3 + ch]!;
      }
    opts.report?.(`seam window ${j + 1}/${wins.length}: ${n} px in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  return sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** The first chunk: the full prompt is already built, so paint it over the grid directly. */
async function paintZoneImageRaw(prompt: string, seed: number): Promise<Buffer> {
  // ZP_FIRST=t2i: plain text-to-image with no grid reference (the grid can be copied in as an empty floor).
  if (process.env.ZP_ENGINE === 'krea') return kreaTextToImage(prompt.replace(/^Paint the level so it sits exactly on the isometric floor grid in image 1;[^.]*\.\s*/, ''), PW, PH, seed);
  if (process.env.ZP_FIRST === 't2i') return textToImage(prompt.replace(/^Paint the level so it sits exactly on the isometric floor grid in image 1;[^.]*\.\s*/, ''), PW, PH, seed);
  const grid = await isoGrid(PW / 2, PH / 2, 32);
  return edit([grid], prompt, PW, PH, seed);
}

/**
 * The model's exposure and colour drift from chunk to chunk: map the new pixels' per-channel mean and spread onto
 * the painted ones, measured where both exist (the band of painted pixels that was repainted).
 */
function matchColours(px: Buffer, canvas: Buffer, known: Uint8Array, mask: Uint8Array, at: (k: number) => number) {
  const n = [0, 0, 0], so = [0, 0, 0], sso = [0, 0, 0], sc = [0, 0, 0], ssc = [0, 0, 0];
  for (let k = 0; k < known.length; k++) {
    if (!known[k] || !mask[k]) continue;
    const c = at(k);
    for (let ch = 0; ch < 3; ch++) {
      const o = px[k * 3 + ch]!, v = canvas[c + ch]!;
      n[ch]!++;
      so[ch]! += o;
      sso[ch]! += o * o;
      sc[ch]! += v;
      ssc[ch]! += v * v;
    }
  }
  if (n[0]! < 500) return;
  for (let ch = 0; ch < 3; ch++) {
    const mo = so[ch]! / n[ch]!, mc = sc[ch]! / n[ch]!;
    const dO = Math.sqrt(Math.max(1, sso[ch]! / n[ch]! - mo * mo)), dC = Math.sqrt(Math.max(1, ssc[ch]! / n[ch]! - mc * mc));
    const g = Math.min(1.6, Math.max(0.6, dC / dO));
    for (let k = 0; k < known.length; k++) px[k * 3 + ch] = Math.max(0, Math.min(255, Math.round((px[k * 3 + ch]! - mo) * g + mc)));
  }
}

/** Distance (chamfer, in pixels) from each pixel with known=1 to the nearest known=0 pixel; 0 where known=0. */
function distanceFrom(known: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = known[i] ? 1e9 : 0;
  const R2 = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w]! + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1]! + R2);
        if (x < w - 1) v = Math.min(v, d[i - w + 1]! + R2);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      if (x < w - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w]! + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1]! + R2);
        if (x > 0) v = Math.min(v, d[i + w - 1]! + R2);
      }
      d[i] = v;
    }
  return d;
}

/**
 * Qwen lights the middle of every picture and darkens its edges (measured over 28 paintings: the centre about
 * 1.8× the mean, the outer ring about 0.85×). Fit a smooth radial falloff g(r) = a + b·r² + c·r⁴ to the picture's
 * own low-pass brightness and divide it out, so neighbouring chunks meet at the same brightness. `strength` 0..1.
 */
export async function flattenVignette(rgb: Buffer, w: number, h: number, strength = 1, weight?: (x: number, y: number) => number): Promise<Buffer> {
  const SW = 96, SH = Math.max(8, Math.round((96 * h) / w));
  const small = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(SW, SH).greyscale().blur(3).raw().toBuffer();
  const rr = (x: number, y: number) => ((x / (w - 1) - 0.5) * 2) ** 2 / 2 + ((y / (h - 1) - 0.5) * 2) ** 2 / 2; // r², 0..1
  // Least squares for [1, r², r⁴] against the brightness.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      const r2 = rr((x * (w - 1)) / (SW - 1), (y * (h - 1)) / (SH - 1));
      const b = [1, r2, r2 * r2];
      const v = small[y * SW + x]!;
      for (let i = 0; i < 3; i++) {
        B[i]! += b[i]! * v;
        for (let j = 0; j < 3; j++) A[i]![j]! += b[i]! * b[j]!;
      }
    }
  const [a, b1, c] = solve(A, B);
  let mean = 0;
  for (const v of small) mean += v;
  mean /= small.length;
  const out = Buffer.alloc(rgb.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r2 = rr(x, y);
      const g = Math.max(0.25, (a! + b1! * r2 + c! * r2 * r2) / Math.max(1, mean));
      const gain = 1 + (1 / g - 1) * strength * (weight ? weight(x, y) : 1);
      const k = (y * w + x) * 3;
      for (let ch = 0; ch < 3; ch++) out[k + ch] = Math.min(255, Math.round(rgb[k + ch]! * gain));
    }
  return out;
}

function solve(A: number[][], b: number[]): number[] {
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]! || 1e-9;
    for (let k = c; k < 4; k++) m[c]![k]! /= d;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row) => row[3]!);
}

/**
 * Which pixels of a chunk to keep when its margins are cut along the cheapest path instead of a straight line. The
 * cost is local detail (gradient of the blurred image), so the cut prefers open ground and goes around objects. Each
 * margin's path stays within half a margin of the straight cut (dynamic programming, one pixel of drift per step).
 */
async function pathKeep(px: Buffer, w: number, h: number, sides: { left: boolean; right: boolean; top: boolean; bottom: boolean }, mx: number, my: number): Promise<Uint8Array> {
  const g = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).greyscale().blur(3).raw().toBuffer();
  const cost = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      cost[k] = Math.abs(g[k + 1]! - g[k - 1]!) + Math.abs(g[k + w]! - g[k - w]!) + 1;
    }
  const keep = new Uint8Array(w * h).fill(1);
  // A seam across `len` steps, choosing a position in [lo, hi) per step; at(step, pos) gives the pixel index.
  const seam = (len: number, lo: number, hi: number, at: (s: number, p: number) => number): Int32Array => {
    const n = hi - lo;
    const acc = new Float32Array(len * n), from = new Int8Array(len * n);
    for (let p = 0; p < n; p++) acc[p] = cost[at(0, lo + p)]!;
    for (let s = 1; s < len; s++)
      for (let p = 0; p < n; p++) {
        let best = acc[(s - 1) * n + p]!, d = 0;
        if (p > 0 && acc[(s - 1) * n + p - 1]! < best) (best = acc[(s - 1) * n + p - 1]!), (d = -1);
        if (p < n - 1 && acc[(s - 1) * n + p + 1]! < best) (best = acc[(s - 1) * n + p + 1]!), (d = 1);
        acc[s * n + p] = best + cost[at(s, lo + p)]!;
        from[s * n + p] = d;
      }
    const out = new Int32Array(len);
    let p = 0;
    for (let q = 1; q < n; q++) if (acc[(len - 1) * n + q]! < acc[(len - 1) * n + p]!) p = q;
    for (let s = len - 1; s >= 0; s--) {
      out[s] = lo + p;
      p += from[s * n + p]!;
    }
    return out;
  };
  const band = (m: number) => [Math.round(m * 0.5), Math.round(m * 1.5)] as const;
  if (sides.left) {
    const [a, b] = band(mx);
    const s = seam(h, a, b, (y, x) => y * w + x);
    for (let y = 0; y < h; y++) for (let x = 0; x <= s[y]!; x++) keep[y * w + x] = 0;
  }
  if (sides.right) {
    const [a, b] = band(mx);
    const s = seam(h, w - b, w - a, (y, x) => y * w + x);
    for (let y = 0; y < h; y++) for (let x = s[y]!; x < w; x++) keep[y * w + x] = 0;
  }
  if (sides.top) {
    const [a, b] = band(my);
    const s = seam(w, a, b, (x, y) => y * w + x);
    for (let x = 0; x < w; x++) for (let y = 0; y <= s[x]!; y++) keep[y * w + x] = 0;
  }
  if (sides.bottom) {
    const [a, b] = band(my);
    const s = seam(w, h - b, h - a, (x, y) => y * w + x);
    for (let x = 0; x < w; x++) for (let y = s[x]!; y < h; y++) keep[y * w + x] = 0;
  }
  return keep;
}
