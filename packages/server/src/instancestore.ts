/**
 * Instance (save) storage: one SQLite file per instance, holding the state split into sections.
 *
 * The parts of a save that keep growing over a campaign (journal, conversations, NPC memories, explored maps,
 * per-zone runtime) rarely change between autosaves, so each section is stored as its own row and a save
 * writes only the rows whose content changed, all in one transaction. Hard saves are a file copy.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { InstanceState, PlayerState } from '@gd/shared';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sections (key TEXT PRIMARY KEY, hash TEXT NOT NULL, data BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Split a state into independently stored sections. Keys are stable so unchanged sections are skipped. */
export function splitState(s: InstanceState): Map<string, unknown> {
  const out = new Map<string, unknown>();
  out.set('core', { ...s, players: Object.keys(s.players), npcs: Object.keys(s.npcs), zones: Object.keys(s.zones) });
  for (const [uid, p] of Object.entries(s.players)) {
    const { journal, conversations, explored, ...rest } = p;
    out.set(`player:${uid}`, { ...rest, conversations: Object.keys(conversations), explored: Object.keys(explored) });
    out.set(`journal:${uid}`, journal);
    for (const [npcId, turns] of Object.entries(conversations)) out.set(`conv:${uid}:${npcId}`, turns);
    for (const [zoneId, bits] of Object.entries(explored)) out.set(`explored:${uid}:${zoneId}`, bits);
  }
  for (const [id, n] of Object.entries(s.npcs)) out.set(`npc:${id}`, n);
  for (const [id, z] of Object.entries(s.zones)) out.set(`zone:${id}`, z);
  return out;
}

export function joinState(get: (key: string) => unknown): InstanceState | null {
  const core = get('core') as (Omit<InstanceState, 'players' | 'npcs' | 'zones'> & { players: string[]; npcs: string[]; zones: string[] }) | undefined;
  if (!core) return null;
  const players: InstanceState['players'] = {};
  for (const uid of core.players) {
    const p = get(`player:${uid}`) as (Omit<PlayerState, 'journal' | 'conversations' | 'explored'> & { conversations: string[]; explored: string[] }) | undefined;
    if (!p) continue;
    const conversations: PlayerState['conversations'] = {};
    for (const npcId of p.conversations) conversations[npcId] = (get(`conv:${uid}:${npcId}`) as PlayerState['conversations'][string]) ?? [];
    const explored: PlayerState['explored'] = {};
    for (const zoneId of p.explored) {
      const bits = get(`explored:${uid}:${zoneId}`) as string | undefined;
      if (bits !== undefined) explored[zoneId] = bits;
    }
    players[uid] = { ...p, journal: (get(`journal:${uid}`) as PlayerState['journal']) ?? [], conversations, explored };
  }
  const npcs: InstanceState['npcs'] = {};
  for (const id of core.npcs) {
    const n = get(`npc:${id}`) as InstanceState['npcs'][string] | undefined;
    if (n) npcs[id] = n;
  }
  const zones: InstanceState['zones'] = {};
  for (const id of core.zones) {
    const z = get(`zone:${id}`) as InstanceState['zones'][string] | undefined;
    if (z) zones[id] = z;
  }
  return { ...core, players, npcs, zones };
}

export class InstanceFile {
  private db: DatabaseSync;
  /** Hash of each stored section, so a save only writes what changed. */
  private hashes = new Map<string, string>();

  constructor(readonly file: string) {
    this.db = new DatabaseSync(file, { timeout: 10_000 });
    this.db.exec('PRAGMA busy_timeout = 10000');
    // Rollback journal (not WAL) keeps a save a single file; FULL sync makes each save durable.
    this.db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; ${SCHEMA}`);
    for (const r of this.db.prepare('SELECT key, hash FROM sections').all() as { key: string; hash: string }[]) this.hashes.set(r.key, r.hash);
  }

  /** Write changed sections and delete vanished ones in one transaction. Returns how many rows were written. */
  save(s: InstanceState): number {
    const sections = splitState(s);
    const upsert = this.db.prepare('INSERT INTO sections (key, hash, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, data = excluded.data');
    const del = this.db.prepare('DELETE FROM sections WHERE key = ?');
    const next = new Map<string, string>();
    let written = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of sections) {
        const json = JSON.stringify(value);
        const hash = crypto.createHash('sha1').update(json).digest('base64');
        next.set(key, hash);
        if (this.hashes.get(key) === hash) continue;
        upsert.run(key, hash, zlib.deflateSync(json, { level: 1 }));
        written++;
      }
      for (const key of this.hashes.keys()) if (!next.has(key)) del.run(key);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.hashes = next;
    return written;
  }

  load(): InstanceState | null {
    const rows = new Map<string, Uint8Array>();
    for (const r of this.db.prepare('SELECT key, data FROM sections').all() as { key: string; data: Uint8Array }[]) rows.set(r.key, r.data);
    return joinState((key) => {
      const b = rows.get(key);
      return b ? JSON.parse(zlib.inflateSync(b).toString('utf8')) : undefined;
    });
  }

  /** Consistent copy of the whole save into a new file (used for exports and backups). */
  copyTo(file: string) {
    fs.rmSync(file, { force: true });
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  close() {
    this.db.close();
  }
}
