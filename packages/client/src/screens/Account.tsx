import { useEffect, useState } from 'react';
import { api, type Me, type SpendingSummary, type TrashEntry, type UserRow } from '../api';
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
        {me.ai && (
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head"><h3>AI budget</h3></div>
            <div className="panel-body col" style={{ gap: 8 }}>
              <Budget spent={me.ai.spentToday} limit={me.ai.limit} />
              <div className="hint">What building daydreams, painting checks and conversations with people have cost today on paid models. It resets at midnight. Local models are free.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const usd = (v: number) => (v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** Spent today against a daily budget, as a bar. */
function Budget({ spent, limit }: { spent: number; limit: number | null }) {
  const frac = limit ? Math.min(1, spent / Math.max(0.0001, limit)) : 0;
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row small"><span>{usd(spent)} today</span><div className="spacer" /><span className="muted">{limit === null ? 'no daily limit' : `of ${usd(limit)}`}</span></div>
      {limit !== null && <div className="budget-bar"><div style={{ width: `${frac * 100}%`, background: frac > 0.9 ? 'var(--danger)' : frac > 0.6 ? 'var(--gold)' : 'var(--good)' }} /></div>}
    </div>
  );
}

/** A user's daily budget: the server default, or their own. */
function BudgetCell({ u, onSet }: { u: UserRow; onSet: (v: number | null) => void }) {
  const [v, setV] = useState(u.dailyLimitUsd === null ? '' : String(u.dailyLimitUsd));
  const commit = () => {
    const t = v.trim();
    if (t === '' ? u.dailyLimitUsd === null : Number(t) === u.dailyLimitUsd) return;
    if (t !== '' && !(Number(t) >= 0)) return setV(u.dailyLimitUsd === null ? '' : String(u.dailyLimitUsd));
    onSet(t === '' ? null : Number(t));
  };
  return (
    <div className="row" style={{ gap: 4 }}>
      <span className="muted small">$</span>
      <input className="input" style={{ width: 64, padding: '3px 6px' }} value={v} placeholder="default" onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} title="Daily budget in dollars; empty uses the server default" />
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
  const [spending, setSpending] = useState<SpendingSummary | null>(null);
  const load = () => Promise.all([api.users().then(setUsers), api.spending().then(setSpending)]).catch((e) => setError(e.message));
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
            {spending && (
              <div className="studio-ai col" style={{ gap: 6 }}>
                <div className="small">AI spending today across the server</div>
                <Budget spent={spending.today} limit={spending.dailyTotalUsd} />
                <div className="hint">
                  Default daily budget per player: {spending.dailyPerUserUsd === null ? 'none' : usd(spending.dailyPerUserUsd)}{spending.adminsUnlimited ? '; administrators are unlimited unless given their own' : ''}. Set these in config/genai.json under "spending"; set a player's own below (empty = default).
                </div>
              </div>
            )}
            <table className="table">
              <thead>
                <tr><th>User id</th><th>Role</th><th>Status</th><th>AI today</th><th>Daily budget</th><th>7 days</th><th /></tr>
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
                    <td className="small">{u.ai ? `${usd(u.ai.spentToday)}${u.ai.limit !== null ? ` / ${usd(u.ai.limit)}` : ''}` : '—'}</td>
                    <td><BudgetCell u={u} onSet={(v) => act(() => api.setUserBudget(u.id, v))} /></td>
                    <td className="small muted">{usd(u.spentWeek)}</td>
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
        <Trash />
      </div>
    </div>
  );
}

/** Deleted daydreams, with their saves: restore one, or remove it before its time in the trash runs out. */
function Trash() {
  const [trash, setTrash] = useState<{ days: number; entries: TrashEntry[] } | null>(null);
  const [error, setError] = useState('');
  const load = () => api.trash().then(setTrash).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };
  if (!trash) return null;
  const left = (e: TrashEntry) => Math.max(0, Math.ceil(trash.days - (Date.now() - e.deletedAt) / 86400_000));
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-head"><h3>Deleted daydreams</h3></div>
      <div className="panel-body col" style={{ gap: 10 }}>
        {error && <div className="error-text">{error}</div>}
        {trash.entries.length ? (
          <table className="table">
            <thead>
              <tr><th>Daydream</th><th>Owner</th><th>Deleted</th><th>Reveries</th><th /></tr>
            </thead>
            <tbody>
              {trash.entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.title}</td>
                  <td className="small">{e.ownerName || '—'}</td>
                  <td className="small muted">{new Date(e.deletedAt).toLocaleDateString()}{e.deletedBy ? ` by ${e.deletedBy}` : ''} · {left(e)} days left</td>
                  <td className="small muted">{e.saves}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={() => act(() => api.restoreWorld(e.id))}>Restore</button>{' '}
                    <button className="btn sm danger" onClick={() => confirm(`Remove "${e.title}" and its reveries for good? This cannot be undone.`) && act(() => api.purgeWorld(e.id))}>Remove now</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted small">Nothing in the trash.</div>
        )}
        <div className="hint">A deleted daydream and its reveries are kept here for {trash.days} days, then removed for good.</div>
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
