import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GROUND, OBJ, type AssetRecord, type NpcDef, type TileRole, type TilesetDef, type ZoneDef, type ZoneLayoutPlan } from '@gd/shared';
import { api, assetUrl, jobActive, type ArtEntry, type JobStatus, type Me, type StudioEdit, type StudioTask, type StudioView } from '../api';
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
          <div className="h1" style={{ margin: 0, fontSize: 24 }}>World studio</div>
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
  const variants = [...ctx.art.values()].filter((a) => a.ref === k);
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
          {variants.length > 0 && open && (
            <div className="row" style={{ gap: 6 }}>
              {variants.map((v) => {
                const vu = imageOf(ctx.w, v.key);
                return <div key={v.key} className="art-thumb tiny-thumb" title={v.variant}>{vu ? <img src={vu} alt="" /> : null}</div>;
              })}
              <span className="tiny dim">{variants.map((v) => v.variant).join(', ')}</span>
            </div>
          )}
        </div>
      </div>
      {open && (
        <div className="col" style={{ gap: 8, marginTop: 8 }}>
          <div className="field">
            <label>Brief (what to depict)</label>
            <textarea className="input" rows={2} value={brief} onChange={(x) => setBrief(x.target.value)} />
            {custom && <div className="tiny dim">The world's own brief: {e.defaultBrief}</div>}
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
            {(custom || customPrompt) && <button className="btn sm ghost" disabled={ctx.busy} onClick={() => ctx.edit({ type: 'art', key: k, brief: null, imagePrompt: null })}>Reset to the world's</button>}
            <button className="btn sm" disabled={ctx.busy} onClick={() => ctx.task({ kind: 'paint', keys: [k], reroll: !e.stale })}>{e.stale ? 'Paint' : 'Repaint'}{variants.length ? ' (with poses)' : ''}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------ places

const KIND_ORDER: Record<string, number> = { town: 0, wilderness: 1, dungeon: 2, interior: 3 };

function Places({ ctx, sel }: { ctx: Ctx; sel?: string }) {
  const { w } = ctx;
  const tops = w.zones.filter((z) => z.kind !== 'interior').sort((a, b) => KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]! || a.levelRange[0] - b.levelRange[0]);
  const [id, setId] = useState(sel ?? tops[0]?.id);
  const z = w.zones.find((x) => x.id === id) ?? tops[0];
  return (
    <Split
      list={tops.map((t) => (
        <div key={t.id}>
          <ListItem on={t.id === z?.id} onClick={() => setId(t.id)} title={t.name} sub={`${t.kind} · level ${t.levelRange.join('–')}`} />
          {w.zones.filter((i) => i.parentZoneId === t.id).map((i) => (
            <div key={i.id} style={{ paddingLeft: 14 }}>
              <ListItem on={i.id === z?.id} onClick={() => setId(i.id)} title={i.name} sub={i.buildingPurpose ?? 'interior'} />
            </div>
          ))}
        </div>
      ))}
    >
      {z && <ZoneDetail key={z.id} ctx={ctx} z={z} />}
    </Split>
  );
}

const LAYOUT_WORDS = (z: ZoneDef) => {
  const p = z.layout;
  if (!p) return z.indoor ? 'enclosed' : 'open sky';
  return [p.structure, p.enclosed ? 'enclosed' : 'open sky', `${p.blockers.amount} blockers in ${p.blockers.arrangement}`, p.hazard !== 'none' ? `hazard: ${p.hazard}` : '', z.kind === 'town' ? `${p.structures} structures` : '', `${p.clutter} clutter`].filter(Boolean).join(' · ');
};

function ZoneDetail({ ctx, z }: { ctx: Ctx; z: ZoneDef }) {
  const { w } = ctx;
  const ts = w.tilesets[z.tilesetId]!;
  const people = w.npcs.filter((n) => n.zoneId === z.id);
  const quests = w.quests.filter((q) => q.zoneId === z.id || q.objectives.some((o) => o.zoneId === z.id));
  const [look, setLook] = useState('');
  // A town's look includes its interiors' tileset.
  const tilesetIds = [z.tilesetId, ...w.zones.filter((i) => i.parentZoneId === z.id).map((i) => i.tilesetId)].filter((x, i, a) => a.indexOf(x) === i);
  const zoneArt = () => {
    const ids = tilesetIds;
    const keys = [...ctx.art.values()].filter((a) => !a.ref && ids.some((t) => a.key.startsWith(`tex_${t}_`) || a.key.startsWith(`obj_${t}_`))).map((a) => a.key);
    const here = new Set([z.id, ...w.zones.filter((i) => i.parentZoneId === z.id).map((i) => i.id)]);
    return [...keys, ...w.npcs.filter((n) => here.has(n.zoneId)).map((n) => `spr_npc_${n.id}`).filter((k) => ctx.art.has(k))];
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="badge">{z.kind}</span>
        <span className="badge gray">level {z.levelRange.join('–')}</span>
        <span className="badge gray">{z.width}×{z.height}</span>
        <span className="tiny dim">{LAYOUT_WORDS(z)}</span>
      </div>
      <ZoneMap w={w} z={z} />
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
          <div className="studio-ai col" style={{ gap: 6 }}>
            <div className="label">This place's look</div>
            <textarea className="input" rows={2} placeholder='Art direction (optional), e.g. "a flooded parking garage: oily water, stained concrete, abandoned cars"' value={look} onChange={(e) => setLook(e.target.value)} />
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn sm" disabled={ctx.busy} onClick={() => ctx.task({ kind: 'direct', tilesetIds, guidance: look }, 'Redesign every element of this place (ground, walls, props) and repaint them? This takes a while.').then(() => setLook(''))}>Redesign the look</button>
              <button className="btn sm ghost" disabled={ctx.busy} onClick={() => ctx.task({ kind: 'paint', keys: zoneArt(), reroll: true }, 'Repaint every image of this place (surfaces, props and its people) with new seeds?')}>Repaint all its art</button>
            </div>
          </div>
          {z.kind !== 'interior' && <Rebuild ctx={ctx} z={z} />}
          <Elements ctx={ctx} ts={ts} />
        </div>
      </div>
    </div>
  );
}

const STRUCTURES_FOR: Record<string, ZoneLayoutPlan['structure'][]> = { town: ['hub', 'grid'], wilderness: ['open', 'grid'], dungeon: ['rooms', 'caves'] };
const STRUCTURE_WORDS: Record<ZoneLayoutPlan['structure'], string> = { open: 'open: free-form ground', grid: 'grid: blocks between straight lanes', hub: 'hub: a centre with structures around it', rooms: 'rooms: chambers joined by corridors', caves: 'caves: irregular hollows' };

/** A select over a fixed set of words. */
function Pick<T extends string>({ label, value, options, onChange, words }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; words?: Record<string, string> }) {
  return (
    <div className="field">
      <label>{label}</label>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o} value={o}>{words?.[o] ?? o}</option>)}
      </select>
    </div>
  );
}

/** Rebuild the place's map from its (edited) level design, optionally with new content from the AI. */
function Rebuild({ ctx, z }: { ctx: Ctx; z: ZoneDef }) {
  const structures = STRUCTURES_FOR[z.kind] ?? ['open'];
  const initial: ZoneLayoutPlan = z.layout ?? { structure: structures[0]!, enclosed: z.kind === 'dungeon' || !!z.indoor, blockers: { amount: 'some', arrangement: 'clusters' }, hazard: 'none', structures: 'roofed', clutter: 'some' };
  const [plan, setPlan] = useState<ZoneLayoutPlan>(initial);
  const [content, setContent] = useState(false);
  const [g, setG] = useState('');
  useEffect(() => setPlan(initial), [JSON.stringify(z.layout)]);
  const edited = JSON.stringify(plan) !== JSON.stringify(initial);
  const set = (p: Partial<ZoneLayoutPlan>) => setPlan({ ...plan, ...p });
  const what = z.kind === 'town' ? 'new residents, buildings and side quests' : 'new lore notes and shrine';
  const run = () => {
    const intro = `Build a new map for ${z.name}${content ? ` with ${what} from the AI` : ''}. Monsters, chests and people are placed again; its exits still lead to the same places.`;
    ctx.task({ kind: 'zone', zoneId: z.id, plan: edited ? plan : undefined, content, guidance: g }, `${intro}\n\nSaved journeys standing in this place may find themselves somewhere odd. Continue?`).then(() => setG(''));
  };
  return (
    <div className="studio-ai col" style={{ gap: 6 }}>
      <div className="label">Rebuild this place</div>
      <div className="studio-plan">
        <Pick label="Structure" value={plan.structure} options={structures} words={STRUCTURE_WORDS} onChange={(v) => set({ structure: v })} />
        <Pick label="Blockers" value={plan.blockers.amount} options={['sparse', 'some', 'dense'] as const} onChange={(v) => set({ blockers: { ...plan.blockers, amount: v } })} />
        <Pick label="Arranged" value={plan.blockers.arrangement} options={['scattered', 'clusters', 'rows', 'edges'] as const} onChange={(v) => set({ blockers: { ...plan.blockers, arrangement: v } })} />
        <Pick label="Hazard" value={plan.hazard} options={['none', 'pools', 'river', 'channels'] as const} onChange={(v) => set({ hazard: v })} />
        <Pick label="Clutter" value={plan.clutter} options={['sparse', 'some', 'dense'] as const} onChange={(v) => set({ clutter: v })} />
        {z.kind === 'town' && <Pick label="Structures" value={plan.structures} options={['roofed', 'walled'] as const} words={{ roofed: 'roofed buildings', walled: 'walled rooms' }} onChange={(v) => set({ structures: v })} />}
      </div>
      {z.kind !== 'dungeon' && (
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={plan.enclosed} onChange={(e) => set({ enclosed: e.target.checked })} /> Enclosed (under a roof or ceiling: no sky or weather)
        </label>
      )}
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={content} onChange={(e) => setContent(e.target.checked)} /> Also {what}
      </label>
      <textarea className="input" rows={2} placeholder={`Direction (optional), e.g. ${z.kind === 'town' ? '"a night market on stilts over a canal, run by smugglers"' : '"a drowned forest crossed by a slow river"'}`} value={g} onChange={(e) => setG(e.target.value)} />
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn sm" disabled={ctx.busy} onClick={run}>Rebuild the map{content ? ' and content' : ''}</button>
        {edited && <button className="btn sm ghost" onClick={() => setPlan(initial)}>Reset plan</button>}
      </div>
      <div className="hint">
        {edited ? 'Your edited plan is used.' : g.trim() ? 'The plan is unchanged, so the AI chooses the level design from your direction.' : 'Same plan, new seed.'}
        {content ? ' The direction also guides the new content.' : ''} Saved journeys standing in this place may land in odd spots.
      </div>
    </div>
  );
}

const ELEMENT_ROLES: TileRole[] = ['floor', 'floorAlt', 'path', 'water', 'wall', 'tree', 'rock', 'plant', 'light', 'furniture', 'rubble', 'pillar', 'chest', 'shrine', 'sign', 'lever', 'bed'];
const SURFACES = new Set<string>(['floor', 'floorAlt', 'path', 'water', 'wall', 'roof']);

/** The fixed elements of a tileset as this place interprets them, each with its art. */
function Elements({ ctx, ts }: { ctx: Ctx; ts: TilesetDef }) {
  const [edit, setEdit] = useState<string | null>(null);
  const rows: { role: string; def: { name: string; prompt: string; colors: string[] } }[] = [
    ...ELEMENT_ROLES.map((r) => ({ role: r as string, def: ts.roles[r] })),
    ...(ts.extras?.roof ? [{ role: 'roof', def: ts.extras.roof }] : []),
    ...(ts.extras?.craft ? [{ role: 'craft', def: ts.extras.craft }] : []),
  ];
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="label">Elements of {ts.name}</div>
      {rows.map(({ role, def }) => {
        const key = `${SURFACES.has(role) ? 'tex' : 'obj'}_${ts.id}_${role}`;
        const entry = ctx.art.get(key);
        const url = imageOf(ctx.w, key);
        return (
          <div key={role} className="element-row">
            <div className={`art-thumb mini ${SURFACES.has(role) ? 'texture' : 'object'}`} style={{ background: url ? undefined : def.colors[0] }}>{url && <img src={url} alt="" />}</div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <span className="tiny dim" style={{ width: 62 }}>{role}</span>
                <b className="small">{def.name}</b>
                {entry?.stale && <span className="badge">will repaint</span>}
                {!entry && <span className="tiny dim">(not used here)</span>}
                <div className="spacer" />
                <button className="btn ghost sm" onClick={() => setEdit(edit === role ? null : role)}>{edit === role ? 'Close' : 'Edit'}</button>
              </div>
              {edit === role ? (
                <div className="col" style={{ gap: 6, marginTop: 6 }}>
                  <EditField label="Name" value={def.name} disabled={ctx.busy} onSave={(v) => ctx.edit({ type: 'role', tilesetId: ts.id, role, name: v })} />
                  <EditField label="Description" value={def.prompt} rows={2} disabled={ctx.busy} onSave={(v) => ctx.edit({ type: 'role', tilesetId: ts.id, role, prompt: v })} />
                  {entry && <ArtCard ctx={ctx} k={key} compact />}
                </div>
              ) : (
                <div className="tiny dim clamp1">{def.prompt}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------ zone map

const ATLAS_GROUND: Record<number, string> = { [GROUND.void]: '#0b0a10', [GROUND.floor]: '#8b8270', [GROUND.floorAlt]: '#6f7d5e', [GROUND.path]: '#b9a77e', [GROUND.water]: '#2f5f8f', [GROUND.wall]: '#2c2833' };
const GROUND_ROLE: Record<number, TileRole> = { [GROUND.floor]: 'floor', [GROUND.floorAlt]: 'floorAlt', [GROUND.path]: 'path', [GROUND.water]: 'water', [GROUND.wall]: 'wall' };
const OBJ_ROLE: Record<number, TileRole> = { [OBJ.tree]: 'tree', [OBJ.rock]: 'rock', [OBJ.plant]: 'plant', [OBJ.light]: 'light', [OBJ.furniture]: 'furniture', [OBJ.rubble]: 'rubble', [OBJ.pillar]: 'pillar' };
const ATLAS_OBJ: Record<string, string> = { tree: '#2f6b3a', rock: '#7b7b85', plant: '#6fae4f', light: '#f0d36a', furniture: '#a0703c', rubble: '#5d5148', pillar: '#c8c0b0' };
const FEATURE_GLYPH: Record<string, [string, string]> = { door: ['▮', '#e0b060'], exit: ['➜', '#7fd0ff'], chest: ['▣', '#ffd24a'], trap: ['✕', '#ff6a5a'], shrine: ['✚', '#9fe8a0'], sign: ['⌂', '#e8dcc0'], lever: ['⚲', '#d0a0ff'], gate: ['▤', '#c0a080'], lore: ['✎', '#c0c0ff'], bed: ['▭', '#c0e0ff'], craft_station: ['⚒', '#ffb070'], waypoint: ['◈', '#7fffd4'] };
const FEATURE_ART: Record<string, string> = { chest: 'chest', shrine: 'shrine', sign: 'sign', lever: 'lever', bed: 'bed', craft_station: 'craft' };

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Load images by URL; re-renders as they arrive. */
function useImages(urls: string[]): Map<string, HTMLImageElement> {
  const [, bump] = useState(0);
  const cache = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    for (const u of urls) {
      if (cache.current.has(u)) continue;
      const img = new Image();
      img.onload = () => bump((x) => x + 1);
      img.src = u;
      cache.current.set(u, img);
    }
  }, [urls.join('|')]);
  return new Map([...cache.current].filter(([, i]) => i.complete && i.naturalWidth));
}

/** Top-down map of a zone: the bare layout (atlas) or with its painted art. */
function ZoneMap({ w, z }: { w: World; z: ZoneDef }) {
  const [mode, setMode] = useState<'atlas' | 'art'>('art');
  const [cell, setCell] = useState(12);
  const [hover, setHover] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const ts = w.tilesets[z.tilesetId]!;
  const ground = useMemo(() => b64(z.ground), [z.ground]);
  const objects = useMemo(() => b64(z.objects), [z.objects]);
  const npcs = w.npcs.filter((n) => n.zoneId === z.id);
  const roleKey = (r: string) => `${SURFACES.has(r) ? 'tex' : 'obj'}_${ts.id}_${r}`;
  const urls = useMemo(() => {
    const keys = [...Object.values(GROUND_ROLE), ...Object.values(OBJ_ROLE), ...Object.values(FEATURE_ART)].map(roleKey);
    keys.push(...npcs.map((n) => `spr_npc_${n.id}`), ...z.spawns.map((s) => (s.bossId ? `spr_boss_${s.bossId}` : `spr_mon_${s.familyId}_${s.archetype}`)));
    return keys.map((k) => imageOf(w, k)).filter((u): u is string => !!u);
  }, [w, z]);
  const imgs = useImages(urls);
  const img = (key: string) => {
    const u = imageOf(w, key);
    return u ? imgs.get(u) : undefined;
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const W = z.width, H = z.height, s = cell;
    c.width = W * s;
    c.height = H * s;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#0b0a10';
    g.fillRect(0, 0, c.width, c.height);
    // Ground: flat colours, or each surface's texture repeating every four tiles.
    const patterns = new Map<number, CanvasPattern | null>();
    const patternFor = (code: number) => {
      if (patterns.has(code)) return patterns.get(code)!;
      const role = GROUND_ROLE[code];
      const im = role ? img(roleKey(role)) : undefined;
      let p: CanvasPattern | null = null;
      if (im && mode === 'art') {
        p = g.createPattern(im, 'repeat');
        p?.setTransform(new DOMMatrix().scale((s * 4) / im.naturalWidth));
      }
      patterns.set(code, p);
      return p;
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const code = ground[y * W + x]!;
        const p = patternFor(code);
        g.fillStyle = p ?? (mode === 'atlas' ? ATLAS_GROUND[code] ?? '#000' : ts.roles[GROUND_ROLE[code] ?? 'floor']?.colors[0] ?? ATLAS_GROUND[code] ?? '#000');
        g.fillRect(x * s, y * s, s, s);
        if (code === GROUND.wall && mode === 'art') {
          g.fillStyle = 'rgba(0,0,0,.25)';
          g.fillRect(x * s, y * s, s, s);
        }
      }
    // Things standing on the map, back to front.
    type Thing = { x: number; y: number; draw: () => void };
    const things: Thing[] = [];
    const sprite = (im: HTMLImageElement, x: number, y: number, h: number) => {
      const ih = h * s, iw = (im.naturalWidth / im.naturalHeight) * ih;
      g.drawImage(im, x * s + s / 2 - iw / 2, (y + 1) * s - ih, iw, ih);
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const role = OBJ_ROLE[objects[y * W + x]!];
        if (!role) continue;
        const im = mode === 'art' ? img(roleKey(role)) : undefined;
        things.push({
          x, y,
          draw: () => {
            if (im) sprite(im, x, y, role === 'tree' || role === 'pillar' ? 2 : 1.3);
            else {
              g.fillStyle = ATLAS_OBJ[role] ?? '#fff';
              const pad = role === 'tree' ? 0.05 : 0.2;
              g.fillRect((x + pad) * s, (y + pad) * s, s * (1 - 2 * pad), s * (1 - 2 * pad));
            }
          },
        });
      }
    for (const f of z.features) {
      const art = FEATURE_ART[f.kind];
      const im = mode === 'art' && art ? img(roleKey(art)) : undefined;
      things.push({
        x: f.x, y: f.y,
        draw: () => {
          if (im) return sprite(im, f.x, f.y, 1.3);
          const [glyph, col] = FEATURE_GLYPH[f.kind] ?? ['?', '#fff'];
          g.fillStyle = 'rgba(0,0,0,.55)';
          g.fillRect(f.x * s, f.y * s, s, s);
          g.fillStyle = col;
          g.font = `${Math.max(8, s * 0.9)}px sans-serif`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(glyph, f.x * s + s / 2, f.y * s + s / 2 + 1);
        },
      });
    }
    const dot = (x: number, y: number, col: string, r: number) => {
      g.fillStyle = col;
      g.beginPath();
      g.arc(x * s + s / 2, y * s + s / 2, r * s, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.lineWidth = 1;
      g.stroke();
    };
    for (const n of npcs) {
      const im = mode === 'art' ? img(`spr_npc_${n.id}`) : undefined;
      things.push({ x: n.x, y: n.y, draw: () => (im ? sprite(im, n.x, n.y, 2.2) : dot(n.x, n.y, '#ffffff', 0.4)) });
    }
    for (const sp of z.spawns) {
      const im = mode === 'art' ? img(sp.bossId ? `spr_boss_${sp.bossId}` : `spr_mon_${sp.familyId}_${sp.archetype}`) : undefined;
      things.push({ x: sp.x, y: sp.y, draw: () => (im ? sprite(im, sp.x, sp.y, sp.bossId ? 3 : 2) : dot(sp.x, sp.y, sp.bossId ? '#ff3030' : '#e06a5a', sp.bossId ? 0.55 : 0.35)) });
    }
    things.sort((a, b) => a.y - b.y || a.x - b.x).forEach((t) => t.draw());
  }, [mode, cell, z, w, imgs.size]);

  const describe = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * z.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * z.height);
    if (x < 0 || y < 0 || x >= z.width || y >= z.height) return setHover('');
    const gRole = GROUND_ROLE[ground[y * z.width + x]!];
    const oRole = OBJ_ROLE[objects[y * z.width + x]!];
    const f = z.features.find((q) => q.x === x && q.y === y);
    const n = npcs.find((q) => q.x === x && q.y === y);
    const sp = z.spawns.find((q) => q.x === x && q.y === y);
    const fam = sp && w.families.find((q) => q.id === sp.familyId);
    setHover([
      `(${x}, ${y})`,
      gRole ? `${ts.roles[gRole].name} [${gRole}]` : 'void',
      oRole ? `${ts.roles[oRole].name} [${oRole}]` : '',
      f ? `${f.name ?? f.kind} [${f.kind}]` : '',
      n ? `${n.name}, ${n.title}` : '',
      sp ? (sp.bossId ? w.bosses.find((b) => b.id === sp.bossId)?.name ?? 'boss' : `${fam?.members.find((m) => m.archetype === sp.archetype)?.name ?? sp.archetype} (lv ${sp.level})`) : '',
    ].filter(Boolean).join(' · '));
  };

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <div className="seg">
          <button className={mode === 'atlas' ? 'on' : ''} onClick={() => setMode('atlas')}>Atlas</button>
          <button className={mode === 'art' ? 'on' : ''} onClick={() => setMode('art')}>Art</button>
        </div>
        <div className="seg">
          {[8, 12, 18].map((c) => <button key={c} className={cell === c ? 'on' : ''} onClick={() => setCell(c)}>{c === 8 ? 'S' : c === 12 ? 'M' : 'L'}</button>)}
        </div>
        <div className="tiny dim grow" style={{ textAlign: 'right' }}>{hover || 'Hover the map to inspect a tile.'}</div>
      </div>
      <div className="zone-map">
        <canvas ref={canvas} onMouseMove={describe} onMouseLeave={() => setHover('')} />
      </div>
      {mode === 'atlas' && (
        <div className="row wrap tiny dim" style={{ gap: 10 }}>
          {Object.entries(GROUND_ROLE).map(([c, r]) => <span key={r}><i className="swatch" style={{ background: ATLAS_GROUND[Number(c)] }} />{r}</span>)}
          {Object.entries(ATLAS_OBJ).map(([r, col]) => <span key={r}><i className="swatch" style={{ background: col }} />{r}</span>)}
          <span><i className="swatch round" style={{ background: '#fff' }} />person</span>
          <span><i className="swatch round" style={{ background: '#e06a5a' }} />creature</span>
        </div>
      )}
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
          {list.map((x) => <ListItem key={x.id} on={x.id === n?.id} onClick={() => setId(x.id)} title={x.name} sub={`${x.title} · ${zoneName(x.zoneId)}`} badge={x.essential ? <span className="badge">story</span> : undefined} />)}
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
        {n.canJoinParty && <span className="badge green">can join the party</span>}
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
  { id: 'tex', label: 'Surfaces', test: (k) => k.startsWith('tex_') },
  { id: 'obj', label: 'Props', test: (k) => k.startsWith('obj_') },
  { id: 'chars', label: 'Characters', test: (k) => k.startsWith('spr_') },
  { id: 'icon', label: 'Items', test: (k) => k.startsWith('icon_') },
];

function ArtTab({ ctx }: { ctx: Ctx }) {
  const [group, setGroup] = useState('tex');
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
