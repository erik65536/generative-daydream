import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ACTOR_CLIPS, ANIM_DIRS, clipFrame, clipKey, dirRow, type AnimClip, type AssetRecord, type WorldDefinition } from '@gd/shared';
import { actorSprites, bodyPlan, needsAnimation } from '../src/anim/actors';
import { saveAnimation } from '../src/anim/animator';
import { worldAssetDir } from '../src/storage';

const sprite = (key: string, prompt = '', extra: Partial<AssetRecord> = {}): AssetRecord => ({ key, kind: 'sprite', prompt, status: 'ok', file: `${key}.png`, ...extra });

describe('sheet rows and frames', () => {
  it('picks the row from the direction on screen', () => {
    // Ground (1, 1) runs straight down the screen; (1, -1) straight right.
    expect(ANIM_DIRS[dirRow(1, 1)]).toBe('S');
    expect(ANIM_DIRS[dirRow(-1, -1)]).toBe('N');
    expect(ANIM_DIRS[dirRow(1, -1)]).toBe('E');
    expect(ANIM_DIRS[dirRow(-1, 1)]).toBe('W');
    // One ground axis alone is a diagonal on screen.
    expect(ANIM_DIRS[dirRow(1, 0)]).toBe('SE');
    expect(ANIM_DIRS[dirRow(0, 1)]).toBe('SW');
    expect(ANIM_DIRS[dirRow(-1, 0)]).toBe('NW');
    expect(ANIM_DIRS[dirRow(0, -1)]).toBe('NE');
    expect(dirRow(0, 0)).toBe(0);
  });

  it('loops gaits at the pace of the ground and holds one-shots on their last frame', () => {
    const walk: AnimClip = { frames: 16, fps: 12, loop: true, stride: 1 };
    // One metre per second over a one-metre stride: one loop per second.
    expect(clipFrame(walk, 0.5, 1)).toBe(8);
    expect(clipFrame(walk, 1.25, 1)).toBe(4);
    expect(clipFrame(walk, 0.25, 2)).toBe(8);
    const die: AnimClip = { frames: 30, fps: 12, loop: false };
    expect(clipFrame(die, 1)).toBe(12);
    expect(clipFrame(die, 99)).toBe(29);
  });

  it('keeps clip sheets apart from the base sprite and older pose strips', () => {
    expect(clipKey('spr_npc_a', 'walk')).toBe('spr_npc_a@anim-walk');
    expect(clipKey('spr_npc_a', 'walk')).not.toBe('spr_npc_a@walk');
  });
});

describe('actors', () => {
  it('reads body plans from the brief', () => {
    expect(bodyPlan(sprite('spr_npc_n_x', 'A floating jellyfish lantern'))).toBe('humanoid');
    expect(bodyPlan(sprite('spr_origin_cl_a_feminine', 'A wolf-masked hunter'))).toBe('humanoid');
    expect(bodyPlan(sprite('spr_mon_f0_a', 'A gaunt grey wolf with a kelp mane'))).toBe('quadruped');
    expect(bodyPlan(sprite('spr_mon_f0_b', 'A drifting lantern creature with trailing tentacles'))).toBe('floater');
    expect(bodyPlan(sprite('spr_mon_f0_c', 'A hooded cultist in salt-stained robes'))).toBe('humanoid');
    expect(bodyPlan(sprite('spr_mon_f0_e', 'Broad crablike body plated in translucent saltglass shards'))).toBe('quadruped');
    expect(bodyPlan(sprite('spr_mon_f3_a', 'Lean, hooded clerk-warden with ink-stained gloves, Ledger Hound, hostile creature'))).toBe('humanoid');
    expect(bodyPlan(sprite('spr_boss_b0_d', 'A tall knight whose wolf pelt hangs from his shoulders'))).toBe('humanoid');
  });

  it('animates character and creature sprites only, again when repainted', () => {
    const w = {
      assets: {
        spr_npc_a: sprite('spr_npc_a'),
        'spr_npc_a@walk': sprite('spr_npc_a@walk', '', { ref: 'spr_npc_a', variant: 'walk' }),
        spr_mon_b: sprite('spr_mon_b', '', { status: 'failed' }),
        icon_x: { ...sprite('icon_x'), kind: 'icon' },
        obj_chest: { ...sprite('obj_chest'), kind: 'object' },
      },
    } as unknown as WorldDefinition;
    expect(actorSprites(w).map((a) => a.key)).toEqual(['spr_npc_a']);
    const rec = w.assets.spr_npc_a!;
    expect(needsAnimation(rec)).toBe(true);
    rec.anim = { v: 1, body: 'humanoid', scale: 2, cell: [10, 10], anchor: [5, 8], height: 1.75, from: 'spr_npc_a.png', clips: {} };
    expect(needsAnimation(rec)).toBe(false);
    rec.file = 'spr_npc_a_v2.png';
    expect(needsAnimation(rec)).toBe(true);
  });

  it('saves a sheet per clip and the layout on the sprite', async () => {
    const id = `w_animtest_${Date.now().toString(36)}`;
    const w = { id, assets: { spr_npc_a: sprite('spr_npc_a') } } as unknown as WorldDefinition;
    const sheet = await sharp({ create: { width: 40, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();
    const r = {
      body: 'humanoid' as const, cell: [10, 10] as [number, number], anchor: [5, 8] as [number, number],
      clips: { idle: { frames: 4, fps: 8, loop: true }, die: { frames: 4, fps: 12, loop: false } }, sheets: { idle: sheet, die: sheet },
    };
    const anim = saveAnimation(w, 'spr_npc_a', r);
    expect(w.assets.spr_npc_a!.anim).toEqual(anim);
    expect(anim.from).toBe('spr_npc_a.png');
    expect(Object.keys(anim.clips)).toEqual(['idle', 'die']);
    for (const clip of ['idle', 'die'] as const) {
      const rec = w.assets[clipKey('spr_npc_a', clip)]!;
      expect(rec).toMatchObject({ kind: 'sprite', status: 'ok', ref: 'spr_npc_a', variant: 'anim', width: 40, height: 80 });
      expect(rec.file).toMatch(/^[\w.-]+\.webp$/);
      expect(fs.existsSync(path.join(worldAssetDir(id), rec.file!))).toBe(true);
    }
    expect(w.assets[clipKey('spr_npc_a', 'walk')]).toBeUndefined();
    // Saving again replaces the files.
    const before = w.assets[clipKey('spr_npc_a', 'idle')]!.file!;
    await new Promise((res) => setTimeout(res, 5));
    saveAnimation(w, 'spr_npc_a', r);
    expect(fs.existsSync(path.join(worldAssetDir(id), before))).toBe(false);
    fs.rmSync(path.dirname(worldAssetDir(id)), { recursive: true, force: true });
  });
});

/** A small synthetic floater: a column hanging from a root, with two chains (no model, no texture). */
function syntheticRig(dir: string) {
  const pos: number[] = [], idx: number[] = [], skinIndex: number[] = [], skinWeight: number[] = [];
  const rings = 8, seg = 12;
  for (let r = 0; r <= rings; r++) {
    const y = 0.2 + (1.4 * r) / rings;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * 0.15, y, Math.sin(a) * 0.15);
      // Bones: 0 root (top), 1 upper, 2 lower; weights by height.
      const b = y > 1.2 ? 0 : y > 0.7 ? 1 : 2;
      skinIndex.push(b, 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < seg; s++) {
      const a = r * seg + s, b = r * seg + ((s + 1) % seg), c = a + seg, d = b + seg;
      idx.push(a, c, b, b, c, d);
    }
  const rig = {
    meta: { body: 'floater', height: 1.75 }, texture: null, pos, uv: null, idx, skinIndex, skinWeight,
    bones: [
      { name: 'root', parent: null, pos: [0, 1.6, 0] },
      { name: 'arm1', parent: 'root', pos: [0, 1.0, 0] },
      { name: 'arm2', parent: 'arm1', pos: [0, 0.4, 0] },
    ],
  };
  fs.writeFileSync(path.join(dir, 'rig.json'), JSON.stringify(rig));
}

async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright-core');
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

describe('rendering sheets', async () => {
  const ok = await chromiumInstalled();
  it.skipIf(!ok)('renders every clip in eight directions around a fixed anchor', async () => {
    const { renderSheets, closeRenderer } = await import('../src/anim/render');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-anim-'));
    try {
      syntheticRig(dir);
      const r = await renderSheets(dir, { clips: ACTOR_CLIPS, scale: 1, ss: 1 });
      expect(Object.keys(r.clips).sort()).toEqual([...ACTOR_CLIPS].sort());
      const [cw, ch] = r.cell;
      expect(r.anchor[0]).toBe(cw / 2);
      expect(r.anchor[1]).toBeGreaterThan(0);
      expect(r.anchor[1]).toBeLessThan(ch);
      // The figure stands about 82 px tall at scale 1 (its 1.75 m), hovering: the cell holds it with little spare.
      expect(ch).toBeGreaterThan(60);
      expect(ch).toBeLessThan(200);
      for (const [name, clip] of Object.entries(r.clips)) {
        const meta = await sharp(r.sheets[name as keyof typeof r.sheets]!).metadata();
        expect(meta.width).toBe(cw * clip!.frames);
        expect(meta.height).toBe(ch * 8);
        // Transparent around the figure, something drawn in the middle of the first cell.
        const { data, info } = await sharp(r.sheets[name as keyof typeof r.sheets]!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!;
        expect(alpha(0, 0)).toBe(0);
        let filled = 0;
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (alpha(x, y) > 128) filled++;
        expect(filled).toBeGreaterThan(50);
      }
      expect(r.clips.walk?.stride).toBeGreaterThan(0);
      expect(r.clips.die?.loop).toBe(false);
    } finally {
      await closeRenderer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
