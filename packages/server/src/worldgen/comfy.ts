/**
 * ComfyUI calls for painting and reading places: Krea 2 (paint, repaint from a guide, continue), Qwen-Image 2.1 (edit:
 * a map redrawn as a walk plan, door marks) and SeedVR2 (upscale). Everything goes over ComfyUI's HTTP API through
 * the GPU broker (the configured comfyui provider's baseUrl, COMFY_URL overrides it), which gives every
 * installation's work its turn on the GPU and unloads one model before the next needs the memory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR, ROOT_DIR } from '../paths';
import { ComfyError, comfyFetch, savedImages, submitAndWait, viewImage } from '../genai/comfyclient';

const KREA = 'krea2_turbo_fp8_scaled.safetensors';
const QWEN = 'qwen_image_2.1_turbo_int8_convrot.safetensors';
const SEEDVR2 = 'seedvr2_7b_int8_convrot.safetensors';
/** AnyPaint sees the whole window as a reference this many pixels across (its default 384 loses small objects). */
const ANYPAINT_REFERENCE = 768;

const CACHE = path.join(DATA_DIR, 'cache');

export { comfyBase, ComfyError } from '../genai/comfyclient';

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

function workflow(name: string, vars: Record<string, string | number>): unknown {
  const fill = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const whole = node.match(/^\{\{(\w+)\}\}$/);
      if (whole && whole[1]! in vars) return vars[whole[1]!];
      return node.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
    }
    if (Array.isArray(node)) return node.map(fill);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v)]));
    return node;
  };
  return fill(JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', 'comfyui', name), 'utf8')) as Workflow);
}

async function upload(png: Buffer): Promise<string> {
  const name = `gd_${crypto.createHash('sha1').update(png).digest('hex').slice(0, 16)}.png`;
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), name);
  form.append('subfolder', 'gd_refs');
  form.append('overwrite', 'true');
  const res = await comfyFetch('/upload/image', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`ComfyUI upload failed: ${res.status}`);
  const out = (await res.json()) as { name: string; subfolder?: string };
  return out.subfolder ? `${out.subfolder}/${out.name}` : out.name;
}

/** Queue a workflow (the broker gives it its turn on the GPU) and return every image it saved (empty when it saved none). */
async function run(model: string, wf: unknown, timeoutMs = 900_000): Promise<Buffer[]> {
  const entry = await submitAndWait(wf, { workflow: model, timeoutMs });
  const out: Buffer[] = [];
  for (const img of savedImages(entry)) out.push(await viewImage(img));
  return out;
}

const one = (imgs: Buffer[], what: string) => {
  if (!imgs[0]) throw new ComfyError(`${what} returned no image`);
  return imgs[0];
};

/** Krea 2 Turbo, text to image (its turbo settings: 8 steps, cfg 1). */
export async function kreaPaint(prompt: string, width: number, height: number, seed: number): Promise<Buffer> {
  return one(await run(KREA, workflow('krea2_turbo_t2i.json', { prompt, width, height, seed, steps: 8, cfg: 1, checkpoint: KREA })), 'Krea');
}

/** Krea 2 Turbo, image to image: repaint `init` (resized to the output) at `denoise`; its layout survives, its content is new. */
export async function kreaRepaint(init: Buffer, prompt: string, width: number, height: number, seed: number, denoise: number): Promise<Buffer> {
  const png = await sharp(init).resize(width, height, { fit: 'fill' }).removeAlpha().png().toBuffer();
  return one(await run(KREA, workflow('krea2_img2img.json', { init: await upload(png), prompt, seed, steps: 8, denoise, checkpoint: KREA })), 'Krea');
}

/**
 * Krea 2 Turbo, image to image over part of a picture: grey values of `mask` (same size as `init`) are how strongly
 * each pixel is repainted at `denoise` (Differential Diffusion; white fully, black not at all), so a repaint can fade
 * into what is already there.
 */
export async function kreaMasked(init: Buffer, mask: Buffer, prompt: string, seed: number, denoise: number): Promise<Buffer> {
  const png = await sharp(init).removeAlpha().png().toBuffer();
  return one(await run(KREA, workflow('krea2_img2img_mask.json', { init: await upload(png), mask: await upload(mask), prompt, seed, steps: 8, denoise, checkpoint: KREA })), 'Krea');
}

/**
 * Qwen-Image 2.1 Turbo, edit: the model sees `ref` and paints what `prompt` asks of it at the reference's size (a
 * multiple of 16). `more` are further references at the same size ("Picture 2", ...). Deterministic for a seed, so
 * cached like the reader's answers.
 *
 * Nothing passes `more` yet: the extra references are kept on purpose (from an experiment) so a later step can show
 * Qwen a second picture, such as a style or a character to match, without rebuilding the workflow.
 */
export async function qwenEdit(ref: Buffer, prompt: string, seed: number, more: Buffer[] = []): Promise<Buffer> {
  const meta = await sharp(ref).metadata();
  const width = Math.round(meta.width! / 16) * 16, height = Math.round(meta.height! / 16) * 16;
  const sized = (b: Buffer) => sharp(b).resize(width, height, { fit: 'fill' }).removeAlpha().png().toBuffer();
  const png = await sized(ref), extra = await Promise.all(more.map(sized));
  const c = cached('qwenedit', Buffer.concat([png, ...extra]), `${prompt}|${seed}`);
  const hit = c.get();
  if (hit) return hit[0]!;
  const wf = workflow('qwen21_edit.json', { ref_1: await upload(png), prompt, width, height, seed, checkpoint: QWEN }) as Workflow;
  for (const [i, b] of extra.entries()) {
    wf[`ref${i + 2}`] = { class_type: 'LoadImage', inputs: { image: await upload(b) } };
    wf['6']!.inputs[`images.image_${i + 2}`] = [`ref${i + 2}`, 0];
  }
  return c.put([one(await run(QWEN, wf), 'Qwen edit')])[0]!;
}

/** Krea 2 AnyPaint: paint the white part of `mask` to continue `init`, redrawing `redraw` px of its boundary. */
export async function kreaContinue(init: Buffer, mask: Buffer, prompt: string, seed: number, redraw = 32): Promise<Buffer> {
  return one(await run(KREA, workflow('krea2_anypaint.json', { init: await upload(init), mask: await upload(mask), prompt, seed, redraw, refmax: ANYPAINT_REFERENCE, checkpoint: KREA })), 'AnyPaint');
}

/** A disk cache keyed by the image and the request (Qwen edits and SeedVR2 are deterministic). */
function cached(kind: string, png: Buffer, key: string) {
  const dir = path.join(CACHE, kind, crypto.createHash('sha1').update(png).update(`|${key}`).digest('hex'));
  return {
    get: (): Buffer[] | null => (fs.existsSync(path.join(dir, 'done')) ? fs.readdirSync(dir).filter((n) => n.endsWith('.png')).sort().map((n) => fs.readFileSync(path.join(dir, n))) : null),
    put: (imgs: Buffer[]) => {
      fs.mkdirSync(dir, { recursive: true });
      imgs.forEach((m, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.png`), m));
      fs.writeFileSync(path.join(dir, 'done'), '');
      return imgs;
    },
  };
}

/**
 * SeedVR2 upscale by an integer factor, in overlapping tiles (one 4K tile does not fit in memory) blended over a
 * narrow band. SeedVR2 restores detail rather than blurring.
 */
export async function upscale(png: Buffer, factor: number, seed: number): Promise<Buffer> {
  const c = cached('seedvr2', png, `${factor}|${seed}`);
  const hit = c.get();
  if (hit) return hit[0]!;
  const F = factor;
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, OW = W * F, OH = H * F;
  const TW = Math.min(W, Math.round(3200 / F)), TH = Math.min(H, Math.round(1920 / F)), OV = Math.round(192 / F);
  const starts = (total: number, size: number) => {
    const out: number[] = [];
    for (let v = 0; ; v += size - OV) {
      out.push(Math.min(v, total - size));
      if (v + size >= total) break;
    }
    return out;
  };
  const acc = new Float32Array(OW * OH * 3), wsum = new Float32Array(OW * OH);
  for (const y0 of starts(H, TH))
    for (const x0 of starts(W, TW)) {
      const tile = await sharp(data, { raw: { width: W, height: H, channels: 3 } }).extract({ left: x0, top: y0, width: TW, height: TH }).png().toBuffer();
      const up = one(await run(SEEDVR2, workflow('seedvr2_upscale.json', { ref_1: await upload(tile), scale: F, seed, checkpoint: SEEDVR2 })), 'SeedVR2');
      const px = await sharp(up).resize(TW * F, TH * F).removeAlpha().raw().toBuffer();
      const band = 16 * F, start = (OV * F) / 2 - band / 2;
      const ramp = (d: number) => Math.max(0, Math.min(1, (d - start) / band));
      for (let y = 0; y < TH * F; y++)
        for (let x = 0; x < TW * F; x++) {
          let a = 1;
          if (x0 > 0) a = Math.min(a, ramp(x));
          if (x0 + TW < W) a = Math.min(a, ramp(TW * F - 1 - x));
          if (y0 > 0) a = Math.min(a, ramp(y));
          if (y0 + TH < H) a = Math.min(a, ramp(TH * F - 1 - y));
          if (!a) continue;
          const k = (y0 * F + y) * OW + x0 * F + x, t = y * TW * F + x;
          wsum[k]! += a;
          for (let ch = 0; ch < 3; ch++) acc[k * 3 + ch]! += px[t * 3 + ch]! * a;
        }
    }
  const out = Buffer.alloc(OW * OH * 3);
  for (let k = 0; k < OW * OH; k++) for (let ch = 0; ch < 3; ch++) out[k * 3 + ch] = Math.round(acc[k * 3 + ch]! / Math.max(1e-6, wsum[k]!));
  return c.put([await sharp(out, { raw: { width: OW, height: OH, channels: 3 } }).png().toBuffer()])[0]!;
}
