/**
 * Building worlds in tests: the real pipeline, with a mock model server for every text step (schema-valid filler,
 * see `fake`) and places laid out as plain open ground instead of being painted and read.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Nav, Rng, makeNav, type CharacterSpec, type ClassRole, type Vec2, type WorldDefinition, type ZoneDef } from '@gd/shared';
import { reloadGenAI } from '../src/genai/service';
import { WorldGenJob, places, runGeneration } from '../src/worldgen/pipeline';
import { populate, type Painted } from '../src/worldgen/zones';
import { loadWorld } from '../src/storage';

type Json = Record<string, unknown>;
let counter = 0;

/** An instance of a JSON schema: every required field, half of the optional ones, mid-range numbers. */
export function fake(schema: Json, root: Json, key = 'value'): unknown {
  if (schema.$ref) {
    const ref = String(schema.$ref).replace(/^#\/(\$defs|definitions)\//, '');
    const defs = (root.$defs ?? root.definitions) as Record<string, Json>;
    return fake(defs[ref]!, root, key);
  }
  for (const k of ['anyOf', 'oneOf'] as const) if (Array.isArray(schema[k])) return fake((schema[k] as Json[]).find((s) => s.type !== 'null') ?? (schema[k] as Json[])[0]!, root, key);
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[])[counter++ % (schema.enum as unknown[]).length];
  if (schema.const !== undefined) return schema.const;
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Json = {};
      const props = (schema.properties ?? {}) as Record<string, Json>;
      for (const [k, v] of Object.entries(props)) if ((schema.required as string[] | undefined)?.includes(k) || counter++ % 2 === 0) out[k] = fake(v, root, k);
      return out;
    }
    case 'array': {
      const min = Number(schema.minItems ?? 1), max = Number(schema.maxItems ?? Math.max(min, 3));
      return Array.from({ length: Math.min(max, Math.max(min, 3)) }, () => fake((schema.items ?? {}) as Json, root, key));
    }
    case 'string': {
      if (schema.pattern && String(schema.pattern).includes('0-9a-fA-F')) return '#7a6a5a';
      const max = Number(schema.maxLength ?? 60);
      const base = `${key} ${++counter} of the mock world, written plainly`;
      const min = Number(schema.minLength ?? 1);
      return base.padEnd(min, ' x').slice(0, Math.max(min, Math.min(max, base.length)));
    }
    case 'integer':
    case 'number': {
      const min = Number(schema.minimum ?? 1), max = Number(schema.maximum ?? 5);
      return Math.max(min, Math.min(max, Math.round((min + max) / 2)));
    }
    case 'boolean':
      return counter++ % 2 === 0;
    default:
      return `${key} ${++counter}`;
  }
}

export interface MockModels {
  /** Every structured call answered, by schema name. */
  seen: string[];
  stop(): void;
}

/**
 * A mock OpenAI-compatible server for the text purposes. It answers like a weak model would: valid JSON with filler
 * text, a real model's sense only where the build checks it (the atlas names each slot, towns have their services).
 * `junkOnce` names schemas whose first answer is broken JSON (to exercise retries).
 */
export async function mockModels(opts: { junkOnce?: string[]; npc?: (prompt: string) => Json } = {}): Promise<MockModels> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body);
      const rf = data.response_format;
      const name: string = rf?.json_schema?.name ?? 'text';
      let content: string;
      if (!rf) content = 'Well met, traveler.';
      else if (name === 'npc_turn' && opts.npc) content = JSON.stringify(opts.npc(JSON.stringify(data.messages)));
      else if (opts.junkOnce?.includes(name) && !seen.includes(name)) content = 'Sure! Here it is: {"arcs": [ oops';
      else {
        const out = fake(rf.json_schema.schema, rf.json_schema.schema, name) as Json;
        if (name === 'world_atlas') {
          const zones = ((rf.json_schema.schema as Json).properties as Record<string, Json>).zones!.items as Json;
          const slots = (zones.properties as Record<string, Json>).slotId!.enum as string[];
          out.zones = slots.map((slotId, i) => ({ ...((out.zones as Json[])[i % (out.zones as Json[]).length] as Json), slotId }));
          (out.regions as Json[]).forEach((r, i) => (r.index = i));
        }
        if (name === 'town_content') {
          const npcs = out.npcs as Json[];
          const roles: [string, string | null][] = [['innkeeper', null], ['merchant', 'general'], ['merchant', 'weapons'], ['trainer', null], ['guard', null], ['companion', null]];
          roles.forEach(([role, kind], i) => (npcs[i] = { ...(npcs[i % npcs.length] ?? npcs[0]), name: `Resident ${++counter}`, role, merchantKind: kind }));
        }
        content = '```json\n' + JSON.stringify(out) + '\n```';
      }
      seen.push(name);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-models-'));
  const before = process.env.GD_GENAI_CONFIG;
  fs.writeFileSync(path.join(dir, 'genai.json'), JSON.stringify({
    providers: { mock: { type: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock', structured: 'json_schema', concurrency: 8 } },
    purposes: Object.fromEntries(['world.design', 'world.content', ...(opts.npc ? ['npc.decision', 'narration'] : [])].map((p) => [p, { provider: 'mock', retries: 1 }])),
    combineNpcDecisionAndDialogue: true,
    worldGenParallelism: 6,
  }));
  process.env.GD_GENAI_CONFIG = path.join(dir, 'genai.json');
  reloadGenAI();
  return {
    seen,
    stop() {
      server.close();
      if (before === undefined) delete process.env.GD_GENAI_CONFIG;
      else process.env.GD_GENAI_CONFIG = before;
      reloadGenAI();
    },
  };
}

/**
 * Places as plain open ground (a walled square, interiors smaller), with the ways out around its edge and everyone
 * spread over the middle; monsters and traps by the real rules. Returns a function that restores painting.
 */
export function plainPlaces(): () => void {
  const real = { ...places };
  places.paint = async () => ({}) as Painted;
  places.settle = async (w, z) => layOut(w, z);
  return () => Object.assign(places, real);
}

function layOut(w: WorldDefinition, z: ZoneDef) {
  const S = z.kind === 'interior' ? 14 : 44;
  const nav = makeNav(S, S, (x, y) => x > 1.4 && y > 1.4 && x < S - 1.4 && y < S - 1.4);
  z.nav = nav;
  z.width = z.height = S;
  z.painting = { image: `place_${z.id}`, width: S * 64, height: S * 32, ox: S * 32, oy: -S * 16 };
  z.look = { ...z.look, weather: 'none' };
  const ways = z.features.filter((f) => f.kind === 'exit' || f.kind === 'door');
  ways.forEach((f, i) => {
    const a = (i / Math.max(1, ways.length)) * Math.PI * 2;
    [f.x, f.y] = [S / 2 + Math.cos(a) * (S / 2 - 3), S / 2 + Math.sin(a) * (S / 2 - 3)];
  });
  const taken: Vec2[] = ways.map((f) => ({ x: f.x, y: f.y }));
  let n = 0;
  const spot = () => {
    const per = Math.floor((S - 12) / 2.5);
    const p = { x: 6 + (n % per) * 2.5, y: 6 + Math.floor(n / per) * 2.5 };
    n++;
    taken.push(p);
    return p;
  };
  for (const f of z.features) if (f.kind !== 'exit' && f.kind !== 'door') Object.assign(f, spot());
  for (const p of w.npcs) if (p.zoneId === z.id) Object.assign(p, spot());
  z.entry = { x: S / 2, y: S / 2 };
  if (z.kind === 'wilderness' || z.kind === 'dungeon') populate(w, z, new Nav(nav), new Rng(`${w.seed}:${z.id}`), S * S * 0.8, taken);
}

let models: Promise<MockModels> | null = null;
const built = new Map<string, WorldDefinition>();

/** A world built by the real pipeline from mock model answers, on plain ground (cached per setup; a fresh copy each call). */
export async function genWorld(setting: string, size: 'small' | 'medium' = 'small', combatMode: 'solo' | 'party_npc' | 'party_manual' = 'solo'): Promise<WorldDefinition> {
  const key = `${setting}|${size}|${combatMode}`;
  if (!built.has(key)) {
    models ??= mockModels();
    await models;
    const restore = plainPlaces();
    try {
      const job = new WorldGenJob(`w_test_${Math.random().toString(36).slice(2, 8)}`, { setting, size, length: 'short', communication: 2, combatMode, seed: 'test-seed' }, { id: 'u1', name: 'Tester' });
      await runGeneration(job);
      built.set(key, loadWorld(job.worldId)!);
    } finally {
      restore();
    }
  }
  return structuredClone(built.get(key)!);
}

/** Problems with a world's links, quests and places (none means it can be played through). */
export function validateWorld(w: WorldDefinition) {
  const zoneIds = new Set(w.zones.map((z) => z.id));
  const npcIds = new Set(w.npcs.map((n) => n.id));
  const errors: string[] = [];
  for (const z of w.zones) {
    if (!z.nav || !z.painting) {
      errors.push(`${z.id}: not painted`);
      continue;
    }
    const nav = new Nav(z.nav);
    for (const f of z.features) {
      if ((f.kind === 'exit' || f.kind === 'door') && (!f.targetZoneId || !zoneIds.has(f.targetZoneId))) errors.push(`${z.id}: bad exit ${f.id} -> ${f.targetZoneId}`);
      if (f.targetFeatureId) {
        const tz = w.zones.find((x) => x.id === f.targetZoneId);
        if (!tz?.features.some((x) => x.id === f.targetFeatureId)) errors.push(`${z.id}: exit ${f.id} target feature ${f.targetFeatureId} missing`);
      }
    }
    // Every way out can be walked to from the entry.
    for (const f of z.features.filter((x) => x.kind === 'exit' || x.kind === 'door'))
      if (!nav.path(z.entry, f, { stopWithin: 1.5, allowBlockedGoal: true })) errors.push(`${z.id} (${z.kind}): exit ${f.id} unreachable from entry`);
  }
  for (const n of w.npcs) if (!zoneIds.has(n.zoneId)) errors.push(`npc ${n.id} zone ${n.zoneId} missing`);
  for (const q of w.quests) {
    if (!q.objectives.length) errors.push(`quest ${q.id} has no objectives`);
    for (const o of q.objectives) {
      if (o.npcId && !npcIds.has(o.npcId)) errors.push(`quest ${q.id} objective ${o.id} npc ${o.npcId}`);
      if (o.zoneId && !zoneIds.has(o.zoneId)) errors.push(`quest ${q.id} zone ${o.zoneId}`);
      if (o.itemUniqueId && !w.uniqueItems[o.itemUniqueId]) errors.push(`quest ${q.id} item ${o.itemUniqueId}`);
      if (o.targetId && !w.bosses.some((b) => b.id === o.targetId)) errors.push(`quest ${q.id} boss ${o.targetId}`);
      if (o.type === 'collect') {
        const placed = w.zones.some((z) => z.features.some((f) => f.items?.includes(o.itemUniqueId!))) || w.bosses.some((b) => b.drops.includes(o.itemUniqueId!)) || w.quests.some((qq) => qq.grantsOnStart?.includes(o.itemUniqueId!));
        if (!placed) errors.push(`quest ${q.id} collect item ${o.itemUniqueId} not placed`);
      }
      if (o.type === 'interact' && !w.zones.some((z) => z.features.some((f) => f.id === o.featureId))) errors.push(`quest ${q.id} interact feature missing`);
    }
  }
  for (const b of w.bosses) if (!w.zones.find((z) => z.id === b.zoneId)?.spawns.some((s) => s.bossId === b.id)) errors.push(`boss ${b.id} not spawned`);
  return errors;
}

/** A character spec for the world's class with the given role (or the first class). */
export function hero(w: WorldDefinition, name: string, role: ClassRole = 'tank'): CharacterSpec {
  const cls = w.ruleset.classes.find((c) => c.role === role) ?? w.ruleset.classes[0]!;
  return { name, classId: cls.id, kinId: w.ruleset.kins[0]!.id, presentation: 'androgynous', pronouns: 'they/them' };
}
