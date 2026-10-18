/**
 * The world map: a painted chart of the daydream. Each place owns an organic territory filled with its own ground
 * art, inked borders and coastline, roads between linked places, fog over what the party has not found, and
 * crisp markers and labels on top (an SVG layer, so they stay sharp and clickable).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientWorld, PlayerView } from '@gd/shared';
import { client } from '../net/game';

type Zone = ClientWorld['zones'][number];

export const MAP_W = 880;
export const MAP_H = 540;
const PAD = 70;
/** Territory grid resolution (px per cell). */
const CELL = 3;

const pos = (z: { mapPos: { x: number; y: number } }) => ({ x: PAD + z.mapPos.x * (MAP_W - PAD * 2), y: PAD * 0.8 + z.mapPos.y * (MAP_H - PAD * 1.6) });

// ---------------------------------------------------------------------------- noise

function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, y: number, s: number) => vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15;
const seedOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) & 0xffff;

// ---------------------------------------------------------------------------- territories

interface Territories {
  gw: number;
  gh: number;
  owner: Int16Array;
  /** How far inside its territory a cell is (distance to the next place minus to its own), in px. */
  edge: Float32Array;
  /** How far inside the land a cell is, in px (for the coast). */
  inland: Float32Array;
}

function territories(zones: Zone[], seed: number): Territories {
  const gw = Math.ceil(MAP_W / CELL), gh = Math.ceil(MAP_H / CELL);
  const owner = new Int16Array(gw * gh).fill(-1);
  const edge = new Float32Array(gw * gh);
  const inland = new Float32Array(gw * gh);
  const pts = zones.map(pos);
  // How far land reaches from a place: about half the typical spacing between neighbours.
  let spacing = 0;
  for (const p of pts) spacing += Math.min(...pts.filter((q) => q !== p).map((q) => Math.hypot(p.x - q.x, p.y - q.y)), 400);
  const reach = Math.max(70, Math.min(150, (spacing / Math.max(1, pts.length)) * 0.95));
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * CELL, y = gy * CELL;
      // Warp the sample point so borders and coasts wander like real ones.
      const wx = x + (fbm(x / 90, y / 90, seed) - 0.5) * 70;
      const wy = y + (fbm(x / 90, y / 90, seed + 101) - 0.5) * 70;
      let d1 = Infinity, d2 = Infinity, i1 = -1;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(wx - pts[i]!.x, wy - pts[i]!.y);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          i1 = i;
        } else if (d < d2) d2 = d;
      }
      const coast = reach * (0.75 + fbm(x / 60, y / 60, seed + 202) * 0.5);
      const k = gy * gw + gx;
      if (d1 < coast) {
        owner[k] = i1;
        edge[k] = (d2 - d1) / 2;
        inland[k] = coast - d1;
      }
    }
  // Land bridges along roads, so linked places read as one continent.
  return { gw, gh, owner, edge, inland };
}

// ---------------------------------------------------------------------------- painting

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  });
}

/** A gentle curve between two places (bent the same way every time). */
function roadPath(a: { x: number; y: number }, b: { x: number; y: number }, key: string) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const bend = (hash(seedOf(key), 3, 9) - 0.5) * len * 0.35;
  return { cx: mx - (dy / len) * bend, cy: my + (dx / len) * bend };
}

/** Average brightness of an image, 0..1 (so very light or very dark ground art can be brought to a common tone). */
function luminance(img: HTMLImageElement): number {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d')!;
  x.drawImage(img, 0, 0, 16, 16);
  const d = x.getImageData(0, 0, 16, 16).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
  return sum / (d.length / 4);
}

async function paintMap(canvas: HTMLCanvasElement, world: ClientWorld, zones: Zone[], player: PlayerView, t: Territories) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = MAP_W * dpr;
  canvas.height = MAP_H * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const c = client();
  const known = (z: Zone) => player.knownZones.includes(z.id);
  const visited = (z: Zone) => player.visitedZones.includes(z.id);

  // Sea: deep ink with a faint swell.
  const sea = ctx.createRadialGradient(MAP_W / 2, MAP_H / 2, 40, MAP_W / 2, MAP_H / 2, MAP_W * 0.7);
  sea.addColorStop(0, '#15171a');
  sea.addColorStop(1, '#08090b');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, MAP_W, MAP_H);

  const textures = await Promise.all(zones.map((z) => {
    const ts = world.tilesets[z.tilesetId];
    const url = c.assetUrl(ts?.roles.floor.asset);
    return url ? loadImage(url) : Promise.resolve(null);
  }));

  // Each territory: its ground art (or its colours), masked to its shape.
  const { gw, gh, owner, edge, inland } = t;
  const tmp = document.createElement('canvas');
  tmp.width = MAP_W;
  tmp.height = MAP_H;
  const tc = tmp.getContext('2d')!;
  const mask = document.createElement('canvas');
  mask.width = gw;
  mask.height = gh;
  const mc = mask.getContext('2d')!;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i]!;
    tc.globalCompositeOperation = 'source-over';
    tc.clearRect(0, 0, MAP_W, MAP_H);
    const ts = world.tilesets[z.tilesetId];
    const img = textures[i];
    if (img) {
      const pat = tc.createPattern(img, 'repeat')!;
      // Ground art at map scale: one texture tile is about a fifth of a territory.
      const s = 46 / Math.max(img.width, 1);
      pat.setTransform(new DOMMatrix().scale(s));
      tc.fillStyle = pat;
    } else tc.fillStyle = ts?.roles.floor.colors[0] ?? '#4a4a44';
    tc.fillRect(0, 0, MAP_W, MAP_H);
    const md = mc.createImageData(gw, gh);
    for (let k = 0; k < owner.length; k++) if (owner[k] === i) md.data[k * 4 + 3] = 255;
    mc.putImageData(md, 0, 0);
    tc.globalCompositeOperation = 'destination-in';
    tc.imageSmoothingEnabled = true;
    tc.drawImage(mask, 0, 0, MAP_W, MAP_H);
    ctx.save();
    // Known but unvisited places are drawn faded, like a hearsay sketch.
    // Every place is brought to a similar mid tone, so a white carpet and a black cave both read as land.
    const tone = img ? Math.max(0.45, Math.min(1.8, 0.42 / Math.max(0.05, luminance(img)))) : 1;
    ctx.filter = visited(z) ? `saturate(0.8) brightness(${tone.toFixed(2)})` : `grayscale(0.7) brightness(${(tone * 0.6).toFixed(2)})`;
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }

  // Shading: darker toward borders, lighter in the heart of each place; ink along borders and the coast.
  const shade = ctx.createImageData(gw, gh);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const k = gy * gw + gx;
      const o = owner[k]!;
      if (o < 0) {
        // Shallow water glow just off the coast.
        const near = (gx > 2 && owner[k - 3]! >= 0) || (gx < gw - 3 && owner[k + 3]! >= 0) || (gy > 2 && owner[k - 3 * gw]! >= 0) || (gy < gh - 3 && owner[k + 3 * gw]! >= 0);
        if (near) {
          shade.data[k * 4] = 120;
          shade.data[k * 4 + 1] = 140;
          shade.data[k * 4 + 2] = 150;
          shade.data[k * 4 + 3] = 34;
        }
        continue;
      }
      const border = (gx < gw - 1 && owner[k + 1] !== o) || (gy < gh - 1 && owner[k + gw] !== o) || (gx > 0 && owner[k - 1] !== o) || (gy > 0 && owner[k - gw] !== o);
      const coast = border && ((gx < gw - 1 && owner[k + 1]! < 0) || (gy < gh - 1 && owner[k + gw]! < 0) || (gx > 0 && owner[k - 1]! < 0) || (gy > 0 && owner[k - gw]! < 0));
      let a = Math.max(0, 1 - edge[k]! / 26) * 0.45 + Math.max(0, 1 - inland[k]! / 30) * 0.5;
      if (border) a = coast ? 0.95 : 0.7;
      shade.data[k * 4] = coast ? 18 : 22;
      shade.data[k * 4 + 1] = coast ? 15 : 18;
      shade.data[k * 4 + 2] = coast ? 12 : 14;
      shade.data[k * 4 + 3] = Math.min(255, a * 255);
    }
  mc.putImageData(shade, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.filter = 'blur(1.2px)';
  ctx.drawImage(mask, 0, 0, MAP_W, MAP_H);
  ctx.restore();

  // A unifying wash and paper grain, so different art reads as one chart.
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = 'rgba(205, 180, 135, 0.35)';
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  ctx.restore();
  const grain = ctx.createImageData(MAP_W, MAP_H);
  for (let i = 0; i < grain.data.length; i += 4) {
    const v = Math.random() * 255;
    grain.data[i] = grain.data[i + 1] = grain.data[i + 2] = v;
    grain.data[i + 3] = 10;
  }
  const g2 = document.createElement('canvas');
  g2.width = MAP_W;
  g2.height = MAP_H;
  g2.getContext('2d')!.putImageData(grain, 0, 0);
  ctx.drawImage(g2, 0, 0);

  // Roads.
  const byId = new Map(zones.map((z) => [z.id, z]));
  for (const z of zones)
    for (const l of z.links) {
      const o = byId.get(l);
      if (!o || z.id > l || !(known(z) && known(o))) continue;
      const a = pos(z), b = pos(o), { cx, cy } = roadPath(a, b, z.id + l);
      const walked = visited(z) && visited(o);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(10, 8, 6, 0.75)';
      ctx.lineWidth = walked ? 5 : 3;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.strokeStyle = walked ? 'rgba(232, 208, 160, 0.85)' : 'rgba(232, 208, 160, 0.35)';
      ctx.lineWidth = walked ? 1.6 : 1.2;
      ctx.setLineDash(walked ? [7, 5] : [2, 6]);
      ctx.stroke();
    }
  ctx.setLineDash([]);

  // Fog over places not yet heard of: soft clouds, so the shape of the world is a promise, not a spoiler.
  const fog = document.createElement('canvas');
  fog.width = gw;
  fog.height = gh;
  const fc = fog.getContext('2d')!;
  const fd = fc.createImageData(gw, gh);
  const hidden = new Set(zones.map((z, i) => (known(z) ? -1 : i)).filter((i) => i >= 0));
  for (let k = 0; k < owner.length; k++) {
    if (!hidden.has(owner[k]!)) continue;
    const gx = k % gw, gy = Math.floor(k / gw);
    const n = fbm(gx / 14, gy / 14, 777);
    fd.data[k * 4] = fd.data[k * 4 + 1] = fd.data[k * 4 + 2] = 10 + n * 16;
    fd.data[k * 4 + 3] = 235;
  }
  fc.putImageData(fd, 0, 0);
  ctx.save();
  ctx.filter = 'blur(14px)';
  ctx.drawImage(fog, 0, 0, MAP_W, MAP_H);
  ctx.drawImage(fog, 0, 0, MAP_W, MAP_H);
  ctx.restore();

  // Vignette and frame.
  const vig = ctx.createRadialGradient(MAP_W / 2, MAP_H / 2, MAP_H * 0.35, MAP_W / 2, MAP_H / 2, MAP_W * 0.62);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  ctx.strokeStyle = 'rgba(220, 200, 160, 0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(8.5, 8.5, MAP_W - 17, MAP_H - 17);
  ctx.strokeStyle = 'rgba(220, 200, 160, 0.12)';
  ctx.strokeRect(13.5, 13.5, MAP_W - 27, MAP_H - 27);
}

// ---------------------------------------------------------------------------- markers

function Glyph({ kind, size }: { kind: Zone['kind']; size: number }) {
  const s = size;
  if (kind === 'town')
    return <path d={`M${-s} ${s * 0.7} V${-s * 0.1} L0 ${-s} L${s} ${-s * 0.1} V${s * 0.7} Z M${-s * 0.3} ${s * 0.7} V${s * 0.15} H${s * 0.3} V${s * 0.7}`} />;
  if (kind === 'dungeon')
    return <path d={`M${-s} ${s * 0.8} V${-s * 0.1} A${s} ${s} 0 0 1 ${s} ${-s * 0.1} V${s * 0.8} H${s * 0.45} V${s * 0.05} A${s * 0.45} ${s * 0.45} 0 0 0 ${-s * 0.45} ${s * 0.05} V${s * 0.8} Z`} />;
  return <path d={`M${-s * 1.1} ${s * 0.75} L${-s * 0.35} ${-s * 0.55} L${s * 0.05} ${s * 0.1} L${s * 0.45} ${-s * 0.85} L${s * 1.15} ${s * 0.75} Z`} />;
}

export function WorldMapView({ world, player, here, canTravelTo, onTravel, terms }: {
  world: ClientWorld;
  player: PlayerView;
  here: string;
  canTravelTo: (zoneId: string) => boolean;
  onTravel: (zoneId: string) => void;
  terms: { town: string; dungeon: string; wilderness: string; level: string };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const zones = useMemo(() => world.zones.filter((z) => z.kind !== 'interior'), [world]);
  const terr = useMemo(() => territories(zones, seedOf(world.id)), [zones, world.id]);
  const [hover, setHover] = useState<Zone | null>(null);
  const knownKey = `${player.knownZones.join(',')}|${player.visitedZones.join(',')}`;
  useEffect(() => {
    if (canvas.current) void paintMap(canvas.current, world, zones, player, terr);
    // Repaint only when what the party knows changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, zones, terr, knownKey]);
  const known = zones.filter((z) => player.knownZones.includes(z.id));
  const levels = (z: Zone) => `${terms.level} ${z.levelRange[0]}${z.levelRange[1] !== z.levelRange[0] ? `–${z.levelRange[1]}` : ''}`;
  return (
    <div className="wmap" style={{ width: MAP_W, height: MAP_H }}>
      <canvas ref={canvas} style={{ width: MAP_W, height: MAP_H }} />
      <svg width={MAP_W} height={MAP_H} className="wmap-marks">
        {known.map((z) => {
          const p = pos(z);
          const visited = player.visitedZones.includes(z.id);
          const isHere = z.id === here;
          const wp = z.kind === 'town' && player.waypoints.some((w) => w.zoneId === z.id);
          const travel = canTravelTo(z.id);
          const size = z.kind === 'town' ? 8 : 7;
          return (
            <g key={z.id} transform={`translate(${p.x} ${p.y})`} className={`wmark ${visited ? 'visited' : ''} ${travel ? 'travel' : ''}`}
              onMouseEnter={() => setHover(z)} onMouseLeave={() => setHover(null)} onClick={() => travel && onTravel(z.id)}>
              <circle r={18} fill="transparent" />
              {isHere && <circle r={15} className="here-ring" />}
              {wp && <circle r={12.5} className="wp-ring" />}
              <g className={`glyph g-${z.kind}`}><Glyph kind={z.kind} size={size} /></g>
              <text y={size + 17} textAnchor="middle" className="wname">{z.name}</text>
              <text y={size + 30} textAnchor="middle" className="wsub">{levels(z)}</text>
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="wmap-card" style={{ left: Math.min(MAP_W - 260, pos(hover).x + 22), top: Math.max(12, Math.min(MAP_H - 120, pos(hover).y - 30)) }}>
          <div className="wc-name">{hover.name}</div>
          <div className="wc-sub">{hover.kind === 'town' ? terms.town : hover.kind === 'dungeon' ? terms.dungeon : terms.wilderness} · {levels(hover)}{hover.id === here ? ' · you are here' : ''}</div>
          {player.visitedZones.includes(hover.id) ? <div className="wc-desc">{hover.description}</div> : <div className="wc-desc dim">Known only by word of mouth.</div>}
          {canTravelTo(hover.id) && <div className="wc-act">Click to travel</div>}
        </div>
      )}
    </div>
  );
}
