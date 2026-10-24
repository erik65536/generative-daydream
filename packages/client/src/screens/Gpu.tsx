import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type ComfyPromptView, type GpuJob, type GpuTag, type GpuView, type Me } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';

/** How long ago / for how long, in a few characters. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const ROLE: Record<string, { label: string; cls: string; title: string }> = {
  server: { label: 'server', cls: 'gray', title: 'The web server process' },
  worker: { label: 'worker', cls: 'green', title: 'The job worker process' },
  cli: { label: 'CLI run', cls: '', title: 'A command-line run outside the server: only its ComfyUI prompts can be controlled here' },
  animator: { label: 'animator', cls: 'green', title: "The animator's Python step" },
  untagged: { label: 'CLI? untagged', cls: 'red', title: 'Queued by a Generative Daydream process on older code (most likely a CLI run): only ComfyUI-level controls' },
  unknown: { label: 'CLI? unregistered', cls: 'red', title: 'A process that does not report itself (older code, most likely a CLI run)' },
  external: { label: 'external', cls: 'red', title: 'Queued outside Generative Daydream' },
};
const Role = ({ role }: { role: string }) => {
  const r = ROLE[role] ?? { label: role, cls: 'gray', title: '' };
  return <span className={`badge ${r.cls}`} title={r.title}>{r.label}</span>;
};

const KIND: Record<string, string> = { world: 'world build', rules: 'rules', art: 'art', studio: 'studio', animate: 'animation', cli: 'CLI job' };

function Panel({ title, right, wide, children }: { title: string; right?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`panel gpu-panel${wide ? ' wide' : ''}`}>
      <div className="panel-head"><h3>{title}</h3><div className="spacer" />{right}</div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

function Bar({ frac, color }: { frac: number; color?: string }) {
  return <div className="budget-bar"><div style={{ width: `${Math.min(100, Math.max(0, frac * 100))}%`, background: color ?? 'var(--gold)' }} /></div>;
}

const Empty = ({ children }: { children: ReactNode }) => <div className="muted small">{children}</div>;

/** Administrators see and control everything that uses the GPU: jobs, each process's GPU work, ComfyUI's queue. */
export function GpuAdmin({ me }: { me: Me }) {
  const [view, setView] = useState<GpuView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const fresh = useRef(false);
  const load = () =>
    api.gpu(fresh.current).then(
      (v) => {
        fresh.current = false;
        setView(v);
        setError('');
      },
      (e) => setError((e as Error).message),
    );
  useEffect(() => {
    if (!me.isAdmin) return;
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  /** Run an action (after a confirmation for destructive ones), then refresh. */
  const act = async (fn: () => Promise<unknown>, confirmText?: string, done?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      if (done) setNotice(done);
      fresh.current = true;
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!me.isAdmin) return <div className="page"><Backdrop /><TopBar me={me} /><div className="page-inner">Administrators only.</div></div>;

  const v = view;
  const now = v?.now ?? Date.now();
  const jobById = new Map([...(v?.jobs.running ?? []), ...(v?.jobs.queued ?? [])].map((j) => [j.id, j]));
  const describeTag = (t?: GpuTag) => {
    if (!t) return <span className="muted">no job</span>;
    const j = t.jobId ? jobById.get(t.jobId) : undefined;
    return (
      <span>
        {KIND[t.kind ?? ''] ?? t.kind ?? 'work'} · <b>{j?.world ?? t.worldId ?? '—'}</b>
        {j && <span className="muted"> · {j.step}</span>}
      </span>
    );
  };
  const cli = (v?.processes ?? []).filter((p) => p.role === 'cli' && !p.stale);
  // A process that stopped without saying so (killed) is shown faded under Processes, not as live work.
  const builds = (v?.processes ?? []).filter((p) => !p.stale).flatMap((p) => p.state.builds.map((b) => ({ ...b, process: p })));
  const vram = v?.device ? v.device.vramUsedMb / Math.max(1, v.device.vramTotalMb) : 0;

  const jobControls = (j: GpuJob, i: number, list: GpuJob[]) => (
    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
      {j.status === 'queued' && (
        <>
          <button className="btn sm" disabled={busy || i === 0} title="Move up" onClick={() => act(() => api.gpuPriority(j.id, { move: 'up' }))}>↑</button>
          <button className="btn sm" disabled={busy || i === list.length - 1} title="Move down" onClick={() => act(() => api.gpuPriority(j.id, { move: 'down' }))}>↓</button>
        </>
      )}
      <button
        className="btn sm danger"
        disabled={busy || j.cancelRequested}
        onClick={() =>
          act(
            () => api.gpuCancel(j.id),
            j.status === 'queued'
              ? `Cancel the queued ${KIND[j.kind]} job for "${j.world}" (${j.owner})?`
              : `Stop the running ${KIND[j.kind]} job for "${j.world}" (${j.owner})?\n\nIt stops at its next check, its ComfyUI prompts are removed or interrupted, and what it finished is kept for a later resume.`,
            j.status === 'queued' ? 'Job cancelled.' : 'Job asked to stop.',
          )
        }
      >
        {j.cancelRequested ? 'Stopping…' : j.status === 'queued' ? 'Cancel' : 'Stop'}
      </button>
    </div>
  );

  const promptRow = (p: ComfyPromptView, running: boolean) => (
    <tr key={p.id}>
      <td className="small">{running ? <span className="badge green">running</span> : <span className="muted">#{p.number}</span>}</td>
      <td><Role role={p.origin.kind} /></td>
      <td className="small">
        {p.origin.jobId || p.origin.worldId ? describeTag({ jobId: p.origin.jobId, worldId: p.origin.worldId, kind: p.origin.jobKind }) : <span className="muted">{p.origin.label}</span>}
        {(p.origin.kind === 'cli' || p.origin.kind === 'worker' || p.origin.kind === 'server') && <div className="dim">{p.origin.label}</div>}
      </td>
      <td className="small">{p.workflow}</td>
      <td className="small dim" title={p.id}>{p.id.slice(0, 8)}</td>
      <td style={{ textAlign: 'right' }}>
        <button
          className="btn sm danger"
          disabled={busy}
          onClick={() => act(() => api.gpuClearPrompt(p.id), `${running ? 'Interrupt the running' : 'Remove the pending'} ComfyUI prompt ${p.id.slice(0, 8)} (${p.workflow}, ${ROLE[p.origin.kind]?.label ?? p.origin.kind})?${p.origin.kind === 'cli' || p.origin.kind === 'untagged' ? '\n\nIt belongs to a CLI run: that run sees a failed step and may retry or stop.' : ''}`, running ? 'Prompt interrupted.' : 'Prompt removed.')}
        >
          {running ? 'Interrupt' : 'Remove'}
        </button>
      </td>
    </tr>
  );

  return (
    <div className="page">
      <Backdrop />
      <TopBar me={me} />
      <div className="page-inner gpu-page">
        <h1 className="h1">GPU</h1>
        <p className="lede">Everything that uses the GPU: jobs waiting and running in the server and the worker, command-line runs, and ComfyUI's own queue. It refreshes every 2 seconds.</p>

        <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
          <button
            className={`btn ${v?.control.paused ? 'primary' : ''}`}
            disabled={busy || !v}
            onClick={() => (v?.control.paused ? act(() => api.gpuPause('all', false), undefined, 'GPU work resumed.') : act(() => api.gpuPause('all', true), 'Pause all new GPU work?\n\nNo new jobs start, and jobs running now wait before their next GPU step (the step in progress finishes). Players’ own conversations still go ahead.', 'GPU work paused.'))}
          >
            {v?.control.paused ? 'Resume GPU work' : 'Pause GPU work'}
          </button>
          <button
            className={`btn ${v?.control.animationPaused ? 'primary' : ''}`}
            disabled={busy || !v}
            onClick={() => act(() => api.gpuPause('animation', !v?.control.animationPaused), undefined, v?.control.animationPaused ? 'Animation resumed.' : 'Background animation paused.')}
          >
            {v?.control.animationPaused ? 'Resume animation' : 'Pause animation'}
          </button>
          <button className="btn danger" disabled={busy || !v} onClick={() => act(() => api.gpuUnload(), 'Unload every model on the GPU (ComfyUI and the local LLM servers)?\n\nWork in progress reloads what it needs, which takes time.', 'Models unloaded.')}>
            Unload models
          </button>
          <div className="spacer" />
          {notice && <span className="small muted">{notice}</span>}
          {error && <span className="error-text">{error}</span>}
        </div>
        {(v?.control.paused || v?.control.animationPaused) && (
          <div className="studio-ai small" style={{ marginTop: 10 }}>
            {v.control.paused && <div>New GPU work paused by <b>{v.control.paused.by}</b> at {clock(v.control.paused.at)}. Running jobs wait before their next GPU step.</div>}
            {v.control.animationPaused && <div>Background animation paused by <b>{v.control.animationPaused.by}</b> at {clock(v.control.animationPaused.at)}.</div>}
          </div>
        )}

        {!v ? (
          <div className="center" style={{ padding: 40 }}><div className="spinner" /></div>
        ) : (
          <div className="gpu-grid">
            <Panel title="On the GPU now" right={v.device && <span className="small muted">{v.device.name}</span>}>
              {v.device ? (
                <div className="col" style={{ gap: 4, marginBottom: 12 }}>
                  <div className="row small">
                    <span>VRAM {(v.device.vramUsedMb / 1024).toFixed(1)} of {(v.device.vramTotalMb / 1024).toFixed(1)} GB</span>
                    <div className="spacer" />
                    {v.device.utilization !== undefined && <span className="muted">{v.device.utilization}% busy</span>}
                    <span className="dim">via {v.device.source}</span>
                  </div>
                  <Bar frac={vram} color={vram > 0.92 ? 'var(--danger)' : vram > 0.7 ? 'var(--gold)' : 'var(--good)'} />
                </div>
              ) : (
                <Empty>GPU memory unknown (no nvidia-smi, and ComfyUI is not answering).</Empty>
              )}
              {!v.groups.length && <Empty>No GPU groups configured.</Empty>}
              {v.groups.map((g) => (
                <div key={g.group} className="gpu-group">
                  <div className="row small wrap" style={{ gap: 8 }}>
                    <span className="badge gray">{g.group}</span>
                    {g.holder ? (
                      <>
                        <span>held by</span> <Role role={g.holder.role} /> <span className="muted">{g.holder.label}</span>
                      </>
                    ) : (
                      <span className="muted">free</span>
                    )}
                    {g.lastModel && <span className="dim">· last model <b className="muted">{g.lastModel}</b></span>}
                  </div>
                  {g.running.map((c, i) => (
                    <div key={i} className="gpu-running">
                      <div className="row small" style={{ gap: 8 }}>
                        <span className="badge green">running</span>
                        <b>{c.model}</b>
                        <span className="dim">{c.provider}</span>
                        <div className="spacer" />
                        <span className="muted">{ago(now - c.since)}</span>
                      </div>
                      <div className="small" style={{ marginTop: 4 }}>{describeTag(c.tag)} <span className="dim">· {c.process}</span></div>
                    </div>
                  ))}
                  {!g.running.length && g.holder && <div className="small dim" style={{ marginTop: 4 }}>No call reported running (a process on older code reports none).</div>}
                  {!!g.routerLoaded.length && <div className="small muted" style={{ marginTop: 4 }}>LLM router has loaded: {g.routerLoaded.join(', ')}</div>}
                  {!!g.waiting.length && (
                    <div className="small" style={{ marginTop: 4 }}>
                      Waiting for it:{' '}
                      {g.waiting.map((w) => (
                        <span key={w.holder} className="muted">{w.label} (rank {w.rank}, {ago(now - w.since)}) </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </Panel>

            <Panel title="Throughput">
              <div className="gpu-stats">
                <Stat label="ComfyUI prompts / last hour" value={v.throughput.comfyPromptsLastHour ?? '—'} />
                <Stat label="Images / last hour" value={v.throughput.imagesLastHour ?? '—'} />
                <Stat label="Actors / hour (6h)" value={v.throughput.actorsPerHour} />
                <Stat label="Jobs done (24h)" value={v.throughput.jobsDone24h} />
                <Stat label="Failed (24h)" value={v.throughput.jobsFailed24h} warn={v.throughput.jobsFailed24h > 0} />
                <Stat label="Cancelled (24h)" value={v.throughput.jobsCancelled24h} />
              </div>
            </Panel>

            <Panel title={`Running jobs · ${v.jobs.running.length}`} wide>
              {!v.jobs.running.length ? (
                <Empty>No server job is running.</Empty>
              ) : (
                <table className="table">
                  <thead><tr><th>Job</th><th>Daydream</th><th>Owner</th><th>Step</th><th>Elapsed</th><th>Where</th><th /></tr></thead>
                  <tbody>
                    {v.jobs.running.map((j, i, list) => (
                      <tr key={j.id}>
                        <td>{KIND[j.kind]}{j.status === 'waiting' && <> <span className="badge gray">waiting</span></>}<div className="dim small">{j.id}</div></td>
                        <td>{j.world}</td>
                        <td className="small">{j.owner}</td>
                        <td className="small" style={{ minWidth: 200 }}>{j.step}<Bar frac={j.progress} /></td>
                        <td className="small">{j.startedAt ? ago(now - j.startedAt) : '—'}{j.attempts > 1 && <div className="dim">start {j.attempts}</div>}</td>
                        <td className="small muted">{j.worker}</td>
                        <td>{jobControls(j, i, list)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title={`Waiting · ${v.jobs.queued.length}`} wide right={<span className="hint">Lower priority runs first. Animation runs at 8, behind everything else.</span>}>
              {!v.jobs.queued.length ? (
                <Empty>Nothing waiting.</Empty>
              ) : (
                <table className="table">
                  <thead><tr><th>#</th><th>Job</th><th>Daydream</th><th>Owner</th><th>Priority</th><th>Queued</th><th /></tr></thead>
                  <tbody>
                    {v.jobs.queued.map((j, i, list) => (
                      <tr key={j.id}>
                        <td className="small muted">{i + 1}</td>
                        <td>{KIND[j.kind]}<div className="dim small">{j.id}</div></td>
                        <td>{j.world}</td>
                        <td className="small">{j.owner}</td>
                        <td><PriorityCell value={j.priority} disabled={busy} onSet={(p) => act(() => api.gpuPriority(j.id, { priority: p }))} /></td>
                        <td className="small muted">{ago(now - j.createdAt)} ago</td>
                        <td>{jobControls(j, i, list)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!!builds.length && (
                <div className="col" style={{ gap: 6, marginTop: 12 }}>
                  <div className="label">Inside builds: their GPU queues</div>
                  {builds.map((b, i) => (
                    <div key={i} className="small gpu-build">
                      {describeTag(b.tag)} <Role role={b.process.role} />{' '}
                      {b.running && <span className="badge green">{b.running.model} · place {b.running.priority}</span>}{' '}
                      {b.pending.map((t, k) => <span key={k} className="badge gray">{t.model} · place {t.priority}</span>)}
                      {!b.pending.length && <span className="dim">nothing else queued</span>}
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title={`ComfyUI · ${v.comfy.running.length} running, ${v.comfy.pending.length} pending`} wide right={<span className="small dim">{v.comfy.url}</span>}>
              {!v.comfy.up ? (
                <div className="error-text">ComfyUI is not answering ({v.comfy.error}).</div>
              ) : !v.comfy.running.length && !v.comfy.pending.length ? (
                <Empty>ComfyUI's queue is empty.</Empty>
              ) : (
                <table className="table">
                  <thead><tr><th /><th>From</th><th>For</th><th>Models</th><th>Prompt</th><th /></tr></thead>
                  <tbody>
                    {v.comfy.running.map((p) => promptRow(p, true))}
                    {v.comfy.pending.map((p) => promptRow(p, false))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title={`Command-line runs · ${cli.length}`}>
              {!cli.length ? (
                <Empty>No CLI run is reporting. Runs on older code do not report: their ComfyUI prompts show as untagged.</Empty>
              ) : (
                <div className="col" style={{ gap: 8 }}>
                  {cli.map((p) => (
                    <div key={p.holder} className="gpu-build">
                      <div className="row small" style={{ gap: 8 }}><Role role="cli" /><b>{p.label}</b><div className="spacer" /><span className="dim">pid {p.pid} · up {ago(now - p.startedAt)}</span></div>
                      {p.state.tasks.map((t, i) => (
                        <div key={i} className="small" style={{ marginTop: 4 }}>{t.tag.worldId}: {t.step} <span className="dim">({Math.round(t.progress * 100)}%, {ago(now - t.since)})</span></div>
                      ))}
                      {p.state.calls.filter((c) => c.running).map((c, i) => <div key={i} className="small muted">on the GPU: {c.model}, {ago(now - c.since)}</div>)}
                    </div>
                  ))}
                  <div className="hint">CLI runs are outside the job queue: stop them in their terminal. Their ComfyUI prompts can be removed or interrupted above.</div>
                </div>
              )}
            </Panel>

            <Panel title="Animation">
              {!v.animation.length ? (
                <Empty>No actor waiting or failed.</Empty>
              ) : (
                <div className="col" style={{ gap: 10 }}>
                  {v.animation.map((a) => (
                    <div key={a.worldId}>
                      <div className="row small"><b>{a.title}</b><div className="spacer" /><span className="muted">{a.waiting} waiting · {a.failed.length} failed</span></div>
                      {a.failed.map((f) => (
                        <div key={f.key} className="row small" style={{ gap: 8, marginTop: 4 }}>
                          <span className="badge red">failed</span>
                          <span>{f.key}</span>
                          <span className="dim gpu-ellipsis" title={f.error}>{f.error}</span>
                          <div className="spacer" />
                          <button className="btn sm" disabled={busy} onClick={() => act(() => api.gpuRetryActor(a.worldId, f.key), undefined, `Retrying ${f.key}.`)}>Retry</button>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Recently finished" wide>
              <table className="table">
                <thead><tr><th>Job</th><th>Daydream</th><th>Owner</th><th>Outcome</th><th>Took</th><th>Ended</th></tr></thead>
                <tbody>
                  {v.jobs.recent.slice(0, 15).map((j) => (
                    <tr key={j.id}>
                      <td>{KIND[j.kind]}</td>
                      <td>{j.world}</td>
                      <td className="small">{j.owner}</td>
                      <td className="small">
                        <span className={`badge ${j.status === 'done' ? 'green' : j.status === 'failed' ? 'red' : 'gray'}`}>{j.status}</span>
                        {j.error && <div className="error-text small gpu-ellipsis" title={j.error}>{j.error}</div>}
                      </td>
                      <td className="small muted">{j.startedAt && j.finishedAt ? ago(j.finishedAt - j.startedAt) : '—'}</td>
                      <td className="small muted">{j.finishedAt ? `${ago(now - j.finishedAt)} ago` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!!v.comfy.failures.length && (
                <div className="col" style={{ gap: 4, marginTop: 12 }}>
                  <div className="label">ComfyUI failures</div>
                  {v.comfy.failures.map((f) => (
                    <div key={f.id} className="row small" style={{ gap: 8 }}>
                      <Role role={f.origin.kind} />
                      <span>{f.workflow}</span>
                      <span className="error-text gpu-ellipsis" title={f.message}>{f.message}</span>
                      <div className="spacer" />
                      <span className="dim">{f.at ? `${ago(now - f.at)} ago` : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Processes">
              <div className="col" style={{ gap: 6 }}>
                {v.processes.map((p) => (
                  <div key={p.holder} className="row small" style={{ gap: 8, opacity: p.stale ? 0.5 : 1 }}>
                    <Role role={p.role} />
                    <span>{p.label}{p.isThis && <span className="dim"> (answering this page)</span>}</span>
                    <div className="spacer" />
                    <span className="dim">{p.stale ? `silent for ${ago(now - p.seen)}` : `pid ${p.pid} · up ${ago(now - p.startedAt)}`}</span>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Admin log">
              {!v.audit.length ? (
                <Empty>No administrator action yet.</Empty>
              ) : (
                <div className="col" style={{ gap: 4 }}>
                  {v.audit.slice(0, 12).map((a, i) => (
                    <div key={i} className="small">
                      <span className="dim">{clock(a.at)}</span> <b>{a.adminName}</b> {a.action} <span className="muted">{a.target}</span>{a.detail && <span className="dim"> · {a.detail}</span>}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: ReactNode; warn?: boolean }) {
  return (
    <div className="gpu-stat">
      <div className="gpu-stat-value" style={warn ? { color: 'var(--danger)' } : undefined}>{value}</div>
      <div className="dim small">{label}</div>
    </div>
  );
}

/** A queued job's priority, edited in place (Enter or leaving the field sets it). */
function PriorityCell({ value, disabled, onSet }: { value: number; disabled: boolean; onSet: (p: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 99) return setV(String(value));
    if (n !== value) onSet(n);
  };
  return <input className="input" style={{ width: 52, padding: '3px 6px' }} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} title="Priority: lower runs first (0-99)" />;
}
