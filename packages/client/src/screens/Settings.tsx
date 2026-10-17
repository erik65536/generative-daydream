import { useEffect, useState } from 'react';
import { api, type Me } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';

type GenaiInfo = Awaited<ReturnType<typeof api.genai>>;

const PURPOSE_HELP: Record<string, string> = {
  'world.design': 'Concept, map, main story, monsters. Use your smartest model.',
  'world.content': 'Towns, residents, side quests, tilesets, names. Many calls.',
  'npc.decision': 'Runtime NPC choice of actions + speech (structured JSON), or a decision model that picks actions while the LLM speaks.',
  'npc.dialogue': 'Optional separate speech model (used when combineNpcDecisionAndDialogue is false).',
  narration: 'Short flavor text.',
  'image.texture': 'Ground and wall textures.',
  'image.sprite': 'Characters, monsters and props.',
  'image.icon': 'Item icons (full art mode).',
  'image.check': 'Scores generated images and triggers regeneration (a vision LLM or a decision model).',
  'image.prompt': 'Writes long descriptive prompts for image models that want them (Qwen Image, Flux, Krea).',
};

export function Settings({ me }: { me: Me }) {
  const [info, setInfo] = useState<GenaiInfo | null>(null);
  const [results, setResults] = useState<Record<string, { busy?: boolean; text?: string; image?: string; error?: string; ms?: number }>>({});
  const load = () => api.genai().then(setInfo);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const test = async (purpose: string) => {
    setResults((r) => ({ ...r, [purpose]: { busy: true } }));
    try {
      const out = await api.genaiTest(purpose);
      setResults((r) => ({ ...r, [purpose]: { text: out.text ?? (out.json ? JSON.stringify(out.json) : out.error), image: out.image, error: out.ok ? undefined : out.error, ms: out.ms } }));
    } catch (e) {
      setResults((r) => ({ ...r, [purpose]: { error: (e as Error).message } }));
    }
  };
  return (
    <div className="page">
      <Backdrop />
      <TopBar me={me} />
      <div className="page-inner">
        <h1 className="h1">AI models</h1>
        <p className="lede">Each part of the engine uses a configurable model. Edit <code>config/genai.json</code> (copy <code>config/genai.example.json</code>), then reload. Anything set to <code>procedural</code> uses the built-in generators.</p>
        <div className="row" style={{ marginTop: 10 }}>
          {me.isAdmin ? <button className="btn" onClick={() => api.genaiReload().then(load).catch((e) => alert(e.message))}>Reload config</button> : <span className="muted small">Only the administrator can test or reload models.</span>}
          <span className="muted small">{info?.configFile ? `Using ${info.configFile}` : 'No config/genai.json — everything is procedural.'}</span>
        </div>
        {!!info?.gpu.length && (
          <div className="panel" style={{ marginTop: 16, padding: '12px 16px' }}>
            <div className="row" style={{ gap: 14 }}>
              <b>Shared GPU</b>
              {info.gpu.map((g) => (
                <span key={g.group} className="small">
                  <span className="badge gray">{g.group}</span> {g.resident ? <>loaded: <b>{g.resident}</b></> : <span className="muted">nothing loaded</span>} <span className="dim">· {g.switches} model switches</span>
                </span>
              ))}
              <div className="spacer" />
              {me.isAdmin && <button className="btn sm" onClick={() => api.genaiRelease().then(load)}>Unload now</button>}
            </div>
            <div className="tiny muted" style={{ marginTop: 4 }}>Providers in the same GPU group run one at a time; the engine unloads one model before using another.</div>
          </div>
        )}
        <div className="panel" style={{ marginTop: 16 }}>
          <table className="table">
            <thead>
              <tr><th>Purpose</th><th>Provider</th><th>Model</th><th style={{ width: 360 }}>Test</th></tr>
            </thead>
            <tbody>
              {info?.purposes.map((p) => {
                const r = results[p.purpose];
                return (
                  <tr key={p.purpose}>
                    <td><div style={{ fontWeight: 600 }}>{p.purpose}</div><div className="tiny muted">{PURPOSE_HELP[p.purpose]}</div></td>
                    <td>{p.provider} <span className="badge gray">{p.type}</span>{p.gpu && <span className="badge gray" title="GPU group">gpu: {p.gpu}</span>}</td>
                    <td className="small">{p.model ?? '—'}</td>
                    <td>
                      {me.isAdmin && p.type !== 'procedural' && <button className="btn sm" disabled={r?.busy} onClick={() => test(p.purpose)}>{r?.busy ? 'Testing…' : 'Test'}</button>}
                      {r && !r.busy && (
                        <div className="small" style={{ marginTop: 6, color: r.error ? 'var(--danger)' : 'var(--good)', wordBreak: 'break-word' }}>
                          {r.ms !== undefined && <span className="dim">{(r.ms / 1000).toFixed(1)}s · </span>}
                          {r.error ?? r.text}
                          {r.image && <img src={r.image} style={{ display: 'block', maxWidth: 160, marginTop: 6, borderRadius: 6 }} />}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h2 className="h2" style={{ marginTop: 26 }}>Recent calls</h2>
        <div className="panel" style={{ marginTop: 10 }}>
          <table className="table">
            <thead><tr><th>When</th><th>Purpose</th><th>Provider</th><th>Time</th><th>Result</th></tr></thead>
            <tbody>
              {info?.recent.map((c, i) => (
                <tr key={i}>
                  <td className="small">{new Date(c.at).toLocaleTimeString()}</td>
                  <td>{c.purpose}</td>
                  <td>{c.provider}</td>
                  <td>{(c.ms / 1000).toFixed(1)}s</td>
                  <td className="small" style={{ color: c.ok ? 'var(--good)' : 'var(--danger)' }}>{c.ok ? `ok${c.attempt > 1 ? ` (attempt ${c.attempt})` : ''}` : c.error}</td>
                </tr>
              ))}
              {!info?.recent.length && <tr><td colSpan={5} className="muted">No model calls yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
