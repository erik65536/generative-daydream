/**
 * Carry a world from one machine to another (development and production) as a single file, so a world built once
 * (hours of GPU) can be played elsewhere, and a world from production can be brought home to fix a bug in it.
 *
 *   tsx src/cli/worldpack.ts export <worldId> <file.gdpack> [--saves] [--rigs] [--draft]
 *   tsx src/cli/worldpack.ts import <file.gdpack> --owner <username> [--replace]
 *
 * A pack holds the world (world.json and its art) and, with --saves, its saves. --rigs adds the animation rigs (only
 * needed to animate again), --draft the build's intermediate steps (only needed to lay places out again).
 *
 * On import the world belongs to --owner. Saves keep their players: each is given to the account of the same name
 * here, or to the owner when there is none. A world or save already here is left alone unless --replace.
 *
 * The file is a gzipped tar made and read with the system's tar (Windows 10+, Linux, macOS); it is checked before
 * anything is copied in: only a world, its saves and a manifest, no links, no paths out of it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { InstanceState, WorldDefinition } from '@gd/shared';
import { findUser, getUser, listInstances, loadInstance, loadWorld, saveInstance, saveWorld, worldDir } from '../storage';

interface Manifest {
  format: 1;
  worldId: string;
  title: string;
  exportedAt: number;
  /** User ids found in the saves, and their account names (to find the same people on the other machine). */
  users: Record<string, string>;
  saves: string[];
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * Run tar inside `dir`, the archive streamed through a file Node opens: tar is never given a path, so a Windows
 * drive letter cannot be read as a remote host (as Git Bash's GNU tar does).
 */
function tar(mode: 'pack' | 'unpack', dir: string, file: string) {
  const fd = fs.openSync(file, mode === 'pack' ? 'w' : 'r');
  try {
    const r = spawnSync('tar', mode === 'pack' ? ['-cz', '.'] : ['-xz'], { cwd: dir, stdio: mode === 'pack' ? ['ignore', fd, 'inherit'] : [fd, 'inherit', 'inherit'] });
    if (r.error || r.status !== 0) throw new Error(`tar failed${r.error ? `: ${r.error.message}` : ''}`);
  } finally {
    fs.closeSync(fd);
  }
}

function exportWorld(worldId: string, out: string) {
  const w = loadWorld(worldId);
  if (!w) throw new Error(`No world "${worldId}".`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdpack-'));
  try {
    const src = worldDir(worldId), dst = path.join(tmp, 'world');
    fs.mkdirSync(dst);
    fs.copyFileSync(path.join(src, 'world.json'), path.join(dst, 'world.json'));
    for (const [dir, wanted] of [['assets', true], ['anim', flag('--rigs')], ['draft', flag('--draft')]] as const)
      if (wanted && fs.existsSync(path.join(src, dir))) fs.cpSync(path.join(src, dir), path.join(dst, dir), { recursive: true });
    const users: Record<string, string> = {};
    const saves: string[] = [];
    if (flag('--saves')) {
      fs.mkdirSync(path.join(tmp, 'saves'));
      for (const s of listInstances(worldId)) {
        fs.writeFileSync(path.join(tmp, 'saves', `${s.id}.json`), JSON.stringify(s));
        saves.push(s.id);
        for (const uid of [s.ownerId, ...Object.keys(s.players)]) users[uid] = getUser(uid)?.username ?? uid;
      }
    }
    const manifest: Manifest = { format: 1, worldId, title: w.concept.title, exportedAt: Date.now(), users, saves };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    tar('pack', tmp, out);
    console.log(`Packed "${w.concept.title}" (${worldId}) with ${saves.length} save(s) into ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB).`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every path under `root` (relative, with forward slashes); throws on a link or anything but files and folders. */
function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(root, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw new Error(`The pack holds something that is not a plain file: ${r}`);
    out.push(r);
    if (st.isDirectory()) out.push(...walk(root, r));
  }
  return out;
}

function importWorld(file: string) {
  const ownerName = option('--owner');
  const owner = ownerName ? findUser(ownerName) : undefined;
  if (!owner) throw new Error(`Name the account the world will belong to: --owner <username>${ownerName ? ` (no account "${ownerName}")` : ''}.`);
  const replace = flag('--replace');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdpack-'));
  try {
    tar('unpack', tmp, file);
    const allowed = /^(manifest\.json|world(\/(world\.json|(assets|anim|draft)(\/[\w.@-]+)*))?|saves(\/[\w-]+\.json)?)$/;
    for (const r of walk(tmp)) if (!allowed.test(r)) throw new Error(`Not a world pack (unexpected ${r}).`);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')) as Manifest;
    const w = JSON.parse(fs.readFileSync(path.join(tmp, 'world', 'world.json'), 'utf8')) as WorldDefinition;
    if (manifest.format !== 1 || !/^w_[a-z0-9]+$/i.test(w.id) || w.id !== manifest.worldId) throw new Error('Not a world pack (its manifest and world do not match).');

    const dest = worldDir(w.id);
    if (fs.existsSync(dest) && !replace) console.log(`"${w.concept.title}" (${w.id}) is already here: kept as it is (--replace to overwrite it).`);
    else {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(tmp, 'world'), dest, { recursive: true });
      w.ownerId = owner.id;
      w.ownerName = owner.displayName;
      saveWorld(w);
      console.log(`Added "${w.concept.title}" (${w.id}), owned by ${owner.username}.`);
    }

    // Each player in the saves becomes the account of the same name here, or the owner.
    const ids = new Map(Object.entries(manifest.users).map(([uid, name]) => [uid, findUser(name)?.id ?? owner.id]));
    for (const id of manifest.saves) {
      if (!/^[\w-]+$/.test(id)) continue;
      if (loadInstance(id) && !replace) {
        console.log(`Save ${id} is already here: kept as it is.`);
        continue;
      }
      let text = fs.readFileSync(path.join(tmp, 'saves', `${id}.json`), 'utf8');
      for (const [from, to] of ids) text = text.split(from).join(to);
      const s = JSON.parse(text) as InstanceState;
      if (s.id !== id || s.worldId !== w.id) throw new Error(`Save ${id} does not belong to this world.`);
      saveInstance(s);
      console.log(`Added save "${s.name}" (${id}) for ${[...new Set(Object.keys(s.players).map((u) => getUser(u)?.username ?? u))].join(', ')}.`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const [cmd, a, b] = args;
if (cmd === 'export' && a && b) exportWorld(a, b);
else if (cmd === 'import' && a) importWorld(a);
else console.log('usage: worldpack export <worldId> <file.gdpack> [--saves] [--rigs] [--draft] | import <file.gdpack> --owner <username> [--replace]');
