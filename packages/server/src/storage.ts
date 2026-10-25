/**
 * Persistence, chosen per kind of data:
 *
 *   data/gd.sqlite                 global SQLite (WAL): users, sessions, and a catalog of worlds and instances,
 *                                  shared by the server and CLI tools
 *   data/worlds/<id>/world.json    one per world: written during generation, then read whole — plain JSON, so it
 *                                  can be inspected, hand-edited and copied; its generated art sits in the same folder
 *   data/instances/<id>.sqlite     one per instance (save): state split into sections so an autosave writes only
 *                                  what changed, transactionally (see instancestore.ts)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { InstanceState, WorldDefinition } from '@gd/shared';
import { DATA_DIR } from './paths';
import { InstanceFile } from './instancestore';

const worldsDir = path.join(DATA_DIR, 'worlds');
const instancesDir = path.join(DATA_DIR, 'instances');
const trashDir = path.join(DATA_DIR, 'trash');
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

// ------------------------------------------------------------------------------------ global database

const db = new DatabaseSync(path.join(DATA_DIR, 'gd.sqlite'), { timeout: 10_000 });
// Busy timeout first, so several processes (server, CLI, test workers) can open the database at once.
db.exec('PRAGMA busy_timeout = 10000');
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  -- Accounts (see "users" below): invited with a code, then active once they have a user name and a password or a passkey.
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT, salt TEXT,
    created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, invite_code TEXT UNIQUE, invite_expires INTEGER,
    monthly_budget_usd REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
    transports TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
  -- Spending on paid models, per user and day.
  CREATE TABLE IF NOT EXISTS spend (user_id TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
  CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL, public INTEGER NOT NULL, title TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY, world_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, snapshot_of TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS instances_world ON instances (world_id, updated_at DESC);
`);

/** The shared database (jobs and the GPU page's process reports live here too, so every process sees them). */
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

const q = {
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

/**
 * An account's life: an administrator makes it "invited" with an invite code and a name saying who it is for; the
 * user follows the invite link, picks their user name and chooses a password, a passkey or both, which makes it
 * "active"; an administrator can disable it, or reset it to "invited" again with a new code (its password and passkeys
 * are gone; its user name, worlds and saves stay: a user name never changes once chosen).
 */
export type UserStatus = 'invited' | 'active' | 'disabled';

export interface User {
  id: string;
  /** The sign-in name the user chose when setting the account up (case-insensitive, never changes); null until then. */
  username: string | null;
  /** What other players see; the user can change it. */
  displayName: string;
  passwordHash: string | null;
  salt: string | null;
  createdAt: number;
  isAdmin: boolean;
  status: UserStatus;
  /** While invited: the code in the invite link, and when it stops working. */
  inviteCode: string | null;
  inviteExpires: number | null;
  /** What this user may spend on paid models in a calendar month (dollars). */
  monthlyBudgetUsd: number;
}

interface UserRow {
  id: string;
  username: string | null;
  display_name: string;
  password_hash: string | null;
  salt: string | null;
  created_at: number;
  is_admin: number;
  status: UserStatus;
  invite_code: string | null;
  invite_expires: number | null;
  monthly_budget_usd: number;
}

export interface Passkey {
  /** The credential id (base64url). */
  id: string;
  userId: string;
  name: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  name: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  created_at: number;
  last_used_at: number | null;
}

/** A new account's monthly budget unless the administrator sets another. */
export const DEFAULT_MONTHLY_BUDGET = 10;
/** How long an invite link works. */
export const INVITE_DAYS = 5;
export const MIN_PASSWORD = 8;

const uq = {
  insert: db.prepare('INSERT INTO users (id, display_name, created_at, is_admin, status, invite_code, invite_expires, monthly_budget_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  setUsername: db.prepare('UPDATE users SET username = ? WHERE id = ? AND username IS NULL'),
  all: db.prepare('SELECT * FROM users ORDER BY created_at'),
  byName: db.prepare('SELECT * FROM users WHERE username = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byInvite: db.prepare('SELECT * FROM users WHERE invite_code = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM users'),
  activeAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active'"),
  setPassword: db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?'),
  setStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
  setInvite: db.prepare("UPDATE users SET status = 'invited', invite_code = ?, invite_expires = ?, password_hash = NULL, salt = NULL WHERE id = ?"),
  activate: db.prepare("UPDATE users SET status = 'active', invite_code = NULL, invite_expires = NULL WHERE id = ?"),
  setName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
  setBudget: db.prepare('UPDATE users SET monthly_budget_usd = ? WHERE id = ?'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  signOut: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?'),
  passkeys: db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at'),
  passkey: db.prepare('SELECT * FROM passkeys WHERE id = ?'),
  addPasskey: db.prepare('INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  usePasskey: db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?'),
  removePasskey: db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?'),
  removePasskeys: db.prepare('DELETE FROM passkeys WHERE user_id = ?'),
};

const toUser = (r: UserRow | undefined): User | undefined =>
  r && {
    id: r.id, username: r.username, displayName: r.display_name, passwordHash: r.password_hash, salt: r.salt, createdAt: r.created_at, isAdmin: !!r.is_admin,
    status: r.status, inviteCode: r.invite_code, inviteExpires: r.invite_expires, monthlyBudgetUsd: r.monthly_budget_usd,
  };

const toPasskey = (r: PasskeyRow | undefined): Passkey | undefined =>
  r && { id: r.id, userId: r.user_id, name: r.name, publicKey: new Uint8Array(r.public_key), counter: r.counter, transports: JSON.parse(r.transports || '[]') as string[], createdAt: r.created_at, lastUsedAt: r.last_used_at };

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** An invite code: 12 characters in three groups, no look-alike characters (about 60 bits). */
function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const c = Array.from({ length: 12 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

/** A user name that is well formed and free (checked again when it is taken). */
export function validUsername(username: string): string {
  const name = username.trim();
  if (!/^[\w.-]{3,24}$/.test(name)) throw new Error('User names are 3-24 letters, numbers, dots, dashes or underscores.');
  if (uq.byName.get(name)) throw new Error('That user name is taken. Choose another.');
  return name;
}

function validDisplayName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (n.length < 1 || n.length > 32) throw new Error('Names are 1-32 characters.');
  return n;
}

function validPassword(password: string) {
  if (password.length < MIN_PASSWORD) throw new Error(`Choose a password of at least ${MIN_PASSWORD} characters.`);
  if (password.length > 200) throw new Error('That password is too long.');
}

function requireUser(id: string): User {
  const u = getUser(id);
  if (!u) throw new Error('No such user.');
  return u;
}

const activeAdmins = () => (uq.activeAdmins.get() as { n: number }).n;
/** The last active administrator cannot be disabled, reset or demoted. */
function keepAnAdmin(u: User) {
  if (u.isAdmin && u.status === 'active' && activeAdmins() <= 1) throw new Error('The server needs at least one active administrator.');
}

/** An administrator makes an account: invited, with a name saying who it is for and a code for its invite link. */
export function createUser(o: { displayName: string; isAdmin?: boolean; monthlyBudgetUsd?: number }): User {
  const displayName = validDisplayName(o.displayName);
  const id = `u_${crypto.randomBytes(6).toString('hex')}`;
  uq.insert.run(id, displayName, Date.now(), o.isAdmin ? 1 : 0, 'invited', inviteCode(), Date.now() + INVITE_DAYS * 86400_000, Math.max(0, o.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET));
  return getUser(id)!;
}

/**
 * Invited again with a new code (an account not set up yet gets a fresh link; an administrator resetting one ends
 * its password and passkeys and signs it out everywhere). Its worlds and saves stay.
 */
export function resetUser(userId: string): User {
  return tx(() => {
    keepAnAdmin(requireUser(userId));
    uq.setInvite.run(inviteCode(), Date.now() + INVITE_DAYS * 86400_000, userId);
    uq.removePasskeys.run(userId);
    uq.signOut.run(userId, '');
    return getUser(userId)!;
  });
}

/** The account an invite code is for, while the code still works. */
export function userByInvite(code: string): User | undefined {
  const u = toUser(uq.byInvite.get(code.trim().toUpperCase()) as UserRow | undefined);
  return u && u.status === 'invited' && (u.inviteExpires ?? 0) > Date.now() ? u : undefined;
}

/**
 * Setting up from an invite: the user name (only when the account has none yet: it never changes once chosen) and
 * the name others see. Done before the first way to sign in is stored, so a taken name stops it cleanly.
 */
export function claimInvite(userId: string, o: { username?: string; displayName?: string }) {
  tx(() => {
    const u = requireUser(userId);
    if (!u.username) {
      if (!o.username) throw new Error('Choose a user name.');
      uq.setUsername.run(validUsername(o.username), userId);
    }
    if (o.displayName !== undefined) uq.setName.run(validDisplayName(o.displayName), userId);
  });
}

/** The account's first way to sign in is set: it becomes active and the invite code is spent. */
export function activateUser(userId: string) {
  uq.activate.run(userId);
}

export function setEnabled(userId: string, enabled: boolean) {
  tx(() => {
    const u = requireUser(userId);
    if (u.status === 'invited') throw new Error('This account has not been set up yet.');
    if (!enabled) keepAnAdmin(u);
    uq.setStatus.run(enabled ? 'active' : 'disabled', userId);
    if (!enabled) uq.signOut.run(userId, '');
  });
}

export function setDisplayName(userId: string, name: string) {
  requireUser(userId);
  uq.setName.run(validDisplayName(name), userId);
}

export function setMonthlyBudget(userId: string, usd: number) {
  requireUser(userId);
  uq.setBudget.run(Math.max(0, usd), userId);
}

export function setAdmin(userId: string, isAdmin: boolean): void {
  tx(() => {
    const u = requireUser(userId);
    if (!isAdmin) keepAnAdmin(u);
    uq.setAdmin.run(isAdmin ? 1 : 0, userId);
  });
}

/** The user's password, when they have one (the same cost whether or not they do). */
export function checkPassword(u: User, password: string): boolean {
  if (!u.passwordHash || !u.salt) {
    hashPassword(password, 'timing');
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, u.salt), 'hex'), Buffer.from(u.passwordHash, 'hex'));
}

/** Sign in with a user name and password: active accounts that have a password. */
export function verifyUser(username: string, password: string): User | null {
  const u = findUser(username);
  if (!u) {
    hashPassword(password, 'timing');
    return null;
  }
  return checkPassword(u, password) && u.status === 'active' ? u : null;
}

/** Set (or replace) a password. The user's other sessions are signed out. */
export function setPassword(userId: string, password: string, keepToken = '') {
  validPassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  uq.setPassword.run(hashPassword(password, salt), salt, userId);
  uq.signOut.run(userId, keepToken);
}

/** Remove the password: only for someone who signs in with a passkey. */
export function clearPassword(userId: string) {
  if (!listPasskeys(userId).length) throw new Error('Add a passkey before removing your password, or you could not sign in.');
  uq.setPassword.run(null, null, userId);
}

export function listPasskeys(userId: string): Passkey[] {
  return (uq.passkeys.all(userId) as unknown as PasskeyRow[]).map((r) => toPasskey(r)!);
}

export function getPasskey(id: string): Passkey | undefined {
  return toPasskey(uq.passkey.get(id) as PasskeyRow | undefined);
}

export function addPasskey(p: Omit<Passkey, 'createdAt' | 'lastUsedAt'>) {
  const name = p.name.trim().slice(0, 40) || 'Passkey';
  uq.addPasskey.run(p.id, p.userId, name, p.publicKey, p.counter, JSON.stringify(p.transports), Date.now());
}

export function passkeyUsed(id: string, counter: number) {
  uq.usePasskey.run(counter, Date.now(), id);
}

/**
 * Remove a passkey. A user removing their own (`own`) keeps a way to sign in; an administrator may remove the last
 * one (the account then needs its password, or a reset).
 */
export function removePasskey(userId: string, passkeyId: string, own: boolean) {
  const u = requireUser(userId);
  if (own && !u.passwordHash && listPasskeys(userId).length <= 1) throw new Error('This is your only way to sign in: set a password or add another passkey first.');
  uq.removePasskey.run(passkeyId, userId);
}

export function listUsers(): User[] {
  return (uq.all.all() as unknown as UserRow[]).map((r) => toUser(r)!);
}

export function getUser(id: string): User | undefined {
  return toUser(uq.byId.get(id) as UserRow | undefined);
}

export function findUser(username: string): User | undefined {
  return toUser(uq.byName.get(username.trim()) as UserRow | undefined);
}

/** A server without accounts gets an administrator, invited: its invite code is returned once. */
export function ensureAdmin(): string | null {
  if ((uq.count.get() as { n: number }).n > 0) return null;
  return createUser({ displayName: 'Administrator', isAdmin: true }).inviteCode;
}

// ------------------------------------------------------------------------------------ spending

/** Today's date (server local time), the spending ledger's key. */
export const spendDay = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The first day of this calendar month: budgets start again then. */
export const monthStart = (t = Date.now()) => `${spendDay(t).slice(0, 7)}-01`;

const sq = {
  add: db.prepare('INSERT INTO spend (user_id, day, usd, calls) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1'),
  since: db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(calls), 0) AS calls FROM spend WHERE user_id = ? AND day >= ?'),
  total: db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM spend WHERE day = ?'),
  range: db.prepare('SELECT user_id, SUM(usd) AS usd, SUM(calls) AS calls FROM spend WHERE day >= ? GROUP BY user_id'),
};

export function recordSpend(userId: string, usd: number) {
  sq.add.run(userId, spendDay(), usd);
}

/** What a user has spent this calendar month. */
export function spentThisMonth(userId: string): { usd: number; calls: number } {
  return sq.since.get(userId, monthStart()) as { usd: number; calls: number };
}

export const spentTodayTotal = () => (sq.total.get(spendDay()) as { usd: number }).usd;

/** Spend per user since a day (inclusive), for the admin view. */
export function spendSince(day: string): Record<string, { usd: number; calls: number }> {
  return Object.fromEntries((sq.range.all(day) as { user_id: string; usd: number; calls: number }[]).map((r) => [r.user_id, { usd: r.usd, calls: r.calls }]));
}

// ------------------------------------------------------------------------------------ sessions

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  q.expireSessions.run(Date.now());
  q.insertSession.run(token, userId, Date.now() + 30 * 24 * 3600_000);
  return token;
}

/** The signed-in user of a session: only an active account. */
export function sessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const s = q.session.get(token) as { user_id: string; expires: number } | undefined;
  if (!s || s.expires < Date.now()) return null;
  const u = getUser(s.user_id);
  return u && u.status === 'active' ? u : null;
}

export function deleteSession(token: string) {
  q.deleteSession.run(token);
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
  worldCache.set(id, { stamp, world });
  return world;
}

export function listWorlds(): WorldDefinition[] {
  adoptWorldFolders();
  return (q.worldIds.all() as { id: string }[]).map((r) => loadWorld(r.id)).filter((w): w is WorldDefinition => !!w);
}

// ------------------------------------------------------------------------------------ trash

/** How long a deleted world waits in the trash before it is removed for good. */
export const TRASH_DAYS = 30;

/** A deleted world in data/trash/<id>/: its folder (world/), its saves (instances/) and this record (trash.json). */
export interface TrashEntry {
  id: string;
  title: string;
  ownerId: string;
  ownerName: string;
  deletedAt: number;
  deletedBy: string;
  saves: number;
}

const trashEntryDir = (id: string) => path.join(trashDir, id);

/** Rename, or copy and remove when a rename is refused (another drive; on Windows, a file someone has open). */
function movePath(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Delete a world: it and its saves move to the trash, where an administrator can restore them for TRASH_DAYS days. */
export function deleteWorld(id: string, deletedBy = '') {
  const w = loadWorld(id);
  worldCache.delete(id);
  const entry = trashEntryDir(id);
  fs.rmSync(entry, { recursive: true, force: true });
  const saves = q.instanceIdsOfWorld.all(id) as { id: string }[];
  for (const r of saves) {
    q.deleteInstance.run(r.id);
    instanceFiles.get(r.id)?.close();
    instanceFiles.delete(r.id);
    if (fs.existsSync(instanceFile(r.id))) moveSqlite(instanceFile(r.id), path.join(entry, 'instances', `${r.id}.sqlite`));
  }
  q.deleteWorld.run(id);
  if (fs.existsSync(worldDir(id))) movePath(worldDir(id), path.join(entry, 'world'));
  const record: TrashEntry = { id, title: w?.concept.title ?? id, ownerId: w?.ownerId ?? '', ownerName: w?.ownerName ?? '', deletedAt: Date.now(), deletedBy, saves: saves.length };
  writeJsonAtomic(path.join(entry, 'trash.json'), record);
}

function moveSqlite(file: string, to: string) {
  for (const sfx of ['', '-wal', '-shm', '-journal']) if (fs.existsSync(file + sfx)) movePath(file + sfx, to + sfx);
}

/** Deleted worlds, most recently deleted first. */
export function listTrash(): TrashEntry[] {
  if (!fs.existsSync(trashDir)) return [];
  return fs
    .readdirSync(trashDir)
    .map((id) => readJson<TrashEntry>(path.join(trashEntryDir(id), 'trash.json')))
    .filter((e): e is TrashEntry => !!e)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Bring a deleted world and its saves back. */
export function restoreWorld(id: string): WorldDefinition {
  if (!/^[\w-]+$/.test(id)) throw new Error('Not in the trash.');
  const entry = trashEntryDir(id);
  if (!fs.existsSync(path.join(entry, 'trash.json'))) throw new Error('Not in the trash.');
  if (fs.existsSync(worldDir(id))) throw new Error('A daydream with this id already exists.');
  if (!fs.existsSync(path.join(entry, 'world'))) throw new Error('The deleted daydream has no files to restore.');
  movePath(path.join(entry, 'world'), worldDir(id));
  const w = readJson<WorldDefinition>(worldFile(id));
  if (!w) throw new Error('The deleted daydream could not be read.');
  catalogWorld(w);
  const saves = path.join(entry, 'instances');
  for (const name of fs.existsSync(saves) ? fs.readdirSync(saves) : []) {
    if (!name.endsWith('.sqlite')) continue;
    const sid = name.slice(0, -'.sqlite'.length);
    moveSqlite(path.join(saves, name), instanceFile(sid));
    const s = instanceDb(sid, false)?.load();
    if (s) catalogInstance(s);
  }
  fs.rmSync(entry, { recursive: true, force: true });
  return w;
}

/** Remove a deleted world for good. */
export function purgeTrashEntry(id: string) {
  if (!/^[\w-]+$/.test(id)) return;
  fs.rmSync(trashEntryDir(id), { recursive: true, force: true });
}

/** Remove worlds deleted more than TRASH_DAYS days ago; returns how many. */
export function purgeTrash(now = Date.now()): number {
  const old = listTrash().filter((e) => now - e.deletedAt > TRASH_DAYS * 86400_000);
  for (const e of old) purgeTrashEntry(e.id);
  return old.length;
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

/** World folders that appeared without a catalog entry (copied in from another machine). */
function adoptWorldFolders() {
  for (const id of fs.readdirSync(worldsDir)) {
    if (q.worldStamp.get(id) || !fs.existsSync(worldFile(id))) continue;
    const w = readJson<WorldDefinition>(worldFile(id));
    if (w && w.id === id) catalogWorld(w);
  }
}


adoptWorldFolders();
