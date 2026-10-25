import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstanceFile } from '../src/instancestore';
import * as store from '../src/storage';
import { instances } from '../src/game/manager';
import { genWorld, hero } from './helpers';

describe('instance storage', () => {
  it('round-trips a save and writes only the sections that changed', async () => {
    const w = await genWorld('A quiet valley of mills and old shrines');
    const inst = instances.create(w, 'u_store', 'Tester', 'storage test', [hero(w, 'Ada', 'tank')]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gd-store-')), 'save.sqlite');
    const f = new InstanceFile(file);
    const state = inst.state;
    const p = Object.values(state.players)[0]!;
    p.journal.push({ day: 1, minute: 1, kind: 'story', text: 'Arrived.' });
    p.conversations['npc_x'] = [{ speaker: 'player', text: 'Hello', at: 1 } as never];
    const first = f.save(state);
    expect(first).toBeGreaterThan(3);
    expect(f.save(state)).toBe(0);
    p.gold += 5;
    expect(f.save(state)).toBe(1);
    delete p.conversations['npc_x'];
    f.save(state);
    const loaded = f.load()!;
    expect(loaded).toEqual(JSON.parse(JSON.stringify(state)));
    // A fresh handle (another process) sees the same data.
    f.close();
    expect(new InstanceFile(file).load()).toEqual(loaded);
  });
});

describe('world trash', () => {
  it('moves a deleted world and its saves to the trash, restores them, and purges old entries', async () => {
    const base = await genWorld('A quiet valley of mills and old shrines');
    const w = { ...structuredClone(base), id: `w_trash_${Math.random().toString(36).slice(2, 8)}` };
    store.saveWorld(w);
    const inst = instances.create(w, 'u_store', 'Tester', 'trash test', [hero(w, 'Ada', 'tank')]);
    store.saveInstance(inst.state);
    instances.drop(inst.state.id);

    store.deleteWorld(w.id, 'admin');
    expect(store.loadWorld(w.id)).toBeNull();
    expect(store.loadInstance(inst.state.id)).toBeNull();
    expect(fs.existsSync(store.worldDir(w.id))).toBe(false);
    const entry = store.listTrash().find((e) => e.id === w.id)!;
    expect(entry).toMatchObject({ title: w.concept.title, deletedBy: 'admin', saves: 1 });

    store.restoreWorld(w.id);
    expect(store.loadWorld(w.id)?.concept.title).toBe(w.concept.title);
    expect(store.loadInstance(inst.state.id)?.name).toBe('trash test');
    expect(store.listInstances(w.id).map((s) => s.id)).toEqual([inst.state.id]);
    expect(store.listTrash().some((e) => e.id === w.id)).toBe(false);

    store.deleteWorld(w.id);
    expect(store.purgeTrash(Date.now() + 29 * 86400_000)).toBe(0);
    expect(store.purgeTrash(Date.now() + (store.TRASH_DAYS + 1) * 86400_000)).toBeGreaterThanOrEqual(1);
    expect(store.listTrash().some((e) => e.id === w.id)).toBe(false);
    expect(() => store.restoreWorld(w.id)).toThrow();
  });
});
