/** Thin REST client. */

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  // The account's one-time password must be replaced first: the app shows that screen on reload.
  if (res.status === 403 && data.code === 'password_change_required') location.reload();
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export interface Me {
  id: string;
  username: string;
  isAdmin: boolean;
  /** Signed in with a one-time password: must choose a new one first. */
  mustChangePassword: boolean;
}

export interface UserRow extends Me {
  createdAt: number;
}

export interface WorldSummary {
  id: string;
  title: string;
  pitch: string;
  genre: string;
  ownerId: string;
  ownerName: string;
  public: boolean;
  status: 'generating' | 'ready' | 'failed';
  createdAt: number;
  input: { size: string; length: string; combatMode: string; communication: number; art: string; difficulty: import('@gd/shared').DifficultyId };
  rules?: { name: string; classes: string[]; balance?: { at: number; ok: number; total: number; durationMs: number } };
  zones: number;
  npcs: number;
  quests: number;
  palette: { primary: string; secondary: string; accent: string; ui: string };
  cover?: string;
  artProgress: { ok: number; total: number };
  job?: { status: string; progress: number; step: string; error?: string; queuePosition?: number };
}

/** A job is active while queued, running, or waiting for a model. */
export const jobActive = (status?: string) => status === 'queued' || status === 'running' || status === 'waiting';

export interface JobStatus {
  status: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'unknown' | 'ready' | 'generating';
  /** Jobs ahead of this one in the queue. */
  queuePosition?: number;
  progress: number;
  step: string;
  error?: string;
  log: { t: number; msg: string; kind: 'step' | 'info' | 'warn' | 'error' | 'preview' }[];
  preview: { title?: string; pitch?: string; zones?: string[]; npcs?: string[]; arcs?: string[] };
  /** The job's stages: what is done, what is happening now, and what comes next. */
  phases?: JobPhase[];
}

export interface JobPhase {
  id: string;
  label: string;
  detail: string;
  status: 'pending' | 'active' | 'done' | 'skipped';
  done?: number;
  total?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface WorldSetup {
  id: string;
  concept: { title: string; pitch: string; tone: string; playerRole: string; genre: string; palette: WorldSummary['palette'] };
  ruleset: import('@gd/shared').Ruleset;
  combatMode: 'solo' | 'party_manual' | 'party_npc';
  difficulty: import('@gd/shared').DifficultyId;
  /** Look of each class (id = class id). */
  origins: { id: string; name: string; description: string; appearance: string; asset?: string; assets?: Partial<Record<'feminine' | 'masculine' | 'androgynous', string>> }[];
  assets: Record<string, string>;
}

/** One image the world uses, with the brief derived from the world and the one in use. */
export interface ArtEntry {
  key: string;
  kind: 'texture' | 'sprite' | 'object' | 'icon' | 'portrait';
  brief: string;
  defaultBrief: string;
  ref?: string;
  variant?: string;
  stale: boolean;
}

export interface StudioView {
  world: Omit<import('@gd/shared').WorldDefinition, 'generationLog' | 'rulesIntent'>;
  art: ArtEntry[];
  busy: boolean;
}

export type StudioEdit =
  | { type: 'zone'; id: string; name?: string; description?: string; lore?: string }
  | { type: 'npc'; id: string; name?: string; title?: string; personality?: string; appearance?: string; backstory?: string; voice?: string; greeting?: string }
  | { type: 'quest'; id: string; title?: string; summary?: string; completionText?: string; objectives?: { id: string; description: string }[] }
  | { type: 'role'; tilesetId: string; role: string; name?: string; prompt?: string }
  | { type: 'art'; key: string; brief?: string | null; imagePrompt?: string | null };

export type StudioTask =
  | { kind: 'rewrite'; target: { type: 'npc' | 'quest' | 'zone'; id: string }; guidance: string }
  | { kind: 'direct'; tilesetIds: string[]; guidance: string }
  | { kind: 'paint'; keys: string[]; reroll?: boolean }
  | { kind: 'zone'; zoneId: string; plan?: import('@gd/shared').ZoneLayoutPlan; content: boolean; guidance: string };

export type CharSpec = Omit<import('@gd/shared').CharacterSpec, 'sprite'>;

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  login: (username: string, password: string) => call<Me>('POST', '/api/auth/login', { username, password }),
  changePassword: (current: string, next: string) => call<Me>('POST', '/api/auth/password', { current, next }),
  users: () => call<UserRow[]>('GET', '/api/admin/users'),
  inviteUser: (username: string, isAdmin: boolean) => call<{ user: UserRow; password: string }>('POST', '/api/admin/users', { username, isAdmin }),
  resetUser: (id: string) => call<{ password: string }>('POST', `/api/admin/users/${id}/reset`, {}),
  setUserAdmin: (id: string, isAdmin: boolean) => call<UserRow>('PATCH', `/api/admin/users/${id}`, { isAdmin }),
  logout: () => call<{ ok: true }>('POST', '/api/auth/logout', {}),
  worlds: () => call<WorldSummary[]>('GET', '/api/worlds'),
  world: (id: string) => call<WorldSummary>('GET', `/api/worlds/${id}`),
  createWorld: (input: unknown) => call<{ worldId: string }>('POST', '/api/worlds', input),
  deleteWorld: (id: string) => call<{ ok: true }>('DELETE', `/api/worlds/${id}`),
  job: (id: string, since = 0) => call<JobStatus>('GET', `/api/worlds/${id}/job?since=${since}`),
  cancelJob: (id: string) => call<{ ok: true }>('POST', `/api/worlds/${id}/cancel`, {}),
  regenArt: (id: string, level: 'essential' | 'full', retryFailed = false) => call<{ ok: true }>('POST', `/api/worlds/${id}/art`, { level, retryFailed }),
  setup: (id: string) => call<WorldSetup>('GET', `/api/worlds/${id}/setup`),
  instances: (worldId: string) => call<import('@gd/shared').InstanceSummary[]>('GET', `/api/worlds/${worldId}/instances`),
  createInstance: (worldId: string, name: string, party: CharSpec[], difficulty?: import('@gd/shared').DifficultyId) => call<{ instanceId: string }>('POST', `/api/worlds/${worldId}/instances`, { name, party, difficulty }),
  rules: (id: string) => call<{ ruleset: import('@gd/shared').Ruleset | null; canRebalance: boolean }>('GET', `/api/worlds/${id}/rules`),
  regenRules: (id: string, mode: 'regenerate' | 'rebalance') => call<{ ok: true; mode: string }>('POST', `/api/worlds/${id}/rules`, { mode }),
  instance: (id: string) => call<import('@gd/shared').InstanceSummary & { hasCharacter: boolean }>('GET', `/api/instances/${id}`),
  joinInstance: (id: string, party: CharSpec[]) => call<{ ok: true }>('POST', `/api/instances/${id}/join`, { party }),
  deleteInstance: (id: string) => call<{ ok: true }>('DELETE', `/api/instances/${id}`),
  studio: (id: string) => call<StudioView>('GET', `/api/worlds/${id}/studio`),
  studioEdit: (id: string, edits: StudioEdit | StudioEdit[]) => call<StudioView>('POST', `/api/worlds/${id}/studio/edit`, edits),
  studioTask: (id: string, task: StudioTask) => call<{ ok: true }>('POST', `/api/worlds/${id}/studio/task`, task),
  genai: () => call<{ purposes: { purpose: string; provider: string; type: string; model?: string; gpu?: string }[]; recent: { at: number; purpose: string; provider: string; ms: number; ok: boolean; error?: string; attempt: number; preview?: string }[]; gpu: { group: string; resident: string | null; switches: number }[]; configFile: string | null }>('GET', '/api/genai'),
  genaiRelease: () => call<{ gpu: { group: string; resident: string | null; switches: number }[] }>('POST', '/api/genai/release'),
  genaiReload: () => call<unknown>('POST', '/api/genai/reload', {}),
  genaiTest: (purpose: string) => call<{ ok: boolean; ms: number; text?: string; json?: unknown; image?: string; error?: string }>('POST', '/api/genai/test', { purpose }),
};

export const assetUrl = (worldId: string, file: string) => `/api/worlds/${worldId}/assets/${file}`;
