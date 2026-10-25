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
  /** Today's spending on paid AI models against the daily budget (null limit: unlimited). */
  ai?: { spentToday: number; limit: number | null };
}

export interface UserRow extends Me {
  createdAt: number;
  /** This user's own daily budget, if an administrator set one (null: the server default). */
  dailyLimitUsd: number | null;
  spentWeek: number;
}

/** A deleted daydream waiting in the trash. */
export interface TrashEntry { id: string; title: string; ownerId: string; ownerName: string; deletedAt: number; deletedBy: string; saves: number }

export interface SpendingSummary { today: number; dailyTotalUsd: number | null; dailyPerUserUsd: number | null; adminsUnlimited: boolean; systemWeek: number }

/** The admin GPU page: everything that uses the GPU, across the server, the worker and CLI runs. */
export interface GpuJob {
  id: string;
  kind: 'world' | 'rules' | 'art' | 'studio' | 'animate';
  worldId: string;
  world: string;
  owner: string;
  status: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  priority: number;
  step: string;
  progress: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  cancelRequested: boolean;
  position?: number;
  worker?: string;
}
export interface GpuTag { jobId?: string; worldId?: string; kind?: string }
export interface GpuProcess {
  holder: string;
  role: 'server' | 'worker' | 'cli';
  label: string;
  pid: number;
  host: string;
  startedAt: number;
  seen: number;
  stale: boolean;
  isThis: boolean;
  state: {
    builds: { tag?: GpuTag; running?: { model: string; priority: number; since: number }; pending: { model: string; priority: number }[] }[];
    tasks: { tag: GpuTag; step: string; progress: number; since: number }[];
  };
}
export interface ComfyPromptView {
  id: string;
  number: number;
  workflow: string;
  origin: { kind: 'server' | 'worker' | 'cli' | 'animator' | 'untagged' | 'external'; label: string; holder?: string; jobId?: string; worldId?: string; jobKind?: string };
}
export interface BrokerWork { id: string; adapter: string; model: string; rank: number; client: string; tag?: GpuTag & { label?: string }; state: string; submittedAt: number; startedAt?: number; progress?: number }
export interface GpuView {
  now: number;
  thisProcess: string;
  control: { paused: { by: string; at: number } | null; animationPaused: { by: string; at: number } | null };
  device: { name: string; vramUsedMb: number; vramTotalMb: number; utilization?: number; source: string } | null;
  /** The GPU broker's queue: every installation's work (production, development, CLI runs). */
  broker: { up: boolean; error?: string; resident?: { adapter: string; model: string } | null; running?: BrokerWork | null; queued?: BrokerWork[]; down?: string[] };
  processes: GpuProcess[];
  jobs: { running: GpuJob[]; queued: GpuJob[]; recent: GpuJob[] };
  comfy: { url: string; up: boolean; error?: string; running: ComfyPromptView[]; pending: ComfyPromptView[]; failures: { id: string; at: number; message: string; origin: ComfyPromptView['origin']; workflow: string }[] };
  animation: { worldId: string; title: string; waiting: number; failed: { key: string; error?: string }[] }[];
  throughput: { comfyPromptsLastHour: number | null; imagesLastHour: number | null; actorsPerHour: number; jobsDone24h: number; jobsFailed24h: number; jobsCancelled24h: number };
  audit: { at: number; adminId: string; adminName: string; action: string; target: string; detail: string }[];
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
  input: { size: string; length: string; combatMode: string; communication: number; difficulty: import('@gd/shared').DifficultyId };
  rules?: { name: string; classes: string[]; balance?: { at: number; ok: number; total: number; durationMs: number } };
  zones: number;
  npcs: number;
  quests: number;
  palette: { primary: string; secondary: string; accent: string; ui: string };
  cover?: string;
  /** The daydream's own art for its card. */
  coverArt?: { scene?: string; figures: string[] };
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
  /** Look of each class (id = class id), and its heroes' sprites by kin id. */
  origins: { id: string; name: string; description: string; appearance: string; assets?: Record<string, string> }[];
  /** The three heroes who travel with the player (a world played with companions). */
  companions: { id: string; name: string; title: string; classId: string; kinId: string; asset?: string }[];
  assets: Record<string, string>;
}

/** One image the world uses, with the brief derived from the world and the one in use. */
export interface ArtEntry {
  key: string;
  kind: 'painting' | 'texture' | 'sprite' | 'sheet' | 'object' | 'icon';
  brief: string;
  defaultBrief: string;
  ref?: string;
  stale: boolean;
}

export interface StudioView {
  world: Omit<import('@gd/shared').WorldDefinition, 'generationLog' | 'rulesIntent'>;
  art: ArtEntry[];
  busy: boolean;
  /** Each character's and creature's animation: done, waiting its turn, failed (with why), or not configured. */
  motion?: Record<string, { state: 'animated' | 'waiting' | 'failed' | 'off'; error?: string }>;
}

export type StudioEdit =
  | { type: 'zone'; id: string; name?: string; description?: string; lore?: string }
  | { type: 'npc'; id: string; name?: string; title?: string; personality?: string; appearance?: string; backstory?: string; voice?: string; greeting?: string }
  | { type: 'quest'; id: string; title?: string; summary?: string; completionText?: string; objectives?: { id: string; description: string }[] }
  | { type: 'art'; key: string; brief?: string | null; imagePrompt?: string | null };

export type StudioTask =
  | { kind: 'rewrite'; target: { type: 'npc' | 'quest' | 'zone'; id: string }; guidance: string }
  | { kind: 'paint'; keys: string[]; reroll?: boolean }
  | { kind: 'animate'; keys: string[]; from?: 'render' | 'clips' | 'rig' | 'mesh' };

export type CharSpec = Omit<import('@gd/shared').CharacterSpec, 'sprite'>;

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  login: (username: string, password: string) => call<Me>('POST', '/api/auth/login', { username, password }),
  changePassword: (current: string, next: string) => call<Me>('POST', '/api/auth/password', { current, next }),
  users: () => call<UserRow[]>('GET', '/api/admin/users'),
  inviteUser: (username: string, isAdmin: boolean) => call<{ user: UserRow; password: string }>('POST', '/api/admin/users', { username, isAdmin }),
  resetUser: (id: string) => call<{ password: string }>('POST', `/api/admin/users/${id}/reset`, {}),
  setUserAdmin: (id: string, isAdmin: boolean) => call<UserRow>('PATCH', `/api/admin/users/${id}`, { isAdmin }),
  setUserBudget: (id: string, dailyLimitUsd: number | null) => call<UserRow>('PATCH', `/api/admin/users/${id}`, { dailyLimitUsd }),
  spending: () => call<SpendingSummary>('GET', '/api/admin/spending'),
  trash: () => call<{ days: number; entries: TrashEntry[] }>('GET', '/api/admin/trash'),
  restoreWorld: (id: string) => call<{ ok: true; id: string }>('POST', `/api/admin/trash/${id}/restore`, {}),
  purgeWorld: (id: string) => call<{ ok: true }>('DELETE', `/api/admin/trash/${id}`),
  gpu: (fresh = false) => call<GpuView>('GET', `/api/admin/gpu${fresh ? '?fresh=1' : ''}`),
  gpuPause: (scope: 'all' | 'animation', on: boolean) => call<GpuView['control']>('POST', '/api/admin/gpu/pause', { scope, on }),
  gpuPriority: (id: string, change: { priority: number } | { move: 'up' | 'down' }) => call<{ ok: true }>('POST', `/api/admin/gpu/jobs/${id}/priority`, change),
  gpuCancel: (id: string) => call<{ ok: true; stopped: boolean; promptsCleared: number }>('POST', `/api/admin/gpu/jobs/${id}/cancel`, { confirm: true }),
  gpuClearPrompt: (id: string) => call<{ ok: true; outcome: string }>('POST', `/api/admin/gpu/comfy/${id}/clear`, { confirm: true }),
  gpuRetryActor: (worldId: string, key: string) => call<{ ok: true }>('POST', '/api/admin/gpu/actors/retry', { worldId, key }),
  logout: () => call<{ ok: true }>('POST', '/api/auth/logout', {}),
  worlds: () => call<WorldSummary[]>('GET', '/api/worlds'),
  world: (id: string) => call<WorldSummary>('GET', `/api/worlds/${id}`),
  createWorld: (input: unknown) => call<{ worldId: string }>('POST', '/api/worlds', input),
  deleteWorld: (id: string) => call<{ ok: true }>('DELETE', `/api/worlds/${id}`),
  job: (id: string, since = 0) => call<JobStatus>('GET', `/api/worlds/${id}/job?since=${since}`),
  cancelJob: (id: string) => call<{ ok: true }>('POST', `/api/worlds/${id}/cancel`, {}),
  resumeWorld: (id: string) => call<{ ok: true }>('POST', `/api/worlds/${id}/resume`),
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
  studioAnimate: (id: string, keys: string[], from: 'render' | 'clips' | 'rig' | 'mesh') => call<StudioView>('POST', `/api/worlds/${id}/studio/task`, { kind: 'animate', keys, from }),
  genai: () => call<{ purposes: { purpose: string; provider: string; type: string; model?: string }[]; recent: { at: number; purpose: string; provider: string; ms: number; ok: boolean; error?: string; attempt: number; preview?: string }[]; configFile: string | null }>('GET', '/api/genai'),
  genaiReload: () => call<unknown>('POST', '/api/genai/reload', {}),
  genaiTest: (purpose: string) => call<{ ok: boolean; ms: number; text?: string; json?: unknown; image?: string; error?: string }>('POST', '/api/genai/test', { purpose }),
};

export const assetUrl = (worldId: string, file: string) => `/api/worlds/${worldId}/assets/${file}`;
