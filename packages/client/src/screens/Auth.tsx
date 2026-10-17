import { useState } from 'react';
import { api, type Me } from '../api';
import { Backdrop } from '../ui/Backdrop';

export function AuthScreen({ onAuthed }: { onAuthed: (me: Me) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onAuthed(mode === 'login' ? await api.login(username, password) : await api.register(username, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <Backdrop />
      <div className="auth">
        <div className="title">Generative<br />Daydream</div>
        <div className="subtitle">Describe a world. Then walk into it.</div>
        <form className="panel panel-body col" style={{ padding: 24, gap: 14 }} onSubmit={submit}>
          <div className="tabs" style={{ padding: 0, marginBottom: 4 }}>
            <div className={`tab ${mode === 'login' ? 'on' : ''}`} onClick={() => setMode('login')}>Sign in</div>
            <div className={`tab ${mode === 'register' ? 'on' : ''}`} onClick={() => setMode('register')}>Create account</div>
          </div>
          <div className="field">
            <label>Username</label>
            <input className="input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </div>
          <div className="field">
            <label>Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn primary lg" disabled={busy || !username || !password}>
            {mode === 'login' ? 'Enter' : 'Create account'}
          </button>
          {mode === 'register' && <div className="hint">The first account created on this server becomes the administrator (can configure AI models).</div>}
        </form>
      </div>
    </div>
  );
}
