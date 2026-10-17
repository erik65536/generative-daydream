/** WebSocket connection + client-side game state store shared by the renderer and React UI. */
import { useSyncExternalStore } from 'react';
import {
  BitSet, base64ToBytes, sampleMotion, characterStats, itemDisplayName, rx,
  type ClientMessage, type ClientWorld, type ClockView, type CombatView, type DialogState, type EntityView, type FeatureState, type FxEvent,
  type LootPile, type LootView, type PlayerView, type ServerMessage, type Surface, type TradeState, type ZoneView, type CharacterState, type StatBlock,
  type JournalEntry, type ItemInstance, type Ruleset,
} from '@gd/shared';
import { setRules } from '../rules';

export interface ZoneData extends ZoneView {
  groundBytes: Uint8Array;
  objectBytes: Uint8Array;
  variationBytes: Uint8Array;
}

export type Panel = 'inventory' | 'character' | 'skills' | 'quests' | 'map' | 'craft' | 'menu' | 'help' | 'codex' | null;

export interface Targeting {
  charId: string;
  skillId?: string;
  itemId?: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'good' | 'bad' | 'quest' | 'loot';
  at: number;
}

export interface Narration {
  title: string;
  text: string;
  style?: 'intro' | 'arc' | 'ending' | 'quest' | 'death';
}

export interface GameState {
  status: 'connecting' | 'connected' | 'closed' | 'error';
  error?: string;
  world?: ClientWorld;
  userId?: string;
  instanceId?: string;
  instanceName?: string;
  isOwner: boolean;
  keepRunning: boolean;
  open: boolean;
  zone?: ZoneData;
  entities: Map<string, EntityView>;
  features: Map<string, FeatureState>;
  surfaces: Surface[];
  lootPiles: LootPile[];
  explored?: BitSet;
  player?: PlayerView;
  combat: CombatView | null;
  dialog: DialogState | null;
  trade: TradeState | null;
  loot: LootView | null;
  clock?: ClockView & { localAt: number };
  toasts: Toast[];
  log: { text: string; color?: string; at: number }[];
  narrations: Narration[];
  chat: { from: string; text: string; at: number }[];
  journalFlash?: JournalEntry;
  panel: Panel;
  targeting: Targeting | null;
  selectedCharId?: string;
  /** Monotonic version so React can re-render on mutation. */
  version: number;
  zoneVersion: number;
}

type FxListener = (events: FxEvent[]) => void;

let toastId = 1;

export class GameClient {
  state: GameState = {
    status: 'connecting', isOwner: false, keepRunning: false, open: false, entities: new Map(), features: new Map(), surfaces: [], lootPiles: [], combat: null, dialog: null, trade: null, loot: null,
    toasts: [], log: [], narrations: [], chat: [], panel: null, targeting: null, version: 0, zoneVersion: 0,
  };
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private fxListeners = new Set<FxListener>();
  /** serverTime - localTime */
  offset = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private notifyScheduled = false;
  private closedByUser = false;
  private retries = 0;

  constructor(public readonly instanceId: string) {}

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?instance=${encodeURIComponent(this.instanceId)}`);
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string) as ServerMessage);
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.closedByUser || this.state.status === 'error') {
        if (this.state.status !== 'error') this.state.status = 'closed';
        return this.notify();
      }
      // Transient disconnect (server restart, network blip): retry quietly.
      this.state.status = this.retries > 3 ? 'closed' : 'connecting';
      this.notify();
      if (this.retries < 40) setTimeout(() => this.connect(), Math.min(5000, 500 + this.retries++ * 400));
    };
    ws.onopen = () => {
      this.retries = 0;
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), 5000);
    };
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  private ping() {
    this.send({ t: 'ping', clientTime: Date.now() });
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  onFx(fn: FxListener) {
    this.fxListeners.add(fn);
    return () => this.fxListeners.delete(fn);
  }

  notify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.state = { ...this.state, version: this.state.version + 1 };
      for (const l of this.listeners) l();
    });
  }

  update(patch: Partial<GameState>) {
    Object.assign(this.state, patch);
    this.notify();
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const t = { id: toastId++, text, kind, at: Date.now() };
    this.state.toasts = [...this.state.toasts.slice(-5), t];
    this.notify();
    setTimeout(() => {
      this.state.toasts = this.state.toasts.filter((x) => x !== t);
      this.notify();
    }, kind === 'quest' || kind === 'good' ? 5200 : 4000);
  }

  private onMessage(m: ServerMessage) {
    const s = this.state;
    switch (m.t) {
      case 'welcome':
        s.world = m.world;
        setRules(m.world.ruleset);
        s.userId = m.userId;
        s.instanceId = m.instanceId;
        s.instanceName = m.instanceName;
        s.isOwner = m.isOwner;
        s.keepRunning = m.keepRunning;
        s.open = m.open;
        s.status = 'connected';
        // A (re)connection starts from a clean slate; the server re-sends what is active.
        s.dialog = null;
        s.trade = null;
        s.loot = null;
        s.combat = null;
        s.targeting = null;
        this.offset = m.serverTime - Date.now();
        break;
      case 'pong': {
        const rtt = Date.now() - m.clientTime;
        this.offset = m.serverTime + rtt / 2 - Date.now();
        return;
      }
      case 'zone': {
        const z = m.zone;
        s.zone = { ...z, groundBytes: base64ToBytes(z.ground), objectBytes: base64ToBytes(z.objects), variationBytes: z.variation ? base64ToBytes(z.variation) : new Uint8Array(z.width * z.height) };
        s.entities = new Map(m.entities.map((e) => [e.id, e]));
        s.features = new Map(m.features.map((f) => [f.id, f]));
        s.surfaces = m.surfaces;
        s.lootPiles = m.loot;
        s.explored = new BitSet(z.width * z.height, m.explored);
        s.zoneVersion++;
        s.targeting = null;
        break;
      }
      case 'entities':
        for (const e of m.upsert) s.entities.set(e.id, e);
        for (const id of m.remove) s.entities.delete(id);
        break;
      case 'features':
        for (const f of m.features) s.features.set(f.id, f);
        s.zoneVersion++;
        break;
      case 'surfaces':
        s.surfaces = m.surfaces;
        break;
      case 'loot_piles':
        s.lootPiles = m.loot;
        break;
      case 'player':
        s.player = m.player;
        if (!s.selectedCharId || !m.player.party.some((c) => c.id === s.selectedCharId)) s.selectedCharId = m.player.leaderId;
        break;
      case 'combat':
        s.combat = m.combat;
        if (!m.combat) s.targeting = null;
        else {
          const active = m.combat.order.find((o) => o.id === m.combat!.activeId);
          if (active && active.controllerUserId === s.userId) s.selectedCharId = active.id;
          if (s.targeting && s.targeting.charId !== m.combat.activeId) s.targeting = null;
        }
        break;
      case 'fx': {
        for (const l of this.fxListeners) l(m.events);
        const lines = this.combatLines(m.events);
        if (!lines.length) return;
        s.log = [...s.log, ...lines].slice(-30);
        break;
      }
      case 'dialog':
        s.dialog = m.dialog;
        if (m.dialog) s.panel = null;
        break;
      case 'trade':
        s.trade = m.trade;
        break;
      case 'loot':
        s.loot = m.loot;
        break;
      case 'clock':
        s.clock = { ...m.clock, localAt: Date.now() };
        break;
      case 'narration':
        if (m.text === '__waypoint__') s.panel = 'map';
        else if (m.text === '__craft__') s.panel = 'craft';
        else s.narrations = [...s.narrations, { title: m.title, text: m.text, style: m.style }];
        break;
      case 'toast':
        this.toast(m.text, m.kind);
        return;
      case 'journal':
        s.journalFlash = m.entry;
        break;
      case 'log':
        s.log = [...s.log.slice(-30), { text: m.text, color: m.color, at: Date.now() }];
        break;
      case 'chat':
        s.chat = [...s.chat.slice(-30), { from: m.from, text: m.text, at: Date.now() }];
        break;
      case 'saved':
        break;
      case 'error':
        s.status = 'error';
        s.error = m.message;
        break;
    }
    this.notify();
  }

  // ------------------------------------------------------------------ helpers

  /** Current (interpolated) tile position of an entity. */
  entityPos(e: EntityView): { x: number; y: number; moving: boolean; facing: number } {
    if (e.motion) {
      const smp = sampleMotion(e.motion, this.serverNow());
      return { x: smp.x, y: smp.y, moving: !smp.done, facing: smp.done ? e.facing : smp.facing };
    }
    return { x: e.x, y: e.y, moving: false, facing: e.facing };
  }

  myChars(): CharacterState[] {
    return this.state.player?.party ?? [];
  }

  /** Readable combat log lines for skill uses, hits, misses and deaths. */
  private combatLines(events: FxEvent[]): { text: string; color?: string; at: number }[] {
    const s = this.state;
    if (!s.world) return [];
    const ix = rx(s.world.ruleset);
    const name = (id?: string) => (id ? s.entities.get(id)?.name : undefined);
    const mine = (id?: string) => !!id && s.entities.get(id)?.ownerUserId === s.userId;
    const at = Date.now();
    const out: { text: string; color?: string; at: number }[] = [];
    for (const ev of events) {
      if (ev.kind === 'skill' && ev.skillId && ev.skillId !== s.world.ruleset.basicAttackId) {
        const who = name(ev.sourceId);
        const sk = ix.skill.get(ev.skillId);
        if (who && sk) out.push({ text: `${who} uses ${sk.name}.`, color: mine(ev.sourceId) ? '#cfe4ff' : '#e8c8b8', at });
      } else if (ev.kind === 'damage' && ev.damage) {
        const d = ev.damage;
        const target = name(d.targetId);
        if (!target) continue;
        const src = name(ev.sourceId);
        if (d.miss) out.push({ text: `${src ? `${src} misses ${target}` : `${target} dodges`}.`, color: '#a69c8c', at });
        else if (d.type === 'heal') out.push({ text: `${target} recovers ${Math.round(d.amount)}.`, color: '#9fe0a0', at });
        else if (d.type === 'barrier') out.push({ text: `${target} is shielded (${Math.round(d.amount)}).`, color: '#9fd8ff', at });
        else {
          const kind = ix.subtype.get(d.type)?.name ?? ix.type.get(d.type)?.name ?? '';
          const verb = d.crit ? 'critically hits' : 'hits';
          out.push({ text: src && src !== target ? `${src} ${verb} ${target} for ${Math.round(d.amount)}${kind ? ` ${kind.toLowerCase()}` : ''}.` : `${target} takes ${Math.round(d.amount)}${kind ? ` ${kind.toLowerCase()}` : ''} damage.`, color: mine(d.targetId) ? '#ffb0a0' : d.crit ? '#ffe08a' : '#d8d0c0', at });
        }
      } else if (ev.kind === 'text' && ev.text === 'Dodged') {
        const who = name(ev.targetId);
        if (who) out.push({ text: `${who} dodges${name(ev.sourceId) ? ` ${name(ev.sourceId)}’s attack` : ''}.`, color: '#a69c8c', at });
      } else if (ev.kind === 'death') {
        const who = name(ev.targetId ?? ev.sourceId);
        if (who) out.push({ text: `${who} falls.`, color: mine(ev.targetId ?? ev.sourceId) ? '#ff8a70' : '#f0c070', at });
      }
    }
    return out;
  }

  get r(): Ruleset {
    return this.state.world!.ruleset;
  }

  charStats(ch: CharacterState): StatBlock {
    return characterStats(this.r, ch, { solo: this.state.player?.loneWolf });
  }

  uniqueItems() {
    return { ...(this.state.world?.uniqueItems ?? {}), ...(this.state.player?.dynamicItems ?? {}) } as Record<string, { name: string; description: string }>;
  }

  itemName(item: ItemInstance): string {
    return itemDisplayName(this.r, item, { uniqueItems: this.uniqueItems() });
  }

  itemDescription(item: ItemInstance): string {
    if (item.uniqueId) return this.uniqueItems()[item.uniqueId]?.description ?? '';
    return rx(this.r).item.get(item.baseId)?.description ?? '';
  }

  skillName(id: string): string {
    return rx(this.r).skill.get(id)?.name ?? id;
  }

  leaderEntity(): EntityView | undefined {
    const p = this.state.player;
    if (!p) return undefined;
    return this.state.entities.get(p.leaderId) ?? [...this.state.entities.values()].find((e) => e.ownerUserId === this.state.userId);
  }

  isMyTurn(): boolean {
    const c = this.state.combat;
    if (!c) return false;
    const a = c.order.find((o) => o.id === c.activeId);
    return a?.controllerUserId === this.state.userId;
  }

  activeCombatant() {
    const c = this.state.combat;
    return c?.order.find((o) => o.id === c.activeId);
  }

  assetUrl(key?: string): string | undefined {
    if (!key || !this.state.world) return undefined;
    const rec = this.state.world.assets[key];
    if (!rec || rec.status !== 'ok' || !rec.file) return undefined;
    return `/api/worlds/${this.state.world.id}/assets/${rec.file}`;
  }

  /** Estimated game clock now. */
  clockMinute(): number {
    const c = this.state.clock;
    if (!c) return 8 * 60;
    if (c.paused) return c.minute;
    return c.minute + (Date.now() - c.localAt) / 1000;
  }
}

// Kept on globalThis so hot-reloaded copies of this module share the active client.
const holder = globalThis as unknown as { __gdClient?: GameClient | null };
export function setClient(c: GameClient | null) {
  holder.__gdClient = c;
}
export function clearClient(c: GameClient) {
  if (holder.__gdClient === c) holder.__gdClient = null;
}
export function tryClient(): GameClient | null {
  return holder.__gdClient ?? null;
}
export function client(): GameClient {
  const c = holder.__gdClient;
  if (!c) throw new Error('No game client');
  return c;
}

/** React hook: re-render when the store changes. */
export function useGame<T>(sel: (s: GameState, c: GameClient) => T): T {
  const c = client();
  const s = useSyncExternalStore(c.subscribe, () => c.state);
  return sel(s, c);
}
