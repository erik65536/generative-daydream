import { useEffect, useRef, useState } from 'react';
import type { InstanceSummary } from '@gd/shared';
import { api, type JobStatus, type Me, type WorldSummary } from '../api';
import { Backdrop, WorldArt } from '../ui/Backdrop';
import { LENGTH_LABEL, MODE_LABEL, SIZE_LABEL, TopBar } from './Lobby';
import { navigate } from '../App';

export function WorldPage({ me, worldId }: { me: Me; worldId: string }) {
  const [w, setW] = useState<WorldSummary | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [log, setLog] = useState<JobStatus['log']>([]);
  const [saves, setSaves] = useState<InstanceSummary[]>([]);
  const [error, setError] = useState('');
  const since = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const ws = await api.world(worldId);
        if (!alive) return;
        setW(ws);
        if (ws.status === 'generating' || ws.job?.status === 'running') {
          const j = await api.job(worldId, since.current);
          if (!alive) return;
          setJob(j);
          if (j.log.length) {
            since.current = j.log[j.log.length - 1]!.t;
            setLog((l) => [...l, ...j.log].slice(-400));
          }
        } else {
          setJob(null);
          if (ws.status === 'ready') setSaves(await api.instances(worldId));
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
  const generating = w.status === 'generating' || job?.status === 'running';
  const mine = saves.filter((s) => s.ownerId === me.id || s.players.some((p) => p.userId === me.id));
  const joinable = saves.filter((s) => s.open && !s.players.some((p) => p.userId === me.id));
  return (
    <div className="page">
      <Backdrop palette={w.palette} />
      <TopBar me={me} />
      <div className="page-inner">
        <div className="panel" style={{ overflow: 'hidden' }}>
          <div style={{ height: 180, position: 'relative' }}>
            <WorldArt id={w.id} palette={w.palette} height={180} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(transparent 30%, rgba(14,11,18,.95))' }} />
            <div style={{ position: 'absolute', left: 24, bottom: 16, right: 24 }}>
              <div className="h1" style={{ marginBottom: 2 }}>{job?.preview.title ?? w.title}</div>
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="badge gray">{SIZE_LABEL[w.input.size]} world</span>
                <span className="badge gray">{LENGTH_LABEL[w.input.length]} story</span>
                <span className="badge gray">{MODE_LABEL[w.input.combatMode]}</span>
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
              <div className="display gold" style={{ fontSize: 16 }}>{job.step || 'Dreaming…'}</div>
              <div className="spacer" />
              <span className="muted small">{Math.round(job.progress * 100)}%</span>
              {w.ownerId === me.id && <button className="btn sm danger" onClick={() => api.cancelJob(worldId)}>Stop</button>}
            </div>
            <div className="progress"><div style={{ width: `${job.progress * 100}%` }} /></div>
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
            <div className="hint">Generation keeps running if you leave this page. With local models this can take a while — each place, character and quest is written individually.</div>
          </div>
        )}

        {w.status === 'failed' && <div className="panel panel-body error-text" style={{ marginTop: 18 }}>Generation failed. Check the server log for details.</div>}

        {w.status === 'ready' && !generating && (
          <div className="row" style={{ marginTop: 18, alignItems: 'flex-start', gap: 18 }}>
            <div className="panel grow">
              <div className="panel-head">
                <h3>Your journeys</h3>
                <div className="spacer" />
                <button className="btn primary" onClick={() => navigate(`#/world/${w.id}/new`)}>New journey</button>
              </div>
              <div className="panel-body col">
                {!mine.length && <div className="muted">No saves yet. Start a new journey to create your character.</div>}
                {mine.map((s) => (
                  <div key={s.id} className="row" style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10 }}>
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{s.name} {s.snapshotOf && <span className="badge gray">hard save</span>} {s.open && <span className="badge green">open</span>} {s.keepRunning && <span className="badge">keeps running</span>}</div>
                      <div className="small muted">
                        Day {s.day} · {s.players.map((p) => `${p.name} (lv ${p.level})`).join(', ')} · {new Date(s.updatedAt).toLocaleString()}
                        {s.online ? ` · ${s.online} online` : ''}
                      </div>
                    </div>
                    <button className="btn primary" onClick={() => navigate(s.players.some((p) => p.userId === me.id) ? `#/play/${s.id}` : `#/join/${w.id}/${s.id}`)}>Continue</button>
                    {s.ownerId === me.id && (
                      <button className="btn ghost sm" title="Delete save" onClick={() => confirm(`Delete "${s.name}"? This cannot be undone.`) && api.deleteInstance(s.id).then(() => setSaves((x) => x.filter((y) => y.id !== s.id)))}>✕</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="col" style={{ width: 340 }}>
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
                  <div className="panel-head"><h3>World art</h3></div>
                  <div className="panel-body col">
                    <div className="small muted">{w.artProgress.total ? `${w.artProgress.ok} of ${w.artProgress.total} images generated.` : 'Using procedural art.'}</div>
                    <div className="row">
                      <button className="btn sm" onClick={() => api.regenArt(w.id, 'essential').catch((e) => alert(e.message))}>Generate art</button>
                      <button className="btn sm" onClick={() => api.regenArt(w.id, 'full', true).catch((e) => alert(e.message))}>Everything + retry failed</button>
                    </div>
                    <div className="hint">Requires an image model in config/genai.json.</div>
                  </div>
                </div>
              )}
              {w.ownerId === me.id && (
                <button className="btn danger sm" onClick={() => confirm('Delete this world and its art? Saves will stop working.') && api.deleteWorld(w.id).then(() => navigate('#/'))}>Delete world</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
