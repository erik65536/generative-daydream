/** Loads, runs, saves and unloads game instances. */
import crypto from 'node:crypto';
import type { InstanceState, InstanceSummary, PlayerState, WorldDefinition } from '@gd/shared';
import { GameInstance } from './instance';
import { listInstances, loadInstance, loadWorld, saveInstance, getUser } from '../storage';
import type { CharacterSpec } from './characters';

const UNLOAD_AFTER_MS = 30_000;

class InstanceManager {
  private live = new Map<string, GameInstance>();
  private unloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

  get(id: string): GameInstance | null {
    const existing = this.live.get(id);
    if (existing) {
      this.cancelUnload(id);
      return existing;
    }
    const state = loadInstance(id);
    if (!state) return null;
    const world = loadWorld(state.worldId);
    if (!world || world.status !== 'ready') return null;
    const inst = this.wire(new GameInstance(state, world));
    if (state.keepRunning && state.lastActiveAt) inst.catchUp(Date.now() - state.lastActiveAt);
    this.live.set(id, inst);
    return inst;
  }

  private wire(inst: GameInstance): GameInstance {
    inst.onSave = (s) => saveInstance(s);
    inst.onEmpty = () => this.scheduleUnload(inst.state.id);
    inst.hardSave = (p, name) => {
      const snap = this.hardSave(inst, name, p);
      inst.sendTo(p.userId, { t: 'saved', instanceId: snap.id, name: snap.name });
      inst.sendTo(p.userId, { t: 'toast', text: `Saved "${snap.name}".`, kind: 'good' });
    };
    return inst;
  }

  private scheduleUnload(id: string) {
    this.cancelUnload(id);
    this.unloadTimers.set(
      id,
      setTimeout(() => {
        const inst = this.live.get(id);
        if (!inst || inst.onlineUsers().length) return;
        inst.save();
        inst.stop();
        this.live.delete(id);
        this.unloadTimers.delete(id);
      }, UNLOAD_AFTER_MS),
    );
  }

  private cancelUnload(id: string) {
    const t = this.unloadTimers.get(id);
    if (t) clearTimeout(t);
    this.unloadTimers.delete(id);
  }

  create(world: WorldDefinition, ownerId: string, ownerName: string, name: string, party: CharacterSpec[]): GameInstance {
    const id = `i_${crypto.randomBytes(5).toString('hex')}`;
    const state: InstanceState = {
      id,
      worldId: world.id,
      ownerId,
      name: name.trim().slice(0, 60) || `${ownerName}'s journey`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clock: 8 * 60,
      keepRunning: false,
      open: false,
      players: {},
      npcs: {},
      zones: {},
      dynamicQuests: [],
      events: [],
      rumors: [],
      lastActiveAt: Date.now(),
    };
    const inst = this.wire(new GameInstance(state, world));
    inst.addPlayer(ownerId, ownerName, party);
    inst.save();
    this.live.set(id, inst);
    this.scheduleUnload(id);
    return inst;
  }

  addPlayer(inst: GameInstance, userId: string, name: string, party: CharacterSpec[]): PlayerState {
    const p = inst.addPlayer(userId, name, party);
    inst.save();
    return p;
  }

  /** Clone an instance into a new hard save. */
  hardSave(inst: GameInstance, name: string, by: PlayerState): InstanceState {
    inst.save();
    const copy: InstanceState = JSON.parse(JSON.stringify(inst.state));
    copy.id = `i_${crypto.randomBytes(5).toString('hex')}`;
    copy.name = (name.trim() || `${inst.state.name} — day ${inst.day()}`).slice(0, 60);
    copy.snapshotOf = inst.state.id;
    copy.ownerId = by.userId;
    copy.createdAt = Date.now();
    copy.keepRunning = false;
    copy.open = false;
    saveInstance(copy);
    return copy;
  }

  summary(s: InstanceState): InstanceSummary {
    const live = this.live.get(s.id);
    const state = live?.state ?? s;
    return {
      id: state.id,
      worldId: state.worldId,
      name: state.name,
      ownerId: state.ownerId,
      ownerName: getUser(state.ownerId)?.username,
      updatedAt: state.updatedAt,
      createdAt: state.createdAt,
      snapshotOf: state.snapshotOf,
      open: state.open,
      keepRunning: state.keepRunning,
      day: Math.floor(state.clock / 1440) + 1,
      players: Object.values(state.players).map((p) => ({ userId: p.userId, name: p.name, level: Math.max(...p.party.map((c) => c.level)), zone: p.zoneId })),
      online: live?.onlineUsers().length ?? 0,
    };
  }

  list(worldId: string, userId: string): InstanceSummary[] {
    return listInstances(worldId)
      .filter((s) => s.ownerId === userId || s.players[userId] || s.open)
      .map((s) => this.summary(s));
  }

  saveAll() {
    for (const inst of this.live.values()) inst.save();
  }

  isLive(id: string) {
    return this.live.has(id);
  }

  drop(id: string) {
    const inst = this.live.get(id);
    inst?.stop();
    this.live.delete(id);
  }
}

export const instances = new InstanceManager();
