/** Engine-decided world skeleton: regions, zone slots, level bands and connectivity. */
import { LENGTH_PROFILES, SIZE_PROFILES, Rng, type WorldInput, type ZoneKind } from '@gd/shared';

export interface ZoneSlot {
  slotId: string;
  kind: Exclude<ZoneKind, 'interior'>;
  regionIndex: number;
  levelRange: [number, number];
  links: string[];
  mapPos: { x: number; y: number };
  /** Depth along the critical path (0 = start). */
  depth: number;
}

export interface WorldSkeleton {
  maxLevel: number;
  regions: { index: number; levelRange: [number, number] }[];
  slots: ZoneSlot[];
  arcs: number;
  startSlot: string;
}

export function buildSkeleton(input: WorldInput, rng: Rng): WorldSkeleton {
  const size = SIZE_PROFILES[input.size];
  const len = LENGTH_PROFILES[input.length];
  const R = size.regions;
  const maxLevel = len.maxLevel;
  const regions = Array.from({ length: R }, (_, i) => {
    const lo = Math.max(1, Math.round(1 + (i * (maxLevel - 1)) / R));
    const hi = Math.max(lo + 1, Math.round(1 + ((i + 1) * (maxLevel - 1)) / R));
    return { index: i, levelRange: [lo, Math.min(maxLevel, hi)] as [number, number] };
  });
  // Distribute zone counts across regions (region 0 always gets a town).
  const towns = distribute(size.towns, R, true);
  const wilds = distribute(size.wilds, R, true);
  const dungeons = distribute(size.dungeons, R, true);
  const slots: ZoneSlot[] = [];
  let prevExitSlot: ZoneSlot | null = null;
  const link = (a: ZoneSlot, b: ZoneSlot) => {
    if (!a.links.includes(b.slotId)) a.links.push(b.slotId);
    if (!b.links.includes(a.slotId)) b.links.push(a.slotId);
  };
  let depth = 0;
  for (let r = 0; r < R; r++) {
    const [lo, hi] = regions[r]!.levelRange;
    const span = hi - lo;
    const rx = (r + 0.5) / R;
    const mk = (kind: ZoneSlot['kind'], idx: number, lvlFrac: [number, number], pos: { x: number; y: number }): ZoneSlot => ({
      slotId: `${kind[0]}${r}_${idx}`,
      kind,
      regionIndex: r,
      levelRange: [Math.round(lo + span * lvlFrac[0]), Math.max(Math.round(lo + span * lvlFrac[0]), Math.round(lo + span * lvlFrac[1]))],
      links: [],
      mapPos: { x: Math.min(0.95, Math.max(0.05, pos.x)), y: Math.min(0.92, Math.max(0.08, pos.y)) },
      depth: depth++,
    });
    const regionTowns: ZoneSlot[] = [];
    for (let i = 0; i < towns[r]!; i++) {
      const t = mk('town', i, [0, 0.2], { x: rx - 0.32 / R + i * 0.12 / R, y: 0.5 + (i % 2 ? 0.22 : -0.05) + rng.float(-0.05, 0.05) });
      t.levelRange = [lo, lo];
      regionTowns.push(t);
      slots.push(t);
    }
    const regionWilds: ZoneSlot[] = [];
    for (let i = 0; i < wilds[r]!; i++) {
      const frac = wilds[r]! > 1 ? i / (wilds[r]! - 1) : 0.5;
      // Wilds ease you in: the first one starts at the region's base level.
      const a = (i / Math.max(1, wilds[r]!)) * 0.6;
      const w = mk('wilderness', i, [a, a + 0.45], { x: rx - 0.15 / R + frac * 0.4 / R, y: 0.3 + rng.float(0, 0.4) });
      regionWilds.push(w);
      slots.push(w);
    }
    // Chain: previous region exit -> first town (or wild) -> wilds in order.
    const first = regionTowns[0] ?? regionWilds[0]!;
    if (prevExitSlot) link(prevExitSlot, first);
    regionTowns.forEach((t, i) => {
      const w = regionWilds[Math.min(i, regionWilds.length - 1)];
      if (w) link(t, w);
      else if (i > 0) link(regionTowns[i - 1]!, t);
    });
    for (let i = 1; i < regionWilds.length; i++) link(regionWilds[i - 1]!, regionWilds[i]!);
    const regionDungeons: ZoneSlot[] = [];
    for (let i = 0; i < dungeons[r]!; i++) {
      const frac = dungeons[r]! > 1 ? i / (dungeons[r]! - 1) : 1;
      const a = 0.3 + 0.5 * (i / Math.max(1, dungeons[r]!));
      const d = mk('dungeon', i, [a, Math.min(1, a + 0.45)], { x: rx - 0.1 / R + frac * 0.35 / R, y: i % 2 ? 0.2 + rng.float(0, 0.1) : 0.75 + rng.float(0, 0.1) });
      const host = regionWilds.length ? regionWilds[Math.min(regionWilds.length - 1, Math.floor(frac * regionWilds.length))]! : first;
      link(host, d);
      regionDungeons.push(d);
      slots.push(d);
    }
    prevExitSlot = regionWilds[regionWilds.length - 1] ?? regionTowns[regionTowns.length - 1] ?? null;
  }
  return { maxLevel, regions, slots, arcs: len.arcs, startSlot: slots.find((s) => s.kind === 'town')!.slotId };
}

function distribute(total: number, buckets: number, atLeastOne: boolean): number[] {
  const out: number[] = Array.from({ length: buckets }, () => (atLeastOne && total >= buckets ? 1 : 0));
  let left = total - out.reduce((a, b) => a + b, 0);
  let i = 0;
  while (left > 0) {
    out[i % buckets]!++;
    left--;
    i++;
  }
  return out;
}
