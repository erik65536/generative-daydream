import { useEffect, useState } from 'react';
import { api, type Me, type WorldSummary } from '../api';
import { Backdrop, DaydreamArt } from '../ui/Backdrop';
import { navigate } from '../App';

export function TopBar({ me, onLogout }: { me: Me; onLogout?: () => void }) {
  return (
    <div className="topbar">
      <div className="brand" onClick={() => navigate('#/')}>
        <img src="/favicon.svg" alt="" />
        Generative Daydream
      </div>
      <div className="spacer" />
      <button className="btn ghost sm" onClick={() => navigate('#/settings')}>AI models</button>
      {me.isAdmin && <button className="btn ghost sm" onClick={() => navigate('#/users')}>Users</button>}
      <button className="btn ghost sm" title="Your account" onClick={() => navigate('#/account')}>{me.username}</button>
      {onLogout && (
        <button className="btn ghost sm" onClick={() => api.logout().then(onLogout)}>
          Sign out
        </button>
      )}
    </div>
  );
}

export const SIZE_LABEL: Record<string, string> = { small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge' };
export const LENGTH_LABEL: Record<string, string> = { short: 'Short', medium: 'Medium', long: 'Long', epic: 'Epic' };
export const MODE_LABEL: Record<string, string> = { solo: 'Solo hero', party_manual: 'Party (you control all)', party_npc: 'Recruit companions' };

export function Lobby({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () => api.worlds().then(setWorlds, (e) => setError(e.message));
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);
  const mine = worlds?.filter((w) => w.ownerId === me.id) ?? [];
  const others = worlds?.filter((w) => w.ownerId !== me.id) ?? [];
  return (
    <div className="page">
      <Backdrop />
      <TopBar me={me} onLogout={onLogout} />
      <div className="page-inner">
        <h1 className="h1">Daydreams</h1>
        <p className="lede">Each daydream is dreamed once — its places, people, history and secrets — and can then be lived in any number of reveries.</p>
        {error && <div className="error-text">{error}</div>}
        <div className="cards" style={{ marginTop: 22 }}>
          <div className="card new" onClick={() => navigate('#/create')}>
            <div className="col" style={{ alignItems: 'center', gap: 6 }}>
              <div className="display gold" style={{ fontSize: 40, lineHeight: 1 }}>+</div>
              <div className="display gold">Dream a new daydream</div>
              <div className="muted small">Describe a setting; the engine builds the rest.</div>
            </div>
          </div>
          {mine.map((w) => (
            <WorldCard key={w.id} w={w} />
          ))}
        </div>
        {others.length > 0 && (
          <>
            <h2 className="h2" style={{ marginTop: 40 }}>Daydreams of other dreamers</h2>
            <div className="cards" style={{ marginTop: 14 }}>
              {others.map((w) => (
                <WorldCard key={w.id} w={w} />
              ))}
            </div>
          </>
        )}
        {worlds && !worlds.length && <p className="muted" style={{ marginTop: 20 }}>No daydreams yet. Dream the first one.</p>}
      </div>
    </div>
  );
}

function WorldCard({ w }: { w: WorldSummary }) {
  return (
    <div className="card" onClick={() => navigate(`#/world/${w.id}`)}>
      <div className="art">
        <DaydreamArt id={w.id} palette={w.palette} art={w.coverArt} />
      </div>
      <div className="body">
        <div className="title">{w.title}</div>
        <div className="pitch">{w.pitch}</div>
        <div className="meta">
          {w.status === 'generating' && <span className="badge">Dreaming… {Math.round((w.job?.progress ?? 0) * 100)}%</span>}
          {w.status === 'failed' && <span className="badge red">Failed</span>}
          <span className="badge gray">{SIZE_LABEL[w.input.size]}</span>
          <span className="badge gray">{LENGTH_LABEL[w.input.length]}</span>
          <span className="badge gray">{MODE_LABEL[w.input.combatMode]}</span>
          {w.status === 'ready' && <span className="badge gray">{w.zones} places · {w.npcs} people · {w.quests} quests</span>}
          {w.status === 'ready' && (w.rules ? <span className="badge" title={w.rules.classes.join(', ')}>{w.rules.name}</span> : <span className="badge red" title="Generate this daydream's rules on its page to play it.">Needs rules</span>)}
        </div>
      </div>
    </div>
  );
}
