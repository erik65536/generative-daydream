/** File-based persistence for users, sessions, worlds and instances (atomic JSON writes). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { InstanceState, WorldDefinition } from '@gd/shared';
import { DATA_DIR } from './paths';

const dirs = {
  worlds: path.join(DATA_DIR, 'worlds'),
  instances: path.join(DATA_DIR, 'instances'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

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

// ------------------------------------------------------------------------------------ users

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
  isAdmin: boolean;
}

const usersFile = path.join(DATA_DIR, 'users.json');
const sessionsFile = path.join(DATA_DIR, 'sessions.json');
let users: Record<string, User> = readJson(usersFile) ?? {};
let sessions: Record<string, { userId: string; expires: number }> = readJson(sessionsFile) ?? {};

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function createUser(username: string, password: string): User {
  const name = username.trim();
  if (!/^[\w .-]{3,24}$/.test(name)) throw new Error('Username must be 3-24 letters, numbers, spaces, dots or dashes.');
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');
  if (Object.values(users).some((u) => u.username.toLowerCase() === name.toLowerCase())) throw new Error('That username is taken.');
  const salt = crypto.randomBytes(16).toString('hex');
  const user: User = {
    id: `u_${crypto.randomBytes(6).toString('hex')}`,
    username: name,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: Date.now(),
    isAdmin: Object.keys(users).length === 0,
  };
  users[user.id] = user;
  writeJsonAtomic(usersFile, users);
  return user;
}

export function verifyUser(username: string, password: string): User | null {
  const u = Object.values(users).find((x) => x.username.toLowerCase() === username.trim().toLowerCase());
  if (!u) return null;
  const h = hashPassword(password, u.salt);
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.passwordHash, 'hex')) ? u : null;
}

export function getUser(id: string): User | undefined {
  return users[id];
}

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, expires: Date.now() + 30 * 24 * 3600_000 };
  writeJsonAtomic(sessionsFile, sessions);
  return token;
}

export function sessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const s = sessions[token];
  if (!s || s.expires < Date.now()) return null;
  return users[s.userId] ?? null;
}

export function deleteSession(token: string) {
  delete sessions[token];
  writeJsonAtomic(sessionsFile, sessions);
}

/** For tests. */
export function _resetAuth() {
  users = {};
  sessions = {};
}

// ------------------------------------------------------------------------------------ worlds

export function worldDir(id: string) {
  return path.join(dirs.worlds, id);
}
export function worldAssetDir(id: string) {
  return path.join(worldDir(id), 'assets');
}

const worldCache = new Map<string, WorldDefinition>();

export function saveWorld(w: WorldDefinition) {
  w.updatedAt = Date.now();
  worldCache.set(w.id, w);
  writeJsonAtomic(path.join(worldDir(w.id), 'world.json'), w);
}

export function loadWorld(id: string): WorldDefinition | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const c = worldCache.get(id);
  if (c) return c;
  const w = readJson<WorldDefinition>(path.join(worldDir(id), 'world.json'));
  if (w) worldCache.set(id, w);
  return w;
}

export function listWorlds(): WorldDefinition[] {
  const out: WorldDefinition[] = [];
  for (const id of fs.readdirSync(dirs.worlds)) {
    const w = loadWorld(id);
    if (w) out.push(w);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteWorld(id: string) {
  worldCache.delete(id);
  fs.rmSync(worldDir(id), { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------ instances

const instFile = (id: string) => path.join(dirs.instances, `${id}.json`);

export function saveInstance(s: InstanceState) {
  s.updatedAt = Date.now();
  writeJsonAtomic(instFile(s.id), s);
}

export function loadInstance(id: string): InstanceState | null {
  if (!/^[\w-]+$/.test(id)) return null;
  return readJson<InstanceState>(instFile(id));
}

export function listInstances(worldId?: string): InstanceState[] {
  const out: InstanceState[] = [];
  for (const f of fs.readdirSync(dirs.instances)) {
    if (!f.endsWith('.json')) continue;
    const s = readJson<InstanceState>(path.join(dirs.instances, f));
    if (s && (!worldId || s.worldId === worldId)) out.push(s);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteInstance(id: string) {
  fs.rmSync(instFile(id), { force: true });
}
