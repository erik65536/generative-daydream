import { useEffect, useState } from 'react';
import { api, type Me } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';

type GenaiInfo = Awaited<ReturnType<typeof api.genai>>;

const PURPOSE_HELP: Record<string, string> = {
  'world.design': 'Concept, map, main story, monsters. Use your smartest model.',
  'world.content': 'Towns, residents, side quests, lore, names. Many calls.',
  'npc.decision': 'What a person does and says in each turn of a conversation (structured output). Latency matters.',
  narration: 'Short flavour text, and the legends of top-rarity items.',
  'image.sprite': 'Characters, creatures and the objects drawn over places.',
  'image.icon': 'Item icons (full art mode).',
  'image.check': 'Scores generated images and checks painted places (a decision model).',
  'image.prompt': 'Writes the Krea prompt of every character, creature, object and icon, and picks its chroma-key backdrop.',
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
        <p className="lede">Each part of the engine uses a configured model: OpenAI for text, decisions and speech, ComfyUI behind the GPU broker for images. Edit <code>config/genai.json</code> (copy <code>config/genai.example.json</code>), then reload.</p>
        <div className="row" style={{ marginTop: 10 }}>
          {me.isAdmin ? <button className="btn" onClick={() => api.genaiReload().then(load).catch((e) => alert(e.message))}>Reload config</button> : <span className="muted small">Only the administrator can test or reload models.</span>}
          <span className="muted small">{info?.configFile ? `Using ${info.configFile}` : 'No config/genai.json: no daydream can be built, and people answer with simple stock replies.'}</span>
        </div>
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
                    <td>{p.provider} <span className="badge gray">{p.type}</span></td>
                    <td className="small">{p.model ?? '—'}</td>
                    <td>
                      {me.isAdmin && p.type !== 'not configured' && <button className="btn sm" disabled={r?.busy} onClick={() => test(p.purpose)}>{r?.busy ? 'Testing…' : 'Test'}</button>}
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
