/**
 * Actor animation, from one painted standing view to sprite sheets in eight directions.
 *
 * Steps, each saved in the actor's job directory (data/worlds/<id>/anim/<key>/) so a resumed build continues and a
 * new clip is only a re-render:
 * 1. mesh: Pixal3D (native ComfyUI) turns the cut-out view into a textured mesh. GPU, ComfyUI.
 * 2. rig. Humanoids: SAM 3D Body fits Meta's MHR body to the view (GPU, ComfyUI, seconds) and its skin is copied
 *    onto the mesh with a 20-bone game skeleton. Other bodies: SkinTokens rigs the mesh (GPU alone: about 14 GB, so
 *    ComfyUI and the local LLM are unloaded first) and its chains are named (legs, spine, tail; tentacles).
 * 3. clips. Humanoids: library clips retargeted onto the rig. Others: procedural clips per body plan.
 * 4. render: three.js in headless Chromium at the game camera, toon shading and an ink outline, a sheet per clip.
 * The heavy work runs in Python (packages/server/animator); see docs/world-art.md.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACTOR_CLIPS, ANIM_VERSION, clipKey, type ActorAnim, type BodyPlan, type ClipName, type WorldDefinition } from '@gd/shared';
import { genai } from '../genai/service';
import { callContext } from '../genai/context';
import { promptTag } from '../gpu/presence';
import type { AnimationConfig, ProviderConfig } from '../genai/types';
import { worldAssetDir, worldDir } from '../storage';
import { renderSheets, type Rendered } from './render';

const ANIMATOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'animator', 'cli.py');

/** Library clips for humanoids (Quaternius UAL, CC0): which source clip, at what frame rate, what to measure. */
export const HUMANOID_CLIPS: { name: ClipName; source: string; fps: number; stride?: boolean; event?: boolean }[] = [
  { name: 'idle', source: 'Idle_Loop', fps: 8 },
  { name: 'walk', source: 'Walk_Loop', fps: 12, stride: true },
  { name: 'run', source: 'Jog_Fwd_Loop', fps: 14, stride: true },
  { name: 'attack', source: 'Sword_Attack', fps: 15, event: true },
  { name: 'cast', source: 'Spell_Simple_Shoot', fps: 15, event: true },
  { name: 'hit', source: 'Hit_Chest', fps: 15 },
  { name: 'die', source: 'Death01', fps: 12 },
];

/** The figure's height in metres before the game's own size scale (as the still sprites are drawn). */
export const ACTOR_HEIGHT = 1.75;

export interface ActorJob {
  worldId: string;
  /** The sprite's asset key. */
  key: string;
  /** The standing view, cut out (PNG with alpha, or on a flat background). */
  image: Buffer;
  body: BodyPlan;
  seed?: number;
}

export interface AnimateOptions {
  /** Run a GPU step in its turn: wraps every model call (a build's GPU queue). */
  gpuTurn?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Scheduler urgency (0 = most urgent). */
  rank?: number;
  onStep?: (msg: string) => void;
  /** Redo from this step on, even if its files exist. */
  redoFrom?: 'mesh' | 'rig' | 'clips' | 'render';
}

export function animationConfig(): AnimationConfig | undefined {
  return genai().config.animation;
}

export const jobDir = (worldId: string, key: string) => path.join(worldDir(worldId), 'anim', key);

/** Run one animator step; resolves with its JSON result. */
export function runStep(cfg: AnimationConfig, step: string, job: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // Its ComfyUI prompts carry the job's tag; a stopped job ends the step.
    const p = spawn(cfg.python, [ANIMATOR, step, job, JSON.stringify(args)], { env: { ...process.env, PYTHONIOENCODING: 'utf8', GD_PROMPT_TAG: JSON.stringify(promptTag(`animator ${step}`)) } });
    const cancelled = callContext()?.cancelled;
    let stopped = false;
    const watch = cancelled
      ? setInterval(() => {
          if (!cancelled()) return;
          stopped = true;
          p.kill();
        }, 1000)
      : undefined;
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearInterval(watch);
      if (stopped) return reject(new Error('cancelled'));
      const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      let res: Record<string, unknown> | undefined;
      try {
        res = line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
      } catch {
        res = undefined;
      }
      if (code === 0 && res?.ok) resolve(res);
      else reject(new Error(`animator ${step}: ${String(res?.error ?? err.slice(-800) ?? `exit ${code}`)}`));
    });
  });
}

function comfyProvider(cfg: AnimationConfig): [string, ProviderConfig] | undefined {
  const providers = Object.entries(genai().config.providers);
  return (cfg.comfyProvider ? providers.find(([n]) => n === cfg.comfyProvider) : undefined) ?? providers.find(([, p]) => p.type === 'comfyui');
}

/** Run `fn` holding the GPU scheduler for `model` on `provider` (when it belongs to a GPU group). */
function onGpu<T>(provider: [string, ProviderConfig] | undefined, model: string, rank: number, fn: () => Promise<T>): Promise<T> {
  if (!provider?.[1].gpu) return fn();
  return genai().gpu.group(provider[1].gpu).run(provider[0], model, provider[1], fn, rank);
}

/** The animator as its own "provider" in the ComfyUI GPU group: taking a turn unloads ComfyUI and the local LLM. */
function exclusive(cfg: AnimationConfig): [string, ProviderConfig] | undefined {
  const comfy = comfyProvider(cfg);
  return comfy?.[1].gpu ? ['animator', { type: 'procedural', gpu: comfy[1].gpu }] : undefined;
}

const has = (dir: string, ...files: string[]) => files.every((f) => fs.existsSync(path.join(dir, f)));
/** Below this, a mesh's height-to-width ratio over the picture's means it lost parts (see animator/mesh.py). Good meshes score 0.93-1.01. */
const MIN_SHAPE = 0.9;
/** An ankle further than this (metres) from the mesh around it has no leg (see animator/rig_human.py); a leg in a boot is a few cm. */
const MAX_LEG_GAP = 0.09;

/** Make (or resume) an actor's rig and render its sheets. Throws when a step fails. */
export async function animateActor(job: ActorJob, opts: AnimateOptions = {}): Promise<Rendered & { body: BodyPlan }> {
  const cfg = animationConfig();
  if (!cfg) throw new Error('animation is not configured (genai config "animation")');
  if (job.body !== 'humanoid' && !cfg.skintokens) throw new Error(`no rigger for a ${job.body}: configure animation.skintokens`);
  const dir = jobDir(job.worldId, job.key);
  fs.mkdirSync(dir, { recursive: true });
  const turn = opts.gpuTurn ?? (<T>(fn: () => Promise<T>) => fn());
  const rank = opts.rank ?? 3;
  const say = opts.onStep ?? (() => undefined);
  const comfy = comfyProvider(cfg);

  // A new image (repainted) or a different body plan starts over.
  const hash = crypto.createHash('sha1').update(job.image).update(job.body).digest('hex').slice(0, 16);
  const stateFile = path.join(dir, 'job.json');
  const state = fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { hash?: string }) : {};
  const order = ['mesh', 'rig', 'clips', 'render'] as const;
  const redo = new Set<string>(opts.redoFrom ? order.slice(order.indexOf(opts.redoFrom)) : []);
  if (state.hash !== hash) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'input.png'), job.image);
    fs.writeFileSync(stateFile, JSON.stringify({ hash, body: job.body }));
  }

  const seed = job.seed ?? 56;
  const mesh = (s: number) => turn(() => onGpu(comfy, 'pixal3d', rank, () => runStep(cfg, 'mesh', dir, { comfyUrl: comfy?.[1].baseUrl, seed: s })));
  /** Set the current mesh (and what was made from it) aside, or bring it back. */
  const MADE = ['mesh.glb', 'mesh_input.png', 'rig.json', 'tex.png'];
  const stash = () => MADE.forEach((f) => has(dir, f) && fs.renameSync(path.join(dir, f), path.join(dir, `first_${f}`)));
  const unstash = (keep: boolean) =>
    MADE.forEach((f) => {
      const p = path.join(dir, `first_${f}`);
      if (keep && fs.existsSync(p)) fs.renameSync(p, path.join(dir, f));
      else fs.rmSync(p, { force: true });
    });
  if (redo.has('mesh') || !has(dir, 'mesh.glb', 'mesh_input.png')) {
    say('Making the 3D model');
    const first = await mesh(seed);
    // A mesh much squatter than the picture lost parts (boots under a coat, a weapon): try once more, keep the better.
    if (Number(first.shape) < MIN_SHAPE) {
      say(`The model lost parts (shape ${first.shape}): trying another`);
      stash();
      const second = await mesh(seed + 101);
      unstash(Number(second.shape) < Number(first.shape));
    }
    redo.add('rig');
  }
  if (redo.has('rig') || !has(dir, 'rig.json', 'tex.png')) {
    say('Rigging');
    if (job.body === 'humanoid') {
      if (redo.has('mesh') || !has(dir, 'body.glb')) await turn(() => onGpu(comfy, 'sam3d-body', rank, () => runStep(cfg, 'body', dir, { comfyUrl: comfy?.[1].baseUrl })));
      const first = await runStep(cfg, 'rig-human', dir, { height: ACTOR_HEIGHT });
      // An ankle with no mesh around it: the model made the lower body one mass (a coat down to the ground).
      // The same picture with another seed usually gets the legs; keep whichever covers the ankles better.
      if (Number(first.legCover) > MAX_LEG_GAP) {
        say(`The model has no leg at an ankle (${first.legCover} m): trying another`);
        stash();
        await mesh(seed + 202);
        const second = await runStep(cfg, 'rig-human', dir, { height: ACTOR_HEIGHT });
        unstash(Number(second.legCover) >= Number(first.legCover));
      }
    } else {
      const st = cfg.skintokens!;
      const run = () => runStep(cfg, 'skintokens', dir, { dir: st.dir, python: st.python, device: st.device ?? 'cuda' });
      await (st.device === 'cpu' ? run() : turn(() => onGpu(exclusive(cfg), 'skintokens', rank, run)));
      await runStep(cfg, 'rig-auto', dir, { body: job.body, height: ACTOR_HEIGHT });
    }
    redo.add('clips');
  }
  if (job.body === 'humanoid' && (redo.has('clips') || !has(dir, 'clips.json'))) {
    say('Fitting the motions');
    await runStep(cfg, 'retarget', dir, { library: cfg.library, clips: HUMANOID_CLIPS });
  }
  say('Rendering eight directions');
  const rendered = await renderSheets(dir, { clips: ACTOR_CLIPS, scale: cfg.scale ?? 2, pitch: cfg.pitch });
  return { ...rendered, body: job.body };
}

/**
 * Save rendered sheets with a world's assets: each clip as `<key>@anim-<clip>` (a versioned file name, so browsers may
 * cache it forever), and the clip timing and layout on the sprite's own record.
 */
export function saveAnimation(w: WorldDefinition, key: string, r: Rendered & { body: BodyPlan }, scale = 2): ActorAnim {
  const dir = worldAssetDir(w.id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  for (const clip of ACTOR_CLIPS) {
    const k = clipKey(key, clip);
    const old = w.assets[k]?.file;
    if (old) fs.rmSync(path.join(dir, old), { force: true });
    const sheet = r.sheets[clip];
    if (!sheet) {
      delete w.assets[k];
      continue;
    }
    const file = `${k.replace('@', '_')}_${stamp}.webp`;
    fs.writeFileSync(path.join(dir, file), sheet);
    w.assets[k] = { key: k, kind: 'sprite', file, prompt: `${clip} of ${key}`, status: 'ok', ref: key, variant: 'anim', width: r.cell[0] * r.clips[clip]!.frames, height: r.cell[1] * 8 };
  }
  const anim: ActorAnim = { v: ANIM_VERSION, body: r.body, scale, cell: r.cell, anchor: r.anchor, height: ACTOR_HEIGHT, from: w.assets[key]?.file ?? '', clips: r.clips };
  if (w.assets[key]) w.assets[key]!.anim = anim;
  return anim;
}
