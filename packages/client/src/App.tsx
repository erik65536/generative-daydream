import { Component, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from './api';
import { AuthScreen, InviteScreen } from './screens/Auth';
import { Account, Users } from './screens/Account';
import { Lobby } from './screens/Lobby';
import { CreateWorld } from './screens/CreateWorld';
import { WorldPage } from './screens/WorldPage';
import { Studio } from './screens/Studio';
import { CharacterCreate } from './screens/CharacterCreate';
import { Settings } from './screens/Settings';
import { GpuAdmin } from './screens/Gpu';
import { GameScreen } from './screens/Game';
import { TooltipHost } from './ui/common';

export function navigate(hash: string) {
  location.hash = hash;
}

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error('[ui] crashed', error);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center col" style={{ height: '100%', gap: 14 }}>
        <div className="display gold" style={{ fontSize: 22 }}>Something went wrong</div>
        <div className="muted small" style={{ maxWidth: 520, textAlign: 'center' }}>{this.state.error.message}</div>
        <div className="row">
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          <button className="btn ghost" onClick={() => { location.hash = '#/'; location.reload(); }}>Back to daydreams</button>
        </div>
      </div>
    );
  }
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const hash = useHash();
  useEffect(() => {
    // Only a real 401 means signed out; while the server is unreachable (e.g. restarting), keep retrying.
    let stop = false;
    let delay = 500;
    const attempt = () =>
      api.me().then(
        (m) => !stop && setMe(m),
        (e) => {
          if (stop) return;
          if (e instanceof ApiError && e.status === 401) return setMe(null);
          setTimeout(attempt, (delay = Math.min(5000, delay * 1.6)));
        },
      );
    attempt();
    return () => {
      stop = true;
    };
  }, []);
  if (me === undefined)
    return (
      <div className="center" style={{ height: '100%' }}>
        <div className="spinner" />
      </div>
    );
  const parts = hash.replace(/^#\/?/, '').split('/');
  // An invite link sets up its account, whoever is signed in on this browser.
  if (parts[0] === 'invite' && parts[1]) return <InviteScreen code={decodeURIComponent(parts[1])} onAuthed={setMe} />;
  if (!me) return <AuthScreen onAuthed={setMe} />;
  let screen;
  switch (parts[0]) {
    case 'create':
      screen = <CreateWorld me={me} />;
      break;
    case 'world':
      screen = parts[2] === 'new' ? <CharacterCreate me={me} worldId={parts[1]!} /> : parts[2] === 'studio' ? <Studio me={me} worldId={parts[1]!} /> : <WorldPage me={me} worldId={parts[1]!} />;
      break;
    case 'join':
      screen = <CharacterCreate me={me} worldId={parts[1]!} joinInstanceId={parts[2]} />;
      break;
    case 'play':
      screen = <GameScreen key={parts[1]} me={me} instanceId={parts[1]!} />;
      break;
    case 'account':
      screen = <Account me={me} onMe={setMe} />;
      break;
    case 'users':
      screen = <Users me={me} />;
      break;
    case 'gpu':
      screen = <GpuAdmin me={me} />;
      break;
    case 'settings':
      screen = <Settings me={me} />;
      break;
    default:
      screen = <Lobby me={me} onLogout={() => setMe(null)} />;
  }
  return (
    <ErrorBoundary>
      {screen}
      <TooltipHost />
    </ErrorBoundary>
  );
}
