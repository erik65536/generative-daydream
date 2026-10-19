/**
 * Direct ComfyUI calls for the painted-zone prototype: text-to-image, inpainting and SAM 3 segmentation,
 * returning every image a workflow saves (SAM saves one mask per object).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../paths';

const BASE = process.env.COMFY_URL ?? 'http://127.0.0.1:8188';
const QWEN = 'qwen_image_2.1_turbo_int8_convrot.safetensors';
const SAM = 'sam3.1_multiplex_fp16.safetensors';
const TURBO = '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0';
const QWEN_FULL = 'qwen_image_2.1_int8_convrot.safetensors';

/** ZP_MODEL=full: the non-turbo model with a normal scheduler, more steps and real guidance. */
function model(wf: Workflow): Workflow {
  if (process.env.ZP_MODEL !== 'full') return wf;
  wf['451']!.inputs.unet_name = QWEN_FULL;
  wf['484'] = { class_type: 'BasicScheduler', inputs: { model: ['490', 0], scheduler: 'simple', steps: Number(process.env.ZP_STEPS ?? 25), denoise: 1 } };
  wf['489']!.inputs.cfg = Number(process.env.ZP_CFG ?? 1);
  // The negative prompt only counts when CFG is above 1.
  if (process.env.ZP_NEG) wf['452']!.inputs.negative_prompt = process.env.ZP_NEG;
  return wf;
}

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

function template(name: string): Workflow {
  return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', 'comfyui', name), 'utf8'));
}

function fill(node: unknown, vars: Record<string, string | number>): unknown {
  if (typeof node === 'string') {
    const whole = node.match(/^\{\{(\w+)\}\}$/);
    if (whole && whole[1]! in vars) return vars[whole[1]!];
    return node.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  }
  if (Array.isArray(node)) return node.map((n) => fill(n, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, vars)]));
  return node;
}

export async function upload(png: Buffer): Promise<string> {
  const name = `zp_${crypto.createHash('sha1').update(png).digest('hex').slice(0, 16)}.png`;
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), name);
  form.append('subfolder', 'gd_refs');
  form.append('overwrite', 'true');
  const res = await fetch(`${BASE}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`ComfyUI upload failed: ${res.status}`);
  const out = (await res.json()) as { name: string; subfolder?: string };
  return out.subfolder ? `${out.subfolder}/${out.name}` : out.name;
}

/** Queue a workflow and return every saved image (empty when the workflow saved none). */
export async function run(workflow: unknown, timeoutMs = 600_000): Promise<Buffer[]> {
  const q = await fetch(`${BASE}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: 'gd-zonepaint' }) });
  const queued = (await q.json()) as any;
  const id = queued.prompt_id as string;
  if (!id) throw new Error(`ComfyUI did not queue: ${JSON.stringify(queued).slice(0, 400)}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    const hist = (await (await fetch(`${BASE}/history/${id}`)).json()) as any;
    const entry = hist[id];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') throw new Error(`ComfyUI error: ${JSON.stringify(entry.status.messages?.find((m: any) => m[0] === 'execution_error')?.[1]?.exception_message ?? entry.status).slice(0, 400)}`);
    if (!entry.status?.completed) continue;
    const out: Buffer[] = [];
    for (const o of Object.values(entry.outputs ?? {}) as any[]) {
      for (const img of o.images ?? []) {
        const p = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
        out.push(Buffer.from(await (await fetch(`${BASE}/view?${p}`)).arrayBuffer()));
      }
    }
    return out;
  }
  throw new Error('ComfyUI timed out');
}

export async function textToImage(prompt: string, width: number, height: number, seed: number): Promise<Buffer> {
  const [img] = await run(fill(template('qwen_image_2_1_turbo_t2i.json'), { prompt, width, height, seed, checkpoint: QWEN }));
  if (!img) throw new Error('no image');
  return img;
}

/**
 * Repaint the white part of `mask` (binary) in `init`. The model also sees `ref` (default: init itself; null: no
 * reference image), encoded at `refres` (0 = its own size).
 */
export async function inpaint(init: Buffer, mask: Buffer, prompt: string, width: number, height: number, seed: number, ref?: Buffer | null, refres = 0): Promise<Buffer> {
  const wf = model(template('qwen_image_2_1_turbo_inpaint.json'));
  if (ref === null) delete wf['452']!.inputs['images.image_1'];
  const [img] = await run(fill(wf, { ref_1: ref === null ? '' : await upload(ref ?? init), init: await upload(init), mask: await upload(mask), prompt, negative: '', width, height, seed, checkpoint: QWEN, sigmas: TURBO, refres }));
  if (!img) throw new Error('no image');
  return img;
}

/** SAM 3: one mask image per detected object for a text prompt ("door", "tree:40" for up to 40). */
export async function segment(png: Buffer, prompt: string, threshold = 0.4): Promise<Buffer[]> {
  // Cached on disk by image, prompt and threshold (SAM is deterministic).
  const key = crypto.createHash('sha1').update(png).update(`|${prompt}|${threshold}`).digest('hex');
  const dir = path.join(ROOT_DIR, 'data', 'cache', 'sam', key);
  if (fs.existsSync(path.join(dir, 'done'))) return fs.readdirSync(dir).filter((n) => n.endsWith('.png')).sort().map((n) => fs.readFileSync(path.join(dir, n)));
  const store = (ms: Buffer[]) => {
    fs.mkdirSync(dir, { recursive: true });
    ms.forEach((m, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.png`), m));
    fs.writeFileSync(path.join(dir, 'done'), '');
    return ms;
  };
  try {
    return store(await run(fill(template('sam3_detect.json'), { ref_1: await upload(png), prompt, threshold, checkpoint: SAM })));
  } catch (e) {
    // Nothing found: the empty mask batch fails to save.
    if (/size|empty|shape|0 elements|cannot/i.test(String(e))) return store([]);
    throw e;
  }
}

export async function freeGpu() {
  await fetch(`${BASE}/free`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => {});
}

/** Paint from pure noise while the edit model looks at reference images (kept at their own size). */
export async function edit(refs: Buffer[], prompt: string, width: number, height: number, seed: number, refres = 0): Promise<Buffer> {
  const wf = model(template('qwen_image_2_1_turbo_edit.json'));
  const vars: Record<string, string | number> = { prompt, width, height, seed, checkpoint: QWEN, refres };
  for (let i = 0; i < refs.length; i++) {
    vars[`ref_${i + 1}`] = await upload(refs[i]!);
    if (i > 0) {
      wf[`500_${i + 1}`] = { class_type: 'LoadImage', inputs: { image: `{{ref_${i + 1}}}` } };
      wf['452']!.inputs[`images.image_${i + 1}`] = [`500_${i + 1}`, 0];
    }
  }
  const [img] = await run(fill(wf, vars));
  if (!img) throw new Error('no image');
  return img;
}

/** MoGe-2: per-pixel surface normals (camera frame, OpenGL: x right, y up, z towards the viewer) and depth. */
export async function geometry(png: Buffer): Promise<{ normal: Buffer; depth: Buffer }> {
  const key = crypto.createHash('sha1').update(png).update('|moge2').digest('hex');
  const dir = path.join(ROOT_DIR, 'data', 'cache', 'moge', key);
  if (fs.existsSync(path.join(dir, 'depth.png'))) return { normal: fs.readFileSync(path.join(dir, 'normal.png')), depth: fs.readFileSync(path.join(dir, 'depth.png')) };
  const [normal, depth] = await run(fill(template('moge_geometry.json'), { ref_1: await upload(png), checkpoint: 'moge_2_vitl_normal_fp16.safetensors' }));
  if (!normal || !depth) throw new Error('MoGe returned no images');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'normal.png'), normal);
  fs.writeFileSync(path.join(dir, 'depth.png'), depth);
  return { normal, depth };
}

/**
 * Edit-mode outpainting: the window (unknown parts flat grey #808080) is the edit reference at its own size, and the
 * model paints the whole window from noise, seeing the known part cleanly at every step. Optional LoRA (model only).
 */
export async function outpaintEdit(win: Buffer, prompt: string, width: number, height: number, seed: number, lora?: string): Promise<Buffer> {
  const wf = model(template('qwen_image_2_1_turbo_edit.json'));
  if (lora) {
    wf['455'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['451', 0], lora_name: lora, strength_model: 1 } };
    wf['490']!.inputs.model = ['455', 0];
  }
  const [img] = await run(fill(wf, { ref_1: await upload(win), prompt, width, height, seed, checkpoint: wf['451']!.inputs.unet_name === '{{checkpoint}}' ? QWEN : String(wf['451']!.inputs.unet_name), refres: 0 }));
  if (!img) throw new Error('no image');
  return img;
}

const KREA = 'krea2_turbo_fp8_scaled.safetensors';

/** Krea 2 Turbo text-to-image (official turbo settings: 8 steps, cfg 1, euler/simple). */
export async function kreaTextToImage(prompt: string, width: number, height: number, seed: number): Promise<Buffer> {
  const [img] = await run(fill(template('krea2_turbo_t2i.json'), { prompt, width, height, seed, steps: 8, cfg: 1, checkpoint: KREA }));
  if (!img) throw new Error('no image');
  return img;
}

/** Krea 2 Turbo mask inpainting (SetLatentNoiseMask + Differential Diffusion): repaint the white part of `mask`. */
export async function kreaInpaint(init: Buffer, mask: Buffer, prompt: string, seed: number): Promise<Buffer> {
  const [img] = await run(fill(template('krea2_turbo_inpaint.json'), { init: await upload(init), mask: await upload(mask), prompt, seed, checkpoint: KREA }));
  if (!img) throw new Error('no image');
  return img;
}

/** Krea 2 AnyPaint (community LoRA + nodes): repaint the white part of `mask`, redrawing `redraw` px of the boundary. */
export async function kreaAnyPaint(init: Buffer, mask: Buffer, prompt: string, seed: number, redraw = 32): Promise<Buffer> {
  const [img] = await run(fill(template('krea2_anypaint.json'), { init: await upload(init), mask: await upload(mask), prompt, seed, redraw, refmax: Number(process.env.ZP_REFMAX ?? 768), checkpoint: KREA }));
  if (!img) throw new Error('no image');
  return img;
}
