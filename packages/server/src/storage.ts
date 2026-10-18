/**
 * Persistence, chosen per kind of data:
 *
 *   data/gd.sqlite                 global SQLite (WAL): users, sessions, and a catalog of worlds and instances,
 *                                  shared by the server and CLI tools
 *   data/worlds/<id>/world.json    one per world: written during generation, then read whole — plain JSON, so it
 *                                  can be inspected, hand-edited and copied; its generated art sits in the same folder
 *   data/instances/<id>.sqlite     one per instance (save): state split into sections so an autosave writes only
 *                                  what changed, transactionally (see instancestore.ts)
 *
 * Older layouts (JSON files everywhere, or SQLite blobs) are migrated on start.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { InstanceState, WorldDefinition } from '@gd/shared';
import { DATA_DIR } from './paths';
import { InstanceFile } from './instancestore';

const SCHEMA_VERSION = 3;
const worldsDir = path.join(DATA_DIR, 'worlds');
const instancesDir = path.join(DATA_DIR, 'instances');
fs.mkdirSync(worldsDir, { recursive: true });
fs.mkdirSync(instancesDir, { recursive: true });

export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const unpack = <T>(b: Uint8Array): T => JSON.parse(zlib.inflateSync(b).toString('utf8')) as T;

// ------------------------------------------------------------------------------------ global database

const db = new DatabaseSync(path.join(DATA_DIR, 'gd.sqlite'), { timeout: 10_000 });
// Busy timeout first, so several processes (server, CLI, test workers) can open the database at once.
db.exec('PRAGMA busy_timeout = 10000');
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, salt TEXT NOT NULL,
    created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
`);
// Accounts made or reset by an administrator carry a one-time password the user must replace.
if (!(db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).some((c) => c.name === 'must_change_password'))
  db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');

/** The shared database (jobs and GPU leases live here too, so every process sees them). */
export const globalDb = () => db;

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ------------------------------------------------------------------------------------ files

const worldFile = (id: string) => path.join(worldsDir, id, 'world.json');
const instanceFile = (id: string) => path.join(instancesDir, `${id}.sqlite`);
const instanceFiles = new Map<string, InstanceFile>();

function instanceDb(id: string, create: boolean): InstanceFile | null {
  let f = instanceFiles.get(id);
  if (f) return f;
  if (!create && !fs.existsSync(instanceFile(id))) return null;
  f = new InstanceFile(instanceFile(id));
  instanceFiles.set(id, f);
  return f;
}

function removeSqlite(file: string) {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
}

// ------------------------------------------------------------------------------------ migrations

/** Earlier layouts stored worlds/instances as compressed blobs in SQLite; turn them into the current files. */
function migrateBlobs(writeWorld: (w: WorldDefinition) => void, writeInstance: (s: InstanceState) => void) {
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  // v1: blobs inside the global database.
  if (cols('worlds').includes('data')) {
    for (const r of db.prepare('SELECT data FROM worlds').all() as { data: Uint8Array }[]) writeWorld(unpack<WorldDefinition>(r.data));
    db.exec('DROP TABLE worlds');
  }
  if (cols('instances').includes('data')) {
    for (const r of db.prepare('SELECT data FROM instances').all() as { data: Uint8Array }[]) writeInstance(unpack<InstanceState>(r.data));
    db.exec('DROP TABLE instances');
  }
  // v2: world.sqlite per world, and a single-blob `state` table per instance.
  for (const id of fs.readdirSync(worldsDir)) {
    const f = path.join(worldsDir, id, 'world.sqlite');
    if (!fs.existsSync(f)) continue;
    const d = new DatabaseSync(f);
    const row = d.prepare("SELECT data FROM doc WHERE name = 'definition'").get() as { data: Uint8Array } | undefined;
    d.close();
    if (row) writeWorld(unpack<WorldDefinition>(row.data));
    removeSqlite(f);
  }
  for (const name of fs.readdirSync(instancesDir)) {
    if (!name.endsWith('.sqlite')) continue;
    const f = path.join(instancesDir, name);
    const d = new DatabaseSync(f);
    const hasState = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state'").get();
    const row = hasState ? (d.prepare('SELECT data FROM state WHERE id = 1').get() as { data: Uint8Array } | undefined) : undefined;
    if (hasState) d.exec('DROP TABLE state');
    d.close();
    if (row) writeInstance(unpack<InstanceState>(row.data));
  }
}

// ------------------------------------------------------------------------------------ catalog

const catalogSql = `
  CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL, public INTEGER NOT NULL, title TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY, world_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, snapshot_of TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS instances_world ON instances (world_id, updated_at DESC);
`;

// Blob migration needs the old tables, so it runs before the catalog is (re)created; writes are collected first.
const pendingWorlds: WorldDefinition[] = [];
const pendingInstances: InstanceState[] = [];
migrateBlobs((w) => pendingWorlds.push(w), (s) => pendingInstances.push(s));
db.exec(catalogSql);
db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema_version', String(SCHEMA_VERSION));

const q = {
  insertUser: db.prepare('INSERT INTO users (id, username, password_hash, salt, created_at, is_admin, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  setPassword: db.prepare('UPDATE users SET password_hash = ?, salt = ?, must_change_password = ? WHERE id = ?'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  allUsers: db.prepare('SELECT * FROM users ORDER BY created_at'),
  adminCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
  userSessionsDelete: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertSession: db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, expires) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT user_id, expires FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  expireSessions: db.prepare('DELETE FROM sessions WHERE expires < ?'),
  upsertWorld: db.prepare(`INSERT INTO worlds (id, owner_id, status, public, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, status = excluded.status, public = excluded.public, title = excluded.title, updated_at = excluded.updated_at`),
  worldStamp: db.prepare('SELECT updated_at FROM worlds WHERE id = ?'),
  worldIds: db.prepare('SELECT id FROM worlds ORDER BY updated_at DESC'),
  deleteWorld: db.prepare('DELETE FROM worlds WHERE id = ?'),
  upsertInstance: db.prepare(`INSERT INTO instances (id, world_id, owner_id, name, snapshot_of, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET world_id = excluded.world_id, owner_id = excluded.owner_id, name = excluded.name, snapshot_of = excluded.snapshot_of, updated_at = excluded.updated_at`),
  instanceIds: db.prepare('SELECT id FROM instances ORDER BY updated_at DESC'),
  instanceIdsOfWorld: db.prepare('SELECT id FROM instances WHERE world_id = ? ORDER BY updated_at DESC'),
  deleteInstance: db.prepare('DELETE FROM instances WHERE id = ?'),
};

const catalogWorld = (w: WorldDefinition) => q.upsertWorld.run(w.id, w.ownerId, w.status, w.public ? 1 : 0, w.concept.title, w.createdAt, w.updatedAt);
const catalogInstance = (s: InstanceState) => q.upsertInstance.run(s.id, s.worldId, s.ownerId, s.name, s.snapshotOf ?? null, s.createdAt, s.updatedAt);

// ------------------------------------------------------------------------------------ users

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
  isAdmin: boolean;
  /** Signed in with a password an administrator set: must choose a new one before doing anything else. */
  mustChangePassword: boolean;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  created_at: number;
  is_admin: number;
  must_change_password?: number;
}

const toUser = (r: UserRow | undefined): User | undefined =>
  r && { id: r.id, username: r.username, passwordHash: r.password_hash, salt: r.salt, createdAt: r.created_at, isAdmin: !!r.is_admin, mustChangePassword: !!r.must_change_password };

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function insertUser(u: User) {
  q.insertUser.run(u.id, u.username, u.passwordHash, u.salt, u.createdAt, u.isAdmin ? 1 : 0, u.mustChangePassword ? 1 : 0);
}

export const MIN_PASSWORD = 8;

/** A one-time password an administrator hands out (no look-alike characters). */
export function randomPassword(length = 14): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

function validUsername(username: string): string {
  const name = username.trim();
  if (!/^[\w.-]{3,24}$/.test(name)) throw new Error('User ids are 3-24 letters, numbers, dots, dashes or underscores.');
  return name;
}

/** Accounts are made by administrators: a one-time password the user replaces on first sign-in. */
export function inviteUser(username: string, isAdmin = false): { user: User; password: string } {
  const name = validUsername(username);
  const password = randomPassword();
  return tx(() => {
    if (q.userByName.get(name)) throw new Error('That user id is taken.');
    const salt = crypto.randomBytes(16).toString('hex');
    const user: User = { id: `u_${crypto.randomBytes(6).toString('hex')}`, username: name, salt, passwordHash: hashPassword(password, salt), createdAt: Date.now(), isAdmin, mustChangePassword: true };
    insertUser(user);
    return { user, password };
  });
}

export function verifyUser(username: string, password: string): User | null {
  const u = toUser(q.userByName.get(username.trim()) as UserRow | undefined);
  if (!u) {
    hashPassword(password, 'timing'); // same cost whether or not the account exists
    return null;
  }
  const h = hashPassword(password, u.salt);
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.passwordHash, 'hex')) ? u : null;
}

/** The user replaces their password (knowing the current one). Their other sessions are signed out. */
export function changePassword(userId: string, current: string, next: string, keepToken = ''): void {
  const u = getUser(userId);
  if (!u || !verifyUser(u.username, current)) throw new Error('Your current password is wrong.');
  if (next.length < MIN_PASSWORD) throw new Error(`Choose a password of at least ${MIN_PASSWORD} characters.`);
  if (next === current) throw new Error('Choose a password different from the current one.');
  const salt = crypto.randomBytes(16).toString('hex');
  q.setPassword.run(hashPassword(next, salt), salt, 0, userId);
  q.userSessionsDelete.run(userId, keepToken);
}

/** An administrator resets a password: a new one-time password, every session signed out. */
export function resetPassword(userId: string): string {
  if (!getUser(userId)) throw new Error('No such user.');
  const password = randomPassword();
  const salt = crypto.randomBytes(16).toString('hex');
  q.setPassword.run(hashPassword(password, salt), salt, 1, userId);
  q.userSessionsDelete.run(userId, '');
  return password;
}

export function setAdmin(userId: string, isAdmin: boolean): void {
  tx(() => {
    const u = getUser(userId);
    if (!u) throw new Error('No such user.');
    if (u.isAdmin && !isAdmin && (q.adminCount.get() as { n: number }).n <= 1) throw new Error('The server needs at least one administrator.');
    q.setAdmin.run(isAdmin ? 1 : 0, userId);
  });
}

export function listUsers(): User[] {
  return (q.allUsers.all() as unknown as UserRow[]).map((r) => toUser(r)!);
}

export function getUser(id: string): User | undefined {
  return toUser(q.userById.get(id) as UserRow | undefined);
}

export function findUser(username: string): User | undefined {
  return toUser(q.userByName.get(username.trim()) as UserRow | undefined);
}

/** A server without accounts gets an administrator "admin" with a one-time password (returned once). */
export function ensureAdmin(): string | null {
  if ((q.userCount.get() as { n: number }).n > 0) return null;
  return inviteUser('admin', true).password;
}

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  q.expireSessions.run(Date.now());
  q.insertSession.run(token, userId, Date.now() + 30 * 24 * 3600_000);
  return token;
}

export function sessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const s = q.session.get(token) as { user_id: string; expires: number } | undefined;
  if (!s || s.expires < Date.now()) return null;
  return getUser(s.user_id) ?? null;
}

export function deleteSession(token: string) {
  q.deleteSession.run(token);
}

/** For tests. */
export function _resetAuth() {
  db.exec('DELETE FROM sessions; DELETE FROM users;');
}

// ------------------------------------------------------------------------------------ worlds

export function worldDir(id: string) {
  return path.join(worldsDir, id);
}
export function worldAssetDir(id: string) {
  return path.join(worldDir(id), 'assets');
}

/** Parsed worlds, revalidated against the catalog's updated_at so writes from other processes are picked up. */
const worldCache = new Map<string, { stamp: number; world: WorldDefinition }>();

export function saveWorld(w: WorldDefinition) {
  w.updatedAt = Math.max(Date.now(), (worldCache.get(w.id)?.stamp ?? 0) + 1);
  writeJsonAtomic(worldFile(w.id), w);
  catalogWorld(w);
  worldCache.set(w.id, { stamp: w.updatedAt, world: w });
}

export function loadWorld(id: string): WorldDefinition | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const stamp = (q.worldStamp.get(id) as { updated_at: number } | undefined)?.updated_at;
  if (stamp === undefined) {
    worldCache.delete(id);
    return null;
  }
  const c = worldCache.get(id);
  if (c && c.stamp === stamp) return c.world;
  const world = readJson<WorldDefinition>(worldFile(id));
  if (!world) return null;
  // Rulesets compiled before armour affixes had proper names called them "<Mitigation>ed".
  world.ruleset?.affixes.forEach((a, i) => {
    if (a.stat.startsWith('mit:') && / of /.test(a.suffix) && a.prefix === `${a.suffix.replace(/^of /, '')}ed`) a.prefix = ['Reinforced', 'Hardened', 'Warded', 'Braced', 'Tempered'][i % 5]!;
  });
  worldCache.set(id, { stamp, world });
  return world;
}

export function listWorlds(): WorldDefinition[] {
  adoptWorldFolders();
  return (q.worldIds.all() as { id: string }[]).map((r) => loadWorld(r.id)).filter((w): w is WorldDefinition => !!w);
}

export function deleteWorld(id: string) {
  worldCache.delete(id);
  for (const r of q.instanceIdsOfWorld.all(id) as { id: string }[]) deleteInstance(r.id);
  q.deleteWorld.run(id);
  fs.rmSync(worldDir(id), { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------ instances

export function saveInstance(s: InstanceState) {
  s.updatedAt = Date.now();
  instanceDb(s.id, true)!.save(s);
  catalogInstance(s);
}

export function loadInstance(id: string): InstanceState | null {
  if (!/^[\w-]+$/.test(id)) return null;
  return instanceDb(id, false)?.load() ?? null;
}

export function listInstances(worldId?: string): InstanceState[] {
  const ids = (worldId ? q.instanceIdsOfWorld.all(worldId) : q.instanceIds.all()) as { id: string }[];
  return ids.map((r) => loadInstance(r.id)).filter((s): s is InstanceState => !!s);
}

export function deleteInstance(id: string) {
  q.deleteInstance.run(id);
  instanceFiles.get(id)?.close();
  instanceFiles.delete(id);
  removeSqlite(instanceFile(id));
}

// ------------------------------------------------------------------------------------ startup: migrate and adopt

function importLegacyJson() {
  const legacy = path.join(DATA_DIR, 'legacy-json');
  const moveAside = (file: string) => {
    const dest = path.join(legacy, path.relative(DATA_DIR, file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
  };
  let n = 0;
  const usersFile = path.join(DATA_DIR, 'users.json');
  const sessionsFile = path.join(DATA_DIR, 'sessions.json');
  for (const u of Object.values(readJson<Record<string, User>>(usersFile) ?? {}))
    if (!q.userById.get(u.id) && !q.userByName.get(u.username)) {
      insertUser(u);
      n++;
    }
  for (const [token, s] of Object.entries(readJson<Record<string, { userId: string; expires: number }>>(sessionsFile) ?? {}))
    if (s.expires > Date.now()) q.insertSession.run(token, s.userId, s.expires);
  for (const f of [usersFile, sessionsFile]) if (fs.existsSync(f)) moveAside(f);
  for (const f of fs.readdirSync(instancesDir)) {
    if (!f.endsWith('.json')) continue;
    const s = readJson<InstanceState>(path.join(instancesDir, f));
    if (s) pendingInstances.push(s);
    moveAside(path.join(instancesDir, f));
  }
  if (n) console.log(`[storage] imported ${n} users from JSON files (originals in ${legacy})`);
}

/** Bring the catalog in line with the files: migrated records, and world folders copied in or written elsewhere. */
function adopt() {
  for (const w of pendingWorlds) {
    writeJsonAtomic(worldFile(w.id), w);
    catalogWorld(w);
  }
  for (const s of pendingInstances) {
    instanceDb(s.id, true)!.save(s);
    catalogInstance(s);
  }
  for (const id of fs.readdirSync(worldsDir)) {
    if (!fs.existsSync(worldFile(id))) continue;
    const stamp = (q.worldStamp.get(id) as { updated_at: number } | undefined)?.updated_at;
    const w = readJson<WorldDefinition>(worldFile(id));
    if (w && (stamp === undefined || w.updatedAt > stamp)) catalogWorld(w);
  }
}

/** World folders that appeared without a catalog entry (copied in, or written by an older process). */
function adoptWorldFolders() {
  for (const id of fs.readdirSync(worldsDir)) {
    if (q.worldStamp.get(id) || !fs.existsSync(worldFile(id))) continue;
    const w = readJson<WorldDefinition>(worldFile(id));
    if (w && w.id === id) catalogWorld(w);
  }
}

importLegacyJson();
adopt();
