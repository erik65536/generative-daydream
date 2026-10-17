import { Component, useEffect, useState, type ReactNode } from 'react';
import { api, type Me } from './api';
import { AuthScreen } from './screens/Auth';
import { Lobby } from './screens/Lobby';
import { CreateWorld } from './screens/CreateWorld';
import { WorldPage } from './screens/WorldPage';
import { CharacterCreate } from './screens/CharacterCreate';
import { Settings } from './screens/Settings';
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
          <button className="btn ghost" onClick={() => { location.hash = '#/'; location.reload(); }}>Back to worlds</button>
        </div>
      </div>
    );
  }
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const hash = useHash();
  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);
  if (me === undefined)
    return (
      <div className="center" style={{ height: '100%' }}>
        <div className="spinner" />
      </div>
    );
  if (!me) return <AuthScreen onAuthed={setMe} />;
  const parts = hash.replace(/^#\/?/, '').split('/');
  let screen;
  switch (parts[0]) {
    case 'create':
      screen = <CreateWorld me={me} />;
      break;
    case 'world':
      screen = parts[2] === 'new' ? <CharacterCreate me={me} worldId={parts[1]!} /> : <WorldPage me={me} worldId={parts[1]!} />;
      break;
    case 'join':
      screen = <CharacterCreate me={me} worldId={parts[1]!} joinInstanceId={parts[2]} />;
      break;
    case 'play':
      screen = <GameScreen key={parts[1]} me={me} instanceId={parts[1]!} />;
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
