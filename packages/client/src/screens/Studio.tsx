import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NAV_CELL, Nav, groundToPicture, type AssetRecord, type NpcDef, type ZoneDef } from '@gd/shared';
import { api, assetUrl, jobActive, type ArtEntry, type JobStatus, type Me, type StudioEdit, type StudioTask, type StudioView } from '../api';
import { ClipPreview } from '../ui/clips';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';
import { PhaseList } from './WorldPage';
import { navigate } from '../App';

type World = StudioView['world'];
type Tab = 'places' | 'people' | 'quests' | 'creatures' | 'art';

/** What the studio's pieces need: the world, a way to edit it and a way to start regeneration jobs. */
interface Ctx {
  w: World;
  art: Map<string, ArtEntry>;
  busy: boolean;
  edit: (e: StudioEdit | StudioEdit[]) => Promise<void>;
  task: (t: StudioTask, confirmText?: string) => Promise<void>;
  /** Animate actors again from a step (in the background animation job). */
  animate: (keys: string[], from: 'render' | 'mesh') => Promise<void>;
  motion: NonNullable<StudioView['motion']>;
  go: (tab: Tab, id?: string) => void;
}

/** The world studio: everything a world is made of, the prompts behind it, and regeneration of any piece. */
export function Studio({ me, worldId }: { me: Me; worldId: string }) {
  const [view, setView] = useState<StudioView | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('places');
  const [sel, setSel] = useState<string | undefined>();
  const wasBusy = useRef(false);

  const load = () => api.studio(worldId).then(setView, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, [worldId]);
  // While a job runs, follow it; reload the world when it ends.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const j = await api.job(worldId);
        const running = jobActive(j.status);
        setJob(running ? j : null);
        if (wasBusy.current && !running) load();
        wasBusy.current = running;
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [worldId]);

  if (!view) return <div className="page"><Backdrop /><TopBar me={me} /><div className="page-inner">{error ? <div className="error-text">{error}</div> : <div className="spinner" />}</div></div>;
  const w = view.world;
  const busy = view.busy || !!job;
  const ctx: Ctx = {
    w,
    art: new Map(view.art.map((a) => [a.key, a])),
    busy,
    edit: async (e) => {
      try {
        setView(await api.studioEdit(worldId, e));
      } catch (x) {
        alert((x as Error).message);
      }
    },
    task: async (t, confirmText) => {
      if (confirmText && !confirm(confirmText)) return;
      try {
        await api.studioTask(worldId, t);
        wasBusy.current = true;
        setView({ ...view, busy: true });
      } catch (x) {
        alert((x as Error).message);
      }
    },
    animate: async (keys, from) => {
      try {
        setView(await api.studioAnimate(worldId, keys, from));
      } catch (x) {
        alert((x as Error).message);
      }
    },
    motion: view.motion ?? {},
    go: (t, id) => {
      setTab(t);
      setSel(id);
    },
  };
  const stale = view.art.filter((a) => a.stale && !a.ref).length;
  return (
    <div className="page">
      <Backdrop palette={w.concept.palette} />
      <TopBar me={me} />
      <div className="page-inner studio">
        <div className="row" style={{ gap: 12, marginBottom: 12 }}>
          <button className="btn ghost sm" onClick={() => navigate(`#/world/${w.id}`)}>← {w.concept.title}</button>
          <div className="h1" style={{ margin: 0, fontSize: 24 }}>Daydream studio</div>
          <div className="spacer" />
          {stale > 0 && !busy && (
            <button className="btn sm" title="Paint every image whose prompt changed or that is missing" onClick={() => ctx.task({ kind: 'paint', keys: view.art.filter((a) => a.stale && !a.ref).map((a) => a.key), reroll: false })}>
              Paint {stale} changed image{stale === 1 ? '' : 's'}
            </button>
          )}
        </div>
        {job && (
          <div className="panel panel-body col" style={{ gap: 10, marginBottom: 12 }}>
            <div className="row">
              <div className="spinner" style={{ width: 18, height: 18 }} />
              <div className="gold">{job.status === 'queued' ? (job.queuePosition ? `Queued: ${job.queuePosition} ahead` : 'Starting soon…') : job.step}</div>
              {job.status === 'waiting' && <span className="badge">waiting for a model</span>}
              <div className="spacer" />
              <button className="btn sm danger" onClick={() => api.cancelJob(worldId)}>Stop</button>
            </div>
            {job.phases && <PhaseList phases={job.phases} />}
            <div className="tiny dim">{job.log.at(-1)?.msg}</div>
          </div>
        )}
        <div className="panel">
          <div className="tabs">
            {(['places', 'people', 'quests', 'creatures', 'art'] as Tab[]).map((t) => (
              <div key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => ctx.go(t)}>
                {{ places: `Places (${w.zones.length})`, people: `People (${w.npcs.length})`, quests: `Quests (${w.quests.length})`, creatures: `Creatures (${w.families.length + w.bosses.length})`, art: `Art (${view.art.filter((a) => !a.ref).length})` }[t]}
              </div>
            ))}
          </div>
          {tab === 'places' && <Places ctx={ctx} sel={sel} />}
          {tab === 'people' && <People ctx={ctx} sel={sel} />}
          {tab === 'quests' && <Quests ctx={ctx} sel={sel} />}
          {tab === 'creatures' && <Creatures ctx={ctx} />}
          {tab === 'art' && <ArtTab ctx={ctx} />}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ shared pieces

/** A list on the left, the selected thing on the right. */
function Split({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <div className="studio-split">
      <div className="studio-list">{list}</div>
      <div className="studio-detail">{children}</div>
    </div>
  );
}

function ListItem({ on, onClick, title, sub, badge }: { on: boolean; onClick: () => void; title: ReactNode; sub?: ReactNode; badge?: ReactNode }) {
  return (
    <div className={`studio-item ${on ? 'on' : ''}`} onClick={onClick}>
      <div className="grow">
        <div className="si-title">{title}</div>
        {sub && <div className="tiny dim">{sub}</div>}
      </div>
      {badge}
    </div>
  );
}

/** URL of an asset's current image (versioned, since repaints keep the file name). */
function imageOf(w: World, key: string): string | undefined {
  const a = w.assets[key];
  if (!a || a.status !== 'ok' || !a.file) return undefined;
  return `${assetUrl(w.id, a.file)}?v=${a.roll ?? 0}_${a.attempts ?? 0}_${(a.score ?? 0).toFixed(2)}`;
}

/** A text field that saves on demand. */
function EditField({ label, value, rows = 1, onSave, disabled }: { label: string; value: string; rows?: number; onSave: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const dirty = v.trim() !== value.trim();
  return (
    <div className="field">
      <label>{label}</label>
      {rows > 1 ? <textarea className="input" rows={rows} value={v} onChange={(e) => setV(e.target.value)} /> : <input className="input" value={v} onChange={(e) => setV(e.target.value)} />}
      {dirty && (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm primary" disabled={disabled || !v.trim()} onClick={() => onSave(v.trim())}>Save</button>
          <button className="btn sm ghost" onClick={() => setV(value)}>Undo</button>
        </div>
      )}
    </div>
  );
}

/** Ask the text model to revise something, with the owner's direction. */
function Rewrite({ ctx, target, what }: { ctx: Ctx; target: { type: 'npc' | 'quest' | 'zone'; id: string }; what: string }) {
  const [g, setG] = useState('');
  return (
    <div className="studio-ai col" style={{ gap: 6 }}>
      <div className="label">Rewrite with AI</div>
      <textarea className="input" rows={2} placeholder={`How should ${what} change? (optional) e.g. ${{ npc: '"a retired racing driver, nervous and kind"', quest: '"make it a heist with a twist at the end"', zone: '"half flooded, abandoned for years"' }[target.type]}`} value={g} onChange={(e) => setG(e.target.value)} />
      <div className="row">
        <button className="btn sm" disabled={ctx.busy} onClick={() => ctx.task({ kind: 'rewrite', target, guidance: g }).then(() => setG(''))}>Rewrite {what}</button>
        <span className="hint">Changed looks are repainted automatically.</span>
      </div>
    </div>
  );
}

/** A character's or creature's animation: its clips playing, or why it has none yet, and buttons to redo it. */
function Motion({ ctx, k, rec }: { ctx: Ctx; k: string; rec: AssetRecord | undefined }) {
  const m = ctx.motion[k];
  if (!m || m.state === 'off') return null;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className={`badge ${m.state === 'animated' ? 'green' : m.state === 'failed' ? 'red' : 'gray'}`}>{{ animated: 'animated', waiting: 'animation waiting its turn', failed: 'not animated' }[m.state]}</span>
        {rec?.anim && <span className="tiny dim">{rec.anim.body}, {Object.keys(rec.anim.clips).length} clips, 8 directions</span>}
      </div>
      {m.error && <div className="tiny bad clamp2" title={m.error}>{m.error}</div>}
      {rec?.anim && m.state === 'animated' && <ClipPreview w={ctx.w} k={k} anim={rec.anim} />}
      <div className="row" style={{ gap: 6 }}>
        {rec?.anim && <button className="btn sm ghost" onClick={() => ctx.animate([k], 'render')}>Render the clips again</button>}
        <button className="btn sm ghost" onClick={() => ctx.animate([k], 'mesh')}>Make a new 3D model</button>
      </div>
    </div>
  );
}

/** One image: what it is, the prompts behind it, and buttons to edit them or repaint. */
function ArtCard({ ctx, k, compact }: { ctx: Ctx; k: string; compact?: boolean }) {
  const e = ctx.art.get(k);
  const rec: AssetRecord | undefined = ctx.w.assets[k];
  const [open, setOpen] = useState(!compact);
  const [brief, setBrief] = useState(e?.brief ?? '');
  const [prompt, setPrompt] = useState(rec?.imagePrompt ?? '');
  useEffect(() => setBrief(e?.brief ?? ''), [e?.brief]);
  useEffect(() => setPrompt(rec?.imagePrompt ?? ''), [rec?.imagePrompt]);
  if (!e) return null;
  const custom = e.brief !== e.defaultBrief;
  const customPrompt = !!ctx.w.artOverrides?.[k]?.imagePrompt;
  const url = imageOf(ctx.w, k);
  return (
    <div className={`art-card ${compact ? 'compact' : ''}`}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div className={`art-thumb ${e.kind}`} onClick={() => setOpen(!open)}>
          {url ? <img src={url} alt="" /> : <span className="tiny dim">{rec?.status === 'failed' ? 'failed' : 'not painted'}</span>}
        </div>
        <div className="grow col" style={{ gap: 4, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <code className="tiny">{k}</code>
            {rec?.status === 'ok' && rec.score !== undefined && <span className={`badge ${rec.score >= 6 ? 'gray' : 'red'}`}>score {rec.score.toFixed(1)}</span>}
            {rec?.status === 'failed' && <span className="badge red">failed</span>}
            {e.stale && <span className="badge">will repaint</span>}
            {custom && <span className="badge green">custom brief</span>}
            {customPrompt && <span className="badge green">custom prompt</span>}
          </div>
          {!open && <div className="small muted clamp2">{e.brief}</div>}
          {rec?.error && open && <div className="tiny bad">{rec.error}</div>}
          {open && <Motion ctx={ctx} k={k} rec={rec} />}
        </div>
      </div>
      {open && (
        <div className="col" style={{ gap: 8, marginTop: 8 }}>
          <div className="field">
            <label>Brief (what to depict)</label>
            <textarea className="input" rows={2} value={brief} onChange={(x) => setBrief(x.target.value)} />
            {custom && <div className="tiny dim">The daydream's own brief: {e.defaultBrief}</div>}
          </div>
          <div className="field">
            <label>Image prompt (written for the image model{rec?.imagePrompt ? '' : '; written when painted'})</label>
            <textarea className="input" rows={4} value={prompt} placeholder="Leave empty to have the prompt writer write it from the brief." onChange={(x) => setPrompt(x.target.value)} />
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {(brief.trim() !== e.brief || prompt.trim() !== (rec?.imagePrompt ?? '').trim()) && (
              <button
                className="btn sm primary"
                disabled={ctx.busy}
                onClick={() =>
                  ctx.edit({
                    type: 'art',
                    key: k,
                    brief: brief.trim() === e.defaultBrief ? null : brief.trim() !== e.brief ? brief.trim() : undefined,
                    // A new brief gets a freshly written prompt unless the owner wrote one.
                    imagePrompt: prompt.trim() !== (rec?.imagePrompt ?? '').trim() ? prompt.trim() || null : brief.trim() !== e.brief ? null : undefined,
                  })
                }
              >
                Save prompts
              </button>
            )}
            {(custom || customPrompt) && <button className="btn sm ghost" disabled={ctx.busy} onClick={() => ctx.edit({ type: 'art', key: k, brief: null, imagePrompt: null })}>Reset to the daydream's</button>}
            <button className="btn sm" disabled={ctx.busy} onClick={() => ctx.task({ kind: 'paint', keys: [k], reroll: !e.stale })}>{e.stale ? 'Paint' : 'Repaint'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------ places

const KIND_ORDER: Record<string, number> = { town: 0, wilderness: 1, dungeon: 2 };

function Places({ ctx, sel }: { ctx: Ctx; sel?: string }) {
  const { w } = ctx;
  const tops = [...w.zones].sort((a, b) => KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]! || a.levelRange[0] - b.levelRange[0]);
  const [id, setId] = useState(sel ?? tops[0]?.id);
  const z = w.zones.find((x) => x.id === id) ?? tops[0];
  return (
    <Split
      list={tops.map((t) => (
        <ListItem key={t.id} on={t.id === z?.id} onClick={() => setId(t.id)} title={t.name} sub={`${t.kind} · ${t.tiles.join(' × ')} tiles · level ${t.levelRange.join('–')}`} />
      ))}
    >
      {z && <ZoneDetail key={z.id} ctx={ctx} z={z} />}
    </Split>
  );
}

function ZoneDetail({ ctx, z }: { ctx: Ctx; z: ZoneDef }) {
  const { w } = ctx;
  const people = w.npcs.filter((n) => n.zoneId === z.id);
  const quests = w.quests.filter((q) => q.zoneId === z.id || q.objectives.some((o) => o.zoneId === z.id));
  const peopleArt = () => people.map((n) => `spr_npc_${n.id}`).filter((k) => ctx.art.has(k));
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="badge">{z.kind}</span>
        <span className="badge gray">level {z.levelRange.join('–')}</span>
        {z.painting && <span className="badge gray">{Math.round(z.width)} × {Math.round(z.height)} m</span>}
        {z.indoor && <span className="badge gray">indoors</span>}
      </div>
      <PlacePainting w={w} z={z} />
      <div className="studio-cols">
        <div className="col" style={{ gap: 10 }}>
          <EditField label="Name" value={z.name} disabled={ctx.busy} onSave={(v) => ctx.edit({ type: 'zone', id: z.id, name: v })} />
          <EditField label="Description" value={z.description} rows={4} disabled={ctx.busy} onSave={(v) => ctx.edit({ type: 'zone', id: z.id, description: v })} />
          <EditField label="Hidden lore (fed to the people here)" value={z.lore ?? ''} rows={3} disabled={ctx.busy} onSave={(v) => ctx.edit({ type: 'zone', id: z.id, lore: v })} />
          <Rewrite ctx={ctx} target={{ type: 'zone', id: z.id }} what="this place" />
          {people.length > 0 && (
            <div className="col" style={{ gap: 4 }}>
              <div className="label">People here</div>
              <div className="row wrap" style={{ gap: 6 }}>{people.map((n) => <button key={n.id} className="btn sm ghost" onClick={() => ctx.go('people', n.id)}>{n.name}</button>)}</div>
            </div>
          )}
          {quests.length > 0 && (
            <div className="col" style={{ gap: 4 }}>
              <div className="label">Quests here</div>
              <div className="row wrap" style={{ gap: 6 }}>{quests.map((q) => <button key={q.id} className="btn sm ghost" onClick={() => ctx.go('quests', q.id)}>{q.title}</button>)}</div>
            </div>
          )}
        </div>
        <div className="col" style={{ gap: 10 }}>
          {z.design && (
            <div className="col" style={{ gap: 6 }}>
              <div className="label">How it was painted</div>
              <div className="small">{z.design.layout}</div>
              <div className="small dim">{z.design.style}</div>
            </div>
          )}
          {peopleArt().length > 0 && (
            <button className="btn sm ghost" disabled={ctx.busy} onClick={() => ctx.task({ kind: 'paint', keys: peopleArt(), reroll: true }, 'Repaint everyone who lives here with new seeds?')}>Repaint its people</button>
          )}
        </div>
      </div>
    </div>
  );
}

const MARK: Record<string, string> = { exit: '#7fd0ff', chest: '#ffd24a', trap: '#ff6a5a', sign: '#e8dcc0', lore: '#c0c0ff', craft_station: '#ffb070', waypoint: '#7fffd4', object: '#ffe28c' };

/** The place's painting, with its people, creatures and features marked where they stand (and, on demand, its walk plan). */
function PlacePainting({ w, z }: { w: World; z: ZoneDef }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState('');
  const [showWalk, setShowWalk] = useState(false);
  // The walk plan as a picture, one pixel per cell: walkable green, sight-blocking blue (as the game's developer view).
  const walkPlan = useMemo(() => {
    if (!z.nav) return null;
    const nav = new Nav(z.nav);
    const c = document.createElement('canvas');
    [c.width, c.height] = [nav.cols, nav.rows];
    const g = c.getContext('2d')!, img = g.createImageData(nav.cols, nav.rows);
    for (let y = 0; y < nav.rows; y++)
      for (let x = 0; x < nav.cols; x++) {
        const walk = nav.walkableCell(x, y), sight = nav.seeThroughCell(x, y);
        if (!walk && sight) continue;
        img.data.set(walk ? [60, 220, 90, 95] : [60, 110, 255, 100], (y * nav.cols + x) * 4);
      }
    g.putImageData(img, 0, 0);
    return { c, w: nav.cols * NAV_CELL, h: nav.rows * NAV_CELL };
  }, [z]);
  const url = z.painting ? imageOf(w, z.painting.image) : undefined;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    setImg(null);
    if (!url) return;
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = url;
  }, [url]);
  const marks = useMemo(() => {
    if (!z.painting) return [];
    const at = (x: number, y: number) => groundToPicture(x, y, z.painting!.ox, z.painting!.oy);
    return [
      ...z.features.map((f) => ({ ...at(f.x, f.y), color: MARK[f.kind] ?? '#fff', label: `${f.kind}: ${f.name ?? ''}` })),
      ...w.npcs.filter((n) => n.zoneId === z.id && !n.companion).map((n) => ({ ...at(n.x, n.y), color: '#ffffff', label: `${n.name}, ${n.title}` })),
      ...z.spawns.map((s) => ({ ...at(s.x, s.y), color: s.bossId ? '#ff3a2a' : '#e06a5a', label: `${w.families.find((f) => f.id === s.familyId)?.name ?? 'creature'} (${s.archetype}, level ${s.level})` })),
    ];
  }, [w, z]);
  const width = 880;
  const k = z.painting ? width / z.painting.width : 1;
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !z.painting) return;
    cv.width = width;
    cv.height = Math.round(z.painting.height * k);
    const g = cv.getContext('2d')!;
    g.fillStyle = '#0b0a10';
    g.fillRect(0, 0, cv.width, cv.height);
    if (img) g.drawImage(img, 0, 0, cv.width, cv.height);
    if (showWalk && walkPlan) {
      const a = groundToPicture(0, 0, z.painting.ox, z.painting.oy), b = groundToPicture(walkPlan.w, walkPlan.h, z.painting.ox, z.painting.oy);
      g.imageSmoothingEnabled = false;
      g.drawImage(walkPlan.c, a.x * k, a.y * k, (b.x - a.x) * k, (b.y - a.y) * k);
      g.imageSmoothingEnabled = true;
    }
    for (const m of marks) {
      g.fillStyle = m.color;
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(m.x * k, m.y * k, 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }, [img, marks, k, showWalk, walkPlan]);
  if (!z.painting) return <div className="dim small">This place has not been painted.</div>;
  const describe = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) * (width / r.width)) / k, y = ((e.clientY - r.top) * (width / r.width)) / k;
    const near = marks.map((m) => ({ m, d: Math.hypot(m.x - x, m.y - y) })).sort((a, b) => a.d - b.d)[0];
    setHover(near && near.d < 10 / k ? near.m.label : '');
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="zone-map">
        <canvas ref={canvas} style={{ width: '100%', height: 'auto' }} onMouseMove={describe} onMouseLeave={() => setHover('')} />
      </div>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <div className="tiny dim">{hover || 'Hover a mark to see who or what stands there.'}</div>
        {walkPlan && (
          <label className="tiny dim row" style={{ gap: 4, cursor: 'pointer' }} title="Where people can walk (green) and what blocks sight (blue)">
            <input type="checkbox" checked={showWalk} onChange={(e) => setShowWalk(e.target.checked)} /> Walkable ground
          </label>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ people

function People({ ctx, sel }: { ctx: Ctx; sel?: string }) {
  const { w } = ctx;
  const [id, setId] = useState(sel ?? w.npcs[0]?.id);
  const [q, setQ] = useState('');
  const n = w.npcs.find((x) => x.id === id);
  const zoneName = (zid: string) => w.zones.find((z) => z.id === zid)?.name ?? zid;
  const list = w.npcs.filter((x) => !q || `${x.name} ${x.title} ${zoneName(x.zoneId)}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Split
      list={
        <>
          <input className="input" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
          {list.map((x) => <ListItem key={x.id} on={x.id === n?.id} onClick={() => setId(x.id)} title={x.name} sub={`${x.title} · ${zoneName(x.zoneId)}`} badge={x.companion ? <span className="badge">companion</span> : x.essential ? <span className="badge">story</span> : undefined} />)}
          <div className="label" style={{ marginTop: 12 }}>Heroes (player classes)</div>
          {w.origins.map((o) => <div key={o.id} className="tiny dim" style={{ padding: '2px 4px' }}>{o.name}: see Art → characters</div>)}
        </>
      }
    >
      {n && <PersonDetail key={n.id} ctx={ctx} n={n} />}
    </Split>
  );
}

function PersonDetail({ ctx, n }: { ctx: Ctx; n: NpcDef }) {
  const { w } = ctx;
  const quests = w.quests.filter((q) => q.giverNpcId === n.id || n.questIds.includes(q.id));
  const save = (k: keyof Extract<StudioEdit, { type: 'npc' }>) => (v: string) => ctx.edit({ type: 'npc', id: n.id, [k]: v } as StudioEdit);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="badge">{n.role}{n.merchantKind ? ` · ${n.merchantKind}` : ''}</span>
        <span className="badge gray">level {n.level}</span>
        <span className="badge gray">{n.pronouns}</span>
        {n.companion && <span className="badge green">companion</span>}
        <button className="btn sm ghost" onClick={() => ctx.go('places', n.zoneId)}>{w.zones.find((z) => z.id === n.zoneId)?.name}</button>
      </div>
      <div className="studio-cols">
        <div className="col" style={{ gap: 10 }}>
          <EditField label="Name" value={n.name} disabled={ctx.busy} onSave={save('name')} />
          <EditField label="Title" value={n.title} disabled={ctx.busy} onSave={save('title')} />
          <EditField label="Appearance (drives the portrait)" value={n.appearance} rows={3} disabled={ctx.busy} onSave={save('appearance')} />
          <EditField label="Personality" value={n.personality} rows={3} disabled={ctx.busy} onSave={save('personality')} />
          <EditField label="Voice" value={n.voice} rows={2} disabled={ctx.busy} onSave={save('voice')} />
          <EditField label="Greeting" value={n.greeting} rows={2} disabled={ctx.busy} onSave={save('greeting')} />
          <EditField label="Backstory" value={n.backstory} rows={4} disabled={ctx.busy} onSave={save('backstory')} />
          {n.knowledge.length > 0 && <div className="col" style={{ gap: 2 }}><div className="label">Knows</div>{n.knowledge.map((k, i) => <div key={i} className="small muted">• {k}</div>)}</div>}
          {n.secrets.length > 0 && <div className="col" style={{ gap: 2 }}><div className="label">Secrets</div>{n.secrets.map((k, i) => <div key={i} className="small muted">• {k}</div>)}</div>}
        </div>
        <div className="col" style={{ gap: 10 }}>
          {ctx.art.has(`spr_npc_${n.id}`) && <ArtCard ctx={ctx} k={`spr_npc_${n.id}`} />}
          <Rewrite ctx={ctx} target={{ type: 'npc', id: n.id }} what="this person" />
          {quests.length > 0 && (
            <div className="col" style={{ gap: 4 }}>
              <div className="label">Gives</div>
              <div className="row wrap" style={{ gap: 6 }}>{quests.map((q) => <button key={q.id} className="btn sm ghost" onClick={() => ctx.go('quests', q.id)}>{q.title}</button>)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ quests

function Quests({ ctx, sel }: { ctx: Ctx; sel?: string }) {
  const { w } = ctx;
  const ordered = [...w.quests].sort((a, b) => Number(b.main) - Number(a.main) || (a.arcIndex ?? 99) - (b.arcIndex ?? 99) || a.level - b.level);
  const [id, setId] = useState(sel ?? ordered[0]?.id);
  const q = w.quests.find((x) => x.id === id);
  return (
    <Split list={ordered.map((x) => <ListItem key={x.id} on={x.id === q?.id} onClick={() => setId(x.id)} title={x.title} sub={`${x.main ? `main · arc ${(x.arcIndex ?? 0) + 1}` : 'side'} · level ${x.level}`} />)}>
      {q && <QuestDetail key={q.id} ctx={ctx} id={q.id} />}
    </Split>
  );
}

function QuestDetail({ ctx, id }: { ctx: Ctx; id: string }) {
  const { w } = ctx;
  const q = w.quests.find((x) => x.id === id)!;
  const who = (nid?: string) => w.npcs.find((n) => n.id === nid)?.name ?? w.bosses.find((b) => b.id === nid)?.name;
  const where = (zid?: string) => w.zones.find((z) => z.id === zid)?.name;
  const target = (o: (typeof q.objectives)[number]) =>
    [who(o.npcId), who(o.targetId), where(o.zoneId), o.itemUniqueId ? w.uniqueItems[o.itemUniqueId]?.name : undefined, o.familyId ? w.families.find((f) => f.id === o.familyId)?.name : undefined, o.count && o.count > 1 ? `×${o.count}` : undefined].filter(Boolean).join(', ');
  const prereq = q.prerequisites.map((p) => w.quests.find((x) => x.id === p)?.title ?? p);
  return (
    <div className="studio-cols">
      <div className="col" style={{ gap: 10 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="badge">{q.main ? 'main story' : 'side quest'}</span>
          <span className="badge gray">level {q.level}</span>
          {q.giverNpcId && <button className="btn sm ghost" onClick={() => ctx.go('people', q.giverNpcId)}>from {who(q.giverNpcId)}</button>}
        </div>
        <EditField label="Title" value={q.title} disabled={ctx.busy} onSave={(v) => ctx.edit({ type: 'quest', id, title: v })} />
        <EditField label="Summary" value={q.summary} rows={4} disabled={ctx.busy} onSave={(v) => ctx.edit({ type: 'quest', id, summary: v })} />
        <div className="label">Objectives</div>
        {q.objectives.map((o) => (
          <div key={o.id} className="col" style={{ gap: 2 }}>
            <div className="tiny dim">{o.type}{target(o) ? ` → ${target(o)}` : ''}{o.hidden ? ' · revealed later' : ''}</div>
            <EditField label="" value={o.description} disabled={ctx.busy} onSave={(v) => ctx.edit({ type: 'quest', id, objectives: [{ id: o.id, description: v }] })} />
          </div>
        ))}
        <EditField label="When completed" value={q.completionText ?? ''} rows={2} disabled={ctx.busy} onSave={(v) => ctx.edit({ type: 'quest', id, completionText: v })} />
      </div>
      <div className="col" style={{ gap: 10 }}>
        <Rewrite ctx={ctx} target={{ type: 'quest', id }} what="this quest" />
        <div className="col" style={{ gap: 4 }}>
          <div className="label">Rewards</div>
          <div className="small muted">{[q.rewards.xp ? `${q.rewards.xp} xp` : '', q.rewards.gold ? `${q.rewards.gold} gold` : '', ...(q.rewards.items ?? []).map((i) => w.uniqueItems[i]?.name ?? w.ruleset.items.find((b) => b.id === i)?.name ?? (i.startsWith('slot:') ? `a piece of ${i.split(':')[1]} gear` : i))].filter(Boolean).join(' · ') || 'none'}</div>
        </div>
        {prereq.length > 0 && <div className="col" style={{ gap: 4 }}><div className="label">After</div><div className="small muted">{prereq.join(', ')}</div></div>}
        <div className="hint">Objectives' types and targets are part of the game's logic; you can change how they are worded.</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ creatures and art

function Creatures({ ctx }: { ctx: Ctx }) {
  const { w } = ctx;
  return (
    <div className="panel-body col" style={{ gap: 18 }}>
      {w.families.map((f) => (
        <div key={f.id} className="col" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}><b>{f.name}</b><span className="tiny dim">{f.habitat}</span></div>
          <div className="small muted">{f.description}</div>
          <div className="art-grid">{f.members.map((m) => ctx.art.has(`spr_mon_${f.id}_${m.archetype}`) && <ArtCard key={m.archetype} ctx={ctx} k={`spr_mon_${f.id}_${m.archetype}`} compact />)}</div>
        </div>
      ))}
      {w.bosses.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <b>Bosses</b>
          <div className="art-grid">{w.bosses.map((b) => ctx.art.has(`spr_boss_${b.id}`) && <ArtCard key={b.id} ctx={ctx} k={`spr_boss_${b.id}`} compact />)}</div>
        </div>
      )}
    </div>
  );
}

const ART_GROUPS: { id: string; label: string; test: (k: string) => boolean }[] = [
  { id: 'chars', label: 'Characters', test: (k) => k.startsWith('spr_') },
  { id: 'obj', label: 'Objects', test: (k) => k.startsWith('obj_') },
  { id: 'icon', label: 'Items', test: (k) => k.startsWith('icon_') },
];

function ArtTab({ ctx }: { ctx: Ctx }) {
  const [group, setGroup] = useState('chars');
  const [filter, setFilter] = useState<'all' | 'low' | 'failed' | 'stale' | 'custom'>('all');
  const [q, setQ] = useState('');
  const entries = [...ctx.art.values()].filter((a) => !a.ref && ART_GROUPS.find((g) => g.id === group)!.test(a.key));
  const shown = entries.filter((a) => {
    const rec = ctx.w.assets[a.key];
    if (q && !`${a.key} ${a.brief}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'low') return rec?.status === 'ok' && (rec.score ?? 10) < 6;
    if (filter === 'failed') return rec?.status === 'failed';
    if (filter === 'stale') return a.stale;
    if (filter === 'custom') return a.brief !== a.defaultBrief || !!ctx.w.artOverrides?.[a.key]?.imagePrompt;
    return true;
  });
  return (
    <div className="panel-body col" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="seg">{ART_GROUPS.map((g) => <button key={g.id} className={group === g.id ? 'on' : ''} onClick={() => setGroup(g.id)}>{g.label}</button>)}</div>
        <div className="seg">{(['all', 'low', 'failed', 'stale', 'custom'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{{ all: 'All', low: 'Low score', failed: 'Failed', stale: 'Will repaint', custom: 'Customised' }[f]}</button>)}</div>
        <input className="input" style={{ maxWidth: 220 }} placeholder="Search prompts" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        {shown.length > 0 && <button className="btn sm ghost" disabled={ctx.busy} onClick={() => ctx.task({ kind: 'paint', keys: shown.map((a) => a.key), reroll: true }, `Repaint all ${shown.length} shown images with new seeds?`)}>Repaint {shown.length} shown</button>}
      </div>
      <div className="art-grid">{shown.map((a) => <ArtCard key={a.key} ctx={ctx} k={a.key} compact />)}</div>
      {!shown.length && <div className="muted small">Nothing here.</div>}
    </div>
  );
}
