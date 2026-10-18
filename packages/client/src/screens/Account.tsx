import { useEffect, useState } from 'react';
import { api, type Me, type UserRow } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';
import { ChangePassword } from './Auth';

/** Your account: change your password. */
export function Account({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  return (
    <div className="page">
      <Backdrop />
      <TopBar me={me} />
      <div className="page-inner" style={{ maxWidth: 520 }}>
        <div className="panel">
          <div className="panel-head"><h3>Your account</h3><div className="spacer" /><span className="muted small">{me.username} · {me.isAdmin ? 'administrator' : 'player'}</span></div>
          <div className="panel-body"><ChangePassword me={me} onDone={onMe} /></div>
        </div>
      </div>
    </div>
  );
}

/** Administrators invite people, reset passwords and choose who else administers the server. */
export function Users({ me }: { me: Me }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState(false);
  const [issued, setIssued] = useState<{ username: string; password: string; reset: boolean } | null>(null);
  const load = () => api.users().then(setUsers, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!me.isAdmin) return <div className="page"><Backdrop /><TopBar me={me} /><div className="page-inner">Administrators only.</div></div>;
  return (
    <div className="page">
      <Backdrop />
      <TopBar me={me} />
      <div className="page-inner" style={{ maxWidth: 820 }}>
        <div className="panel">
          <div className="panel-head"><h3>Users</h3></div>
          <div className="panel-body col" style={{ gap: 14 }}>
            <form
              className="row wrap"
              style={{ gap: 8, alignItems: 'flex-end' }}
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  const r = await api.inviteUser(name, admin);
                  setIssued({ username: r.user.username, password: r.password, reset: false });
                  setName('');
                  setAdmin(false);
                });
              }}
            >
              <div className="field grow">
                <label>New user id</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="3-24 letters, numbers, . - _" />
              </div>
              <label className="row small" style={{ gap: 6, paddingBottom: 9 }}>
                <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> administrator
              </label>
              <button className="btn primary" disabled={!name.trim()}>Create account</button>
            </form>
            {issued && <IssuedPassword {...issued} onClose={() => setIssued(null)} />}
            {error && <div className="error-text">{error}</div>}
            <table className="table">
              <thead>
                <tr><th>User id</th><th>Role</th><th>Status</th><th>Created</th><th /></tr>
              </thead>
              <tbody>
                {(users ?? []).map((u) => (
                  <tr key={u.id}>
                    <td>{u.username}{u.id === me.id && <span className="muted"> (you)</span>}</td>
                    <td>
                      <select className="input" style={{ padding: '3px 6px' }} value={u.isAdmin ? 'admin' : 'normal'} onChange={(e) => act(() => api.setUserAdmin(u.id, e.target.value === 'admin'))}>
                        <option value="normal">normal</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="small muted">{u.mustChangePassword ? 'must set a password' : 'active'}</td>
                    <td className="small muted">{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      {u.id !== me.id && (
                        <button
                          className="btn sm"
                          onClick={() => confirm(`Reset ${u.username}'s password? They are signed out and must choose a new one with the one-time password you give them.`) && act(async () => setIssued({ username: u.username, password: (await api.resetUser(u.id)).password, reset: true }))}
                        >
                          Reset password
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint">Change your own password on your account page. If every administrator is locked out, use the server console: npm run users -w @gd/server -- reset &lt;user id&gt;</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A one-time password, shown once for the administrator to pass on. */
function IssuedPassword({ username, password, reset, onClose }: { username: string; password: string; reset: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="studio-ai col" style={{ gap: 6 }}>
      <div className="small">{reset ? `New one-time password for ${username}` : `Account ${username} created. One-time password`}:</div>
      <div className="row" style={{ gap: 8 }}>
        <code style={{ fontSize: 18, letterSpacing: '.05em', userSelect: 'all' }}>{password}</code>
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(password).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
        <div className="spacer" />
        <button className="btn sm ghost" onClick={onClose}>Done</button>
      </div>
      <div className="hint">It is shown only now. {username} signs in with it and must choose a new password.</div>
    </div>
  );
}
