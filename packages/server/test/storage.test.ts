import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstanceFile } from '../src/instancestore';
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
