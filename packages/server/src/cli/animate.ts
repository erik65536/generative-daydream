/**
 * Animate a built world's characters and creatures: a 3D model and rig from each standing view, then sprite sheets
 * of every clip in eight directions (see anim/animator.ts). Actors with current sheets are skipped unless named.
 * Steps are kept in data/worlds/<id>/anim/<key>/, so a rerun continues, and `--redo=render` only re-renders (a new
 * clip, a new look); `--redo=clips`, `--redo=rig`, `--redo=mesh` go further back.
 *
 * The world file is backed up first (data/worlds/<id>/backup/<time>/).
 *
 * Usage: tsx src/cli/animate.ts <worldId> [keyPart ...] [--body=<key>:<humanoid|quadruped|floater>] [--redo=<step>] [--all]
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BodyPlan } from '@gd/shared';
import { loadWorld, saveWorld, worldDir } from '../storage';
import { actorSprites, animateWorld, bodyPlan } from '../anim/actors';
import { closeRenderer } from '../anim/render';
import type { AnimateOptions } from '../anim/animator';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [worldId, ...only] = args.filter((a) => !a.startsWith('--'));
if (!worldId) throw new Error('usage: animate <worldId> [keyPart ...] [--body=key:plan] [--redo=mesh|rig|clips|render] [--all]');
const w = loadWorld(worldId);
if (!w) throw new Error(`no world ${worldId}`);
const bodies: Record<string, BodyPlan> = {};
for (const f of flags.filter((f) => f.startsWith('--body='))) {
  const [k, b] = f.slice(7).split(':');
  bodies[k!] = b as BodyPlan;
}
const redo = flags.find((f) => f.startsWith('--redo='))?.slice(7) as AnimateOptions['redoFrom'];

const backup = path.join(worldDir(worldId), 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup, { recursive: true });
fs.copyFileSync(path.join(worldDir(worldId), 'world.json'), path.join(backup, 'world.json'));
console.log(`backed up to ${backup}`);
for (const a of actorSprites(w)) if (!only.length || only.some((o) => a.key.includes(o))) console.log(`  ${a.key}: ${bodies[a.key] ?? bodyPlan(a)}${a.anim ? ' (has sheets)' : ''}`);

const t0 = Date.now();
const res = await animateWorld(w, {
  only: only.length ? (k) => only.some((o) => k.includes(o)) : undefined,
  all: flags.includes('--all') || only.length > 0,
  bodies,
  redoFrom: redo,
  onStep: (m) => console.log(`    ${m}`),
  onActor: (key, ok, msg) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${key}: ${msg} (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (ok) saveWorld(w);
  },
});
await closeRenderer();
console.log(`${res.done} animated, ${res.failed} failed`);
process.exit(res.failed ? 1 : 0);
