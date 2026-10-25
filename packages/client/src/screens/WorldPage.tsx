import { useEffect, useRef, useState } from 'react';
import type { InstanceSummary, Ruleset } from '@gd/shared';
import { api, jobActive, type JobPhase, type JobStatus, type Me, type WorldSummary } from '../api';
import { CodexView } from '../ui/windows';
import { setRules } from '../rules';
import { Backdrop, DaydreamArt } from '../ui/Backdrop';
import { LENGTH_LABEL, MODE_LABEL, SIZE_LABEL, TopBar } from './Lobby';
import { navigate } from '../App';

export function WorldPage({ me, worldId }: { me: Me; worldId: string }) {
  const [w, setW] = useState<WorldSummary | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [log, setLog] = useState<JobStatus['log']>([]);
  const [saves, setSaves] = useState<InstanceSummary[]>([]);
  const [error, setError] = useState('');
  const [ruleset, setRuleset] = useState<Ruleset | null>(null);
  const [canRebalance, setCanRebalance] = useState(false);
  const [view, setView] = useState<'codex' | 'balance' | null>(null);
  const since = useRef(0);
  const rulesAt = useRef<number | undefined>(undefined);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const ws = await api.world(worldId);
        if (!alive) return;
        setW(ws);
        if (ws.status === 'generating' || jobActive(ws.job?.status)) {
          const j = await api.job(worldId, since.current);
          if (!alive) return;
          setJob(j);
          if (j.log.length) {
            since.current = j.log[j.log.length - 1]!.t;
            setLog((l) => [...l, ...j.log].slice(-400));
          }
        } else {
          setJob(null);
          if (ws.status === 'ready') {
            setSaves(await api.instances(worldId));
            // Reload the ruleset only when it changed (first load, or after a rules job).
            const at = ws.rules?.balance?.at ?? (ws.rules ? 0 : -1);
            if (rulesAt.current !== at) {
              rulesAt.current = at;
              const rr = await api.rules(worldId);
              if (!alive) return;
              setRuleset(rr.ruleset);
              setRules(rr.ruleset);
              setCanRebalance(rr.canRebalance);
            }
          }
        }
      } catch (e) {
        setError((e as Error).message);
      }
    };
    tick();
    const t = setInterval(tick, 1200);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [worldId]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log.length]);

  if (!w) return <div className="page"><Backdrop /><TopBar me={me} /><div className="page-inner">{error || <div className="spinner" />}</div></div>;
  const generating = w.status === 'generating' || jobActive(job?.status);
  const mine = saves.filter((s) => s.ownerId === me.id || s.players.some((p) => p.userId === me.id));
  const joinable = saves.filter((s) => s.open && !s.players.some((p) => p.userId === me.id));
  return (
    <div className="page">
      <Backdrop palette={w.palette} />
      <TopBar me={me} />
      <div className="page-inner">
        <div className="panel" style={{ overflow: 'hidden' }}>
          <div style={{ height: 180, position: 'relative' }}>
            <DaydreamArt id={w.id} palette={w.palette} art={w.coverArt} height={180} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(transparent 30%, rgba(14,11,18,.95))' }} />
            <div style={{ position: 'absolute', left: 24, bottom: 16, right: 24 }}>
              <div className="h1" style={{ marginBottom: 2 }}>{job?.preview.title ?? w.title}</div>
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="badge gray">{SIZE_LABEL[w.input.size]} world</span>
                <span className="badge gray">{LENGTH_LABEL[w.input.length]} story</span>
                <span className="badge gray">{MODE_LABEL[w.input.combatMode]}</span>
                {w.rules && <span className="badge">{w.rules.name}</span>}
                <span className="badge gray">by {w.ownerName}</span>
              </div>
            </div>
          </div>
          <div className="panel-body">
            <p className="lede" style={{ margin: '4px 0 0' }}>{job?.preview.pitch ?? w.pitch}</p>
          </div>
        </div>

        {generating && job && (
          <div className="panel panel-body col" style={{ marginTop: 18, gap: 12 }}>
            <div className="row">
              <div className="spinner" style={{ width: 22, height: 22 }} />
              <div className="display gold" style={{ fontSize: 16 }}>
                {job.status === 'queued' ? (job.queuePosition ? `Queued: ${job.queuePosition} ahead` : 'Starting soon…') : job.step || 'Dreaming…'}
              </div>
              {job.status === 'waiting' && <span className="badge">waiting for a model</span>}
              <div className="spacer" />
              <span className="muted small">{Math.round(job.progress * 100)}%</span>
              {w.ownerId === me.id && <button className="btn sm danger" onClick={() => api.cancelJob(worldId)}>Stop</button>}
            </div>
            <div className="progress"><div style={{ width: `${job.progress * 100}%` }} /></div>
            {job.phases && job.phases.length > 0 && <PhaseList phases={job.phases} />}
            {job.preview.zones && (
              <div className="row wrap" style={{ gap: 6 }}>
                {job.preview.zones.slice(0, 24).map((z) => <span key={z} className="badge gray">{z}</span>)}
              </div>
            )}
            {job.preview.arcs && <div className="serif" style={{ fontSize: 17, color: 'var(--gold-2)' }}>{job.preview.arcs.join('  →  ')}</div>}
            <div className="gen-log" ref={logRef}>
              {log.map((l, i) => (
                <div key={i} className={l.kind}>{l.msg}</div>
              ))}
            </div>
            <div className="hint">Generation keeps running if you leave this page. With local models this can take a while: each place, character, quest and image is made individually.</div>
          </div>
        )}

        {w.status === 'failed' && (
          <div className="panel panel-body" style={{ marginTop: 18 }}>
            <div className="error-text">Dreaming stopped{w.job?.error ? `: ${w.job.error}` : '.'}</div>
            <div className="hint" style={{ margin: '6px 0 10px' }}>Everything finished so far is kept. Resume once the model service is working again.</div>
            {(w.ownerId === me?.id || me?.isAdmin) && <button className="btn primary" onClick={() => api.resumeWorld(w.id).catch((e) => setError((e as Error).message))}>Resume dreaming</button>}
          </div>
        )}
        {w.status === 'ready' && !generating && w.job?.status === 'failed' && <div className="panel panel-body error-text" style={{ marginTop: 18 }}>The last job failed: {w.job.error ?? 'unknown error'}.</div>}

        {view && ruleset && (
          <div className="modal-wrap" onClick={() => setView(null)}>
            <div className="panel ornate modal" onClick={(e) => e.stopPropagation()}>
              <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
              <div className="panel-head">
                <h3>{view === 'codex' ? `Codex — ${ruleset.name}` : 'Balance report'}</h3>
                <div className="spacer" />
                <button className="btn ghost sm" onClick={() => setView(null)}>✕</button>
              </div>
              {view === 'codex' ? <CodexView ruleset={ruleset} /> : <BalanceReport r={ruleset} />}
            </div>
          </div>
        )}

        {w.status === 'ready' && !generating && (
          <div className="row" style={{ marginTop: 18, alignItems: 'flex-start', gap: 18 }}>
            <div className="panel grow">
              <div className="panel-head">
                <h3>Your reveries</h3>
                <div className="spacer" />
                <button className="btn primary" onClick={() => navigate(`#/world/${w.id}/new`)}>New reverie</button>
              </div>
              <div className="panel-body col">
                {!mine.length && <div className="muted">No reveries yet. Start one to create your character.</div>}
                {mine.map((s) => (
                  <div key={s.id} className="row" style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10 }}>
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{s.name} {s.snapshotOf && <span className="badge gray">memory</span>} {s.open && <span className="badge green">open</span>} <span className="badge gray">{ruleset?.difficulty[s.difficulty]?.name ?? s.difficulty}</span></div>
                      <div className="small muted">
                        Day {s.day} · {s.players.map((p) => `${p.name} (lv ${p.level})`).join(', ')} · {new Date(s.updatedAt).toLocaleString()}
                        {s.online ? ` · ${s.online} online` : ''}
                      </div>
                      {s.incompatible && <div className="tiny bad" style={{ marginTop: 3 }}>{s.incompatible}</div>}
                    </div>
                    <button className="btn primary" disabled={!!s.incompatible} onClick={() => navigate(s.players.some((p) => p.userId === me.id) ? `#/play/${s.id}` : `#/join/${w.id}/${s.id}`)}>Continue</button>
                    {s.ownerId === me.id && (
                      <button className="btn ghost sm" title="Delete reverie" onClick={() => confirm(`Delete "${s.name}"? This cannot be undone.`) && api.deleteInstance(s.id).then(() => setSaves((x) => x.filter((y) => y.id !== s.id)))}>✕</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="col" style={{ width: 340 }}>
              <RulesPanel w={w} me={me} ruleset={ruleset} canRebalance={canRebalance} hasSaves={saves.length > 0} onView={setView} />
              {joinable.length > 0 && (
                <div className="panel">
                  <div className="panel-head"><h3>Join others</h3></div>
                  <div className="panel-body col">
                    {joinable.map((s) => (
                      <div key={s.id} className="row">
                        <div className="grow small">{s.name}<div className="muted tiny">{s.players.map((p) => p.name).join(', ')}</div></div>
                        <button className="btn sm" onClick={() => navigate(`#/join/${w.id}/${s.id}`)}>Join</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {w.ownerId === me.id && (
                <div className="panel">
                  <div className="panel-head"><h3>Art</h3></div>
                  <div className="panel-body col">
                    <div className="small muted">{w.artProgress.total ? `${w.artProgress.ok} of ${w.artProgress.total} images generated.` : 'Using procedural art.'}</div>
                    <div className="row">
                      <button className="btn sm primary" onClick={() => api.regenArt(w.id, 'full', true).catch((e) => alert(e.message))}>Paint everything</button>
                    </div>
                    <div className="hint">Only paints what is missing, failed, out of date or changed. Requires an image model in config/genai.json.</div>
                    <button className="btn sm" onClick={() => navigate(`#/world/${w.id}/studio`)}>Open the daydream studio</button>
                    <div className="hint">See every place, person, quest and image with the prompts behind them; edit them and regenerate any piece.</div>
                  </div>
                </div>
              )}
              {w.ownerId === me.id && (
                <button className="btn danger sm" onClick={() => confirm('Delete this daydream, its art and its reveries? An administrator can restore it for 30 days.') && api.deleteWorld(w.id).then(() => navigate('#/'))}>Delete daydream</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


function RulesPanel({ w, me, ruleset, canRebalance, hasSaves, onView }: { w: WorldSummary; me: Me; ruleset: Ruleset | null; canRebalance: boolean; hasSaves: boolean; onView: (v: 'codex' | 'balance') => void }) {
  const owner = w.ownerId === me.id || me.isAdmin;
  const [busy, setBusy] = useState(false);
  const run = async (mode: 'regenerate' | 'rebalance') => {
    const msg = mode === 'regenerate'
      ? `Design a completely new ruleset for this daydream (classes, skills, items…)? The story, places and people stay. ${hasSaves ? 'Existing reveries will no longer be playable. ' : ''}New classes start with procedural art until you generate art again. This takes several minutes.`
      : 'Run the balance simulation again on the current rules? Numbers may change; reveries stay playable. This takes several minutes.';
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await api.regenRules(w.id, mode);
    } catch (e) {
      alert((e as Error).message);
    }
    setBusy(false);
  };
  const b = ruleset?.balance;
  return (
    <div className="panel ornate">
      <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
      <div className="panel-head"><h3>Rules</h3><div className="spacer" />{ruleset && <span className="muted small">{ruleset.name}</span>}</div>
      <div className="panel-body col">
        {!ruleset ? (
          <div className="small muted">This world was generated before rules were designed per world.{owner ? ' Generate rules to play it.' : ''}</div>
        ) : (
          <>
            {ruleset.intro && <div className="serif muted" style={{ fontSize: 15, lineHeight: 1.4 }}>{ruleset.intro}</div>}
            <div className="row wrap" style={{ gap: 4 }}>
              {ruleset.classes.map((c) => <span key={c.id} className="badge gray" title={c.description}>{c.name}</span>)}
            </div>
            <div className="tiny dim">
              {ruleset.pools.length ? `${ruleset.pools.map((p) => p.name).join(', ')} · ` : ''}{ruleset.damageTypes.map((d) => d.name).join(', ')} damage · {ruleset.attributes.length} attributes · max {ruleset.terminology.level.toLowerCase()} {ruleset.progression.maxLevel}
            </div>
            {b && (
              <div className="small">
                <span className={b.scenarios.filter((s) => s.ok).length / Math.max(1, b.scenarios.length) >= 0.75 ? 'gold' : 'bad'}>{b.scenarios.filter((s) => s.ok).length}/{b.scenarios.length}</span>
                <span className="muted"> balance targets met · {b.fights} simulated fights · {Math.round(b.durationMs / 1000)} s</span>
              </div>
            )}
            <div className="row">
              <button className="btn sm" onClick={() => onView('codex')}>Read the codex</button>
              {b && <button className="btn sm ghost" onClick={() => onView('balance')}>Balance report</button>}
            </div>
          </>
        )}
        {owner && (
          <>
            <div className="ornament" />
            <div className="row wrap">
              {ruleset && canRebalance && <button className="btn sm" disabled={busy} onClick={() => run('rebalance')}>Rebalance</button>}
              <button className="btn sm" disabled={busy} onClick={() => run('regenerate')}>{ruleset ? 'New rules' : 'Generate rules'}</button>
            </div>
            <div className="hint">New rules keep the story, places and people. Rebalancing re-runs the fight simulation on the current rules.</div>
          </>
        )}
      </div>
    </div>
  );
}

function BalanceReport({ r }: { r: Ruleset }) {
  const b = r.balance;
  if (!b) return <div className="panel-body muted">No balance report.</div>;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const range = (x: [number, number], f: (n: number) => string) => `${f(x[0])}–${f(x[1])}`;
  return (
    <div className="panel-body scroll" style={{ flex: 1 }}>
      <div className="small muted" style={{ marginBottom: 10 }}>
        {b.fights} simulated fights in {Math.round(b.durationMs / 1000)} s. Each row is a typical {r.terminology.party.toLowerCase()} against generated encounters; numbers are fitted until they land in the target band.
      </div>
      <table className="table">
        <thead>
          <tr><th>Scenario</th><th>Wins</th><th>{r.health.name} lost</th><th>Rounds</th><th /></tr>
        </thead>
        <tbody>
          {b.scenarios.map((s) => (
            <tr key={s.id} style={s.ok ? undefined : { background: 'rgba(224,96,74,.06)' }}>
              <td>{s.label}<div className="tiny dim">{r.difficulty[s.difficulty]?.name} · {r.terminology.level.toLowerCase()} {s.level} · {s.runs} runs</div></td>
              <td>{pct(s.winRate)}<div className="tiny dim">{range(s.target.winRate, pct)}</div></td>
              <td>{pct(s.hpLost)}<div className="tiny dim">{range(s.target.hpLost, pct)}</div></td>
              <td>{s.rounds.toFixed(1)}<div className="tiny dim">{range(s.target.rounds, (n) => String(n))}</div></td>
              <td>{s.ok ? <span className="badge green">ok</span> : <span className="badge red">off</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {b.classes.length > 0 && (
        <div className="col" style={{ marginTop: 14, gap: 4 }}>
          <div className="label">Class parity</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {b.classes.map((c) => (
              <span key={c.classId} className="badge gray">{r.classes.find((x) => x.id === c.classId)?.name ?? c.classId} · {pct(c.winRate)} wins</span>
            ))}
          </div>
        </div>
      )}
      {b.notes?.length ? (
        <div className="col" style={{ marginTop: 12, gap: 4 }}>
          <div className="label">Notes</div>
          {b.notes.map((n, i) => <div key={i} className="small muted">{n}</div>)}
        </div>
      ) : null}
    </div>
  );
}


/** The job's stages as a checklist: finished (with time taken), the current one (with counts), and what is next. */
export function PhaseList({ phases }: { phases: JobPhase[] }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const dur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
  return (
    <ol className="phases">
      {phases.filter((p) => p.status !== 'skipped').map((p) => (
        <li key={p.id} className={p.status}>
          <span className="mark">{p.status === 'done' ? '✓' : p.status === 'active' ? <span className="spinner" /> : ''}</span>
          <div className="grow">
            <div className="pl">
              {p.label}
              {p.total ? <span className="count">{p.done ?? 0}/{p.total}</span> : null}
            </div>
            {p.status !== 'done' && <div className="pd">{p.detail}</div>}
            {p.status === 'active' && p.total ? <div className="progress thin"><div style={{ width: `${((p.done ?? 0) / p.total) * 100}%` }} /></div> : null}
          </div>
          <span className="pt">{p.status === 'done' && p.startedAt && p.endedAt ? dur(p.endedAt - p.startedAt) : p.status === 'active' && p.startedAt ? dur(Date.now() - p.startedAt) : ''}</span>
        </li>
      ))}
    </ol>
  );
}
