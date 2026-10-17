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
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export interface Me {
  id: string;
  username: string;
  isAdmin: boolean;
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
  input: { size: string; length: string; combatMode: string; communication: number; art: string };
  zones: number;
  npcs: number;
  quests: number;
  palette: { primary: string; secondary: string; accent: string; ui: string };
  cover?: string;
  artProgress: { ok: number; total: number };
  job?: { status: string; progress: number; step: string };
}

export interface JobStatus {
  status: 'running' | 'done' | 'failed' | 'unknown' | 'ready' | 'generating';
  progress: number;
  step: string;
  error?: string;
  log: { t: number; msg: string; kind: 'step' | 'info' | 'warn' | 'error' | 'preview' }[];
  preview: { title?: string; pitch?: string; zones?: string[]; npcs?: string[]; arcs?: string[] };
}

export interface WorldSetup {
  id: string;
  concept: { title: string; pitch: string; tone: string; playerRole: string; genre: string; palette: WorldSummary['palette'] };
  terminology: import('@gd/shared').Terminology;
  combatMode: 'solo' | 'party_manual' | 'party_npc';
  origins: { id: string; name: string; description: string; appearance: string; asset?: string; template: import('@gd/shared').OriginTemplate }[];
  skills: { id: string; name: string; description: string; school: string; minLevel: number; passive: boolean; summary: string }[];
  assets: Record<string, string>;
}

export interface CharSpec {
  name: string;
  originId: string;
  attributes?: Record<string, number>;
  skills?: string[];
  colors?: string[];
}

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  login: (username: string, password: string) => call<Me>('POST', '/api/auth/login', { username, password }),
  register: (username: string, password: string) => call<Me>('POST', '/api/auth/register', { username, password }),
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
  createInstance: (worldId: string, name: string, party: CharSpec[]) => call<{ instanceId: string }>('POST', `/api/worlds/${worldId}/instances`, { name, party }),
  instance: (id: string) => call<import('@gd/shared').InstanceSummary & { hasCharacter: boolean }>('GET', `/api/instances/${id}`),
  joinInstance: (id: string, party: CharSpec[]) => call<{ ok: true }>('POST', `/api/instances/${id}/join`, { party }),
  deleteInstance: (id: string) => call<{ ok: true }>('DELETE', `/api/instances/${id}`),
  genai: () => call<{ purposes: { purpose: string; provider: string; type: string; model?: string }[]; recent: { at: number; purpose: string; provider: string; ms: number; ok: boolean; error?: string; attempt: number; preview?: string }[]; configFile: string | null }>('GET', '/api/genai'),
  genaiReload: () => call<unknown>('POST', '/api/genai/reload', {}),
  genaiTest: (purpose: string) => call<{ ok: boolean; ms: number; text?: string; json?: unknown; image?: string; error?: string }>('POST', '/api/genai/test', { purpose }),
};

export const assetUrl = (worldId: string, file: string) => `/api/worlds/${worldId}/assets/${file}`;
