import { useState } from 'react';
import { api, type Me } from '../api';
import { Backdrop } from '../ui/Backdrop';

const MIN_PASSWORD = 8;

export function AuthScreen({ onAuthed }: { onAuthed: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onAuthed(await api.login(username, password));
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
          <div className="field">
            <label>User id</label>
            <input className="input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </div>
          <div className="field">
            <label>Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn primary lg" disabled={busy || !username || !password}>Enter</button>
          <div className="hint">This server is invite only. Ask its administrator for an account.</div>
        </form>
      </div>
    </div>
  );
}

/** Change your password; required (and the only thing possible) after signing in with a one-time password. */
export function ChangePassword({ me, onDone, forced }: { me: Me; onDone: (me: Me) => void; forced?: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const problem = next && next.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters.` : again && next !== again ? 'The new passwords do not match.' : '';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const m = await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
      onDone(m);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="col" style={{ gap: 14 }} onSubmit={submit}>
      {forced && <div className="small muted">Welcome, {me.username}. You signed in with a one-time password; choose your own to continue.</div>}
      <input type="text" autoComplete="username" value={me.username} readOnly hidden />
      <div className="field">
        <label>{forced ? 'One-time password' : 'Current password'}</label>
        <input className="input" type="password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </div>
      <div className="field">
        <label>New password</label>
        <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </div>
      <div className="field">
        <label>New password again</label>
        <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
      </div>
      {(error || problem) && <div className="error-text">{error || problem}</div>}
      {done && !forced && <div className="small gold">Password changed. Your other sessions were signed out.</div>}
      <button className="btn primary" disabled={busy || !current || !next || next !== again || !!problem}>Change password</button>
    </form>
  );
}

/** Shown instead of the app until a one-time password is replaced. */
export function ForcedPasswordScreen({ me, onDone, onLogout }: { me: Me; onDone: (me: Me) => void; onLogout: () => void }) {
  return (
    <div className="page">
      <Backdrop />
      <div className="auth">
        <div className="title">Generative<br />Daydream</div>
        <div className="panel panel-body col" style={{ padding: 24, gap: 10 }}>
          <ChangePassword me={me} onDone={onDone} forced />
          <button className="btn ghost sm" onClick={() => api.logout().then(onLogout)}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
