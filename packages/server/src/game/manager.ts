/** Loads, runs, saves and unloads game instances. */
import crypto from 'node:crypto';
import { RULESET_VERSION, type DifficultyId, type InstanceState, type InstanceSummary, type PlayerState, type WorldDefinition } from '@gd/shared';
import { GameInstance } from './instance';
import { listInstances, loadInstance, loadWorld, saveInstance, getUser } from '../storage';
import type { CharacterSpec } from './characters';

const UNLOAD_AFTER_MS = 30_000;

/** Why a save can't be played with the current engine (null if it can). */
export function incompatibility(state: InstanceState, world: WorldDefinition | null): string | null {
  if (!world) return 'Its daydream no longer exists.';
  if (!world.ruleset) return 'Its daydream was made before rules were made per daydream. Regenerate the daydream’s rules on its page, then start a new journey.';
  if ((state.rulesVersion ?? 0) !== RULESET_VERSION || Object.values(state.players).some((p) => p.party.some((c) => !c.classId || !world.ruleset.classes.some((k) => k.id === c.classId))))
    return 'This reverie began under an older rules engine (or before the daydream’s rules were regenerated). Start a new reverie.';
  return null;
}

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
    if (!world || world.status !== 'ready' || incompatibility(state, world)) return null;
    const inst = this.wire(new GameInstance(state, world));
    this.live.set(id, inst);
    return inst;
  }

  /** Drop the running copy (after saving it) so the next connection loads the daydream as it is on disk now. */
  reload(id: string) {
    const inst = this.live.get(id);
    if (!inst) return;
    this.cancelUnload(id);
    inst.save();
    inst.stop();
    this.live.delete(id);
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

  create(world: WorldDefinition, ownerId: string, ownerName: string, name: string, party: CharacterSpec[], difficulty?: DifficultyId): GameInstance {
    const id = `i_${crypto.randomBytes(5).toString('hex')}`;
    const state: InstanceState = {
      id,
      worldId: world.id,
      ownerId,
      name: name.trim().slice(0, 60) || `${ownerName}'s reverie`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clock: 8 * 60,
      open: false,
      players: {},
      npcs: {},
      zones: {},
      dynamicQuests: [],
      events: [],
      rumors: [],
      lastActiveAt: Date.now(),
      difficulty: difficulty ?? world.input.difficulty ?? 'normal',
      rulesVersion: RULESET_VERSION,
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
    copy.open = false;
    saveInstance(copy);
    return copy;
  }

  summary(s: InstanceState): InstanceSummary {
    const live = this.live.get(s.id);
    const state = live?.state ?? s;
    const world = loadWorld(state.worldId);
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
      day: Math.floor(state.clock / 1440) + 1,
      players: Object.values(state.players).map((p) => ({ userId: p.userId, name: p.name, level: Math.max(...p.party.map((c) => c.level)), zone: p.zoneId })),
      online: live?.onlineUsers().length ?? 0,
      difficulty: state.difficulty ?? 'normal',
      incompatible: incompatibility(state, world) ?? undefined,
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
