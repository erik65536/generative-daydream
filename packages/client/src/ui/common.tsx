import { useEffect, useRef, useState, type ReactNode } from 'react';
import { itemDisplayName, itemLines, itemPrice, rx, skillCostLine, skillLines, type ItemInstance, type Ruleset, type StatBlock } from '@gd/shared';
import { drawItemIcon, drawSkillIcon } from '../render/icons';
import { drawFigure, drawShadow, loadImage } from '../render/sprites';

export function CanvasDraw({ size, draw, deps, className }: { size: number; draw: (ctx: CanvasRenderingContext2D, s: number) => void; deps: unknown[]; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return <canvas ref={ref} className={className} style={{ width: size, height: size }} />;
}

export function SkillIcon({ id, size = 40 }: { id: string; size?: number }) {
  return <CanvasDraw size={size} deps={[id, size]} draw={(ctx, s) => drawSkillIcon(ctx, s, id)} />;
}

export function ItemIcon({ item, size = 40, url }: { item: { baseId: string; rarityId?: string }; size?: number; url?: string }) {
  const [ok, setOk] = useState(!!url);
  if (url && ok) return <img src={url} width={size} height={size} onError={() => setOk(false)} alt="" />;
  return <CanvasDraw size={size} deps={[item.baseId, item.rarityId, size]} draw={(ctx, s) => drawItemIcon(ctx, s, item)} />;
}

export interface PortraitProps {
  sprite?: string;
  colors: string[];
  shape?: 'humanoid' | 'beast' | 'blob' | 'flyer' | 'hulk';
  archetype?: string;
  weapon?: string;
  seed: string;
  size: number;
  kind?: string;
  /** Show the whole figure instead of head and shoulders. */
  full?: boolean;
}

/** Head-and-shoulders view of a figure (procedural or generated). */
export function Portrait({ sprite, colors, shape = 'humanoid', archetype, weapon, seed, size, kind, full }: PortraitProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const img = loadImage(sprite);
    if (sprite && !img) {
      const t = setTimeout(() => setTick((x) => x + 1), 400);
      if (tick > 12) clearTimeout(t);
    }
    if (img) {
      const h = full ? size * 0.92 : size * 2.1;
      const w = (img.naturalWidth / img.naturalHeight) * h;
      ctx.drawImage(img, size / 2 - w / 2, full ? size * 0.04 : size * 0.04, w, h);
    } else {
      ctx.save();
      const humanoid = shape === 'humanoid' || shape === 'hulk';
      const k = full ? size / 75 : size / (humanoid ? 40 : 44);
      ctx.translate(size / 2, full ? size * 0.9 : size * (humanoid ? 1.3 : 0.95));
      drawShadow(ctx, 12 * k);
      drawFigure(ctx, { shape, colors: colors.length ? colors : ['#4a6a9a', '#2a3448', '#e0c060'], scale: k, dir: 1, back: false, walk: NaN, t: 0.4, weapon, archetype, seed, kind });
      ctx.restore();
    }
  }, [sprite, colors.join(','), shape, size, seed, tick, archetype, weapon, kind, full]);
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

export function Bar({ value, max, color, label, thin, extra, extraColor }: { value: number; max: number; color: string; label?: string; thin?: boolean; extra?: number; extraColor?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const ex = extra && max > 0 ? Math.max(0, Math.min(100 - pct, (extra / max) * 100)) : 0;
  return (
    <div className={`bar${thin ? ' thin' : ''}`}>
      <div style={{ width: `${pct}%`, background: color }} />
      {ex > 0 && <div style={{ position: 'absolute', left: `${pct}%`, top: 0, bottom: 0, width: `${ex}%`, background: extraColor ?? 'rgba(160,216,255,.8)' }} />}
      {label && !thin && <div className="lbl">{label}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------- tooltip

let setTip: ((t: { x: number; y: number; content: ReactNode } | null) => void) | null = null;

export function TooltipHost() {
  const [t, set] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  setTip = set;
  if (!t) return null;
  const x = Math.min(t.x + 16, window.innerWidth - 320);
  const y = Math.min(t.y + 16, window.innerHeight - 260);
  return (
    <div className="tooltip" style={{ left: x, top: y }}>
      {t.content}
    </div>
  );
}

export function tip(content: ReactNode | null) {
  return {
    onMouseEnter: (e: React.MouseEvent) => content && setTip?.({ x: e.clientX, y: e.clientY, content }),
    onMouseMove: (e: React.MouseEvent) => content && setTip?.({ x: e.clientX, y: e.clientY, content }),
    onMouseLeave: () => setTip?.(null),
  };
}

export function hideTip() {
  setTip?.(null);
}

export interface Uniques {
  uniqueItems: Record<string, { name: string; description: string }>;
}

export function ItemTooltip({ item, r, uniques, price, compare }: { item: ItemInstance; r: Ruleset; uniques: Uniques; price?: number; compare?: ItemInstance }) {
  const ix = rx(r);
  const base = ix.item.get(item.baseId);
  const lines = itemLines(r, item, base);
  const rarity = ix.rarity.get(item.rarityId);
  const color = item.uniqueId ? '#ffd24a' : rarity?.color ?? '#ddd';
  const desc = item.uniqueId ? uniques.uniqueItems[item.uniqueId]?.description : base?.description;
  const slot = base?.slotId ? ix.slot.get(base.slotId)?.name : undefined;
  const value = itemPrice(r, item);
  return (
    <div>
      <div className="tname" style={{ color }}>{itemDisplayName(r, item, uniques)}</div>
      <div className="tsub">
        {base?.category === 'equipment' ? `${item.uniqueId ? 'Unique' : rarity?.name ?? ''}${slot ? ` ${slot.toLowerCase()}` : ''} · ${r.terminology.level} ${item.level}` : base?.category === 'quest' || item.bound ? 'Story item' : base?.category}
        {item.qty > 1 ? ` · ×${item.qty}` : ''}
      </div>
      <div style={{ marginTop: 6 }}>
        {lines.map((l, i) => (
          <div className="tline" key={i}>{l}</div>
        ))}
      </div>
      {desc && <div className="tdesc">{desc}</div>}
      {compare && <div className="tsub" style={{ marginTop: 6 }}>Equipped: {itemDisplayName(r, compare, uniques)}</div>}
      <div className="tsub" style={{ marginTop: 6 }}>
        {price !== undefined ? `Price: ${price} ${r.terminology.currency}` : value > 0 ? `Value: ${value} ${r.terminology.currency}` : ''}
      </div>
    </div>
  );
}

export function SkillTooltip({ id, r, stats, rank, cooldown, known }: { id: string; r: Ruleset; stats?: StatBlock; rank?: number; cooldown?: number; known?: boolean }) {
  const s = rx(r).skill.get(id);
  if (!s) return null;
  const owner = rx(r).cls.get(s.owner)?.name;
  return (
    <div>
      <div className="tname gold">{s.name}{rank && rank > 1 ? <span className="dim"> · rank {rank}</span> : null}</div>
      <div className="tsub">{skillCostLine(r, s, stats)}{owner ? ` · ${owner}` : ''}</div>
      <div style={{ marginTop: 6 }}>
        {skillLines(r, s, rank ?? 1, stats).map((l, i) => (
          <div className="tline" key={i}>{l}</div>
        ))}
      </div>
      {s.description && <div className="tdesc">{s.description}</div>}
      {cooldown ? <div className="tsub" style={{ color: '#f0c070' }}>Ready in {cooldown}</div> : null}
      {known === false && <div className="tsub">Not learned</div>}
    </div>
  );
}

export function Window({ title, onClose, children, style, className, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; style?: React.CSSProperties; className?: string; actions?: ReactNode }) {
  // Tooltips belong to the window that opened them.
  useEffect(() => () => hideTip(), []);
  return (
    <div className={`window panel ornate ${className ?? ''}`} style={style} onMouseDown={(e) => e.stopPropagation()}>
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />
      <div className="panel-head">
        <h3>{title}</h3>
        <div className="spacer" />
        {actions}
        <button className="btn ghost sm close-x" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      {children}
    </div>
  );
}
