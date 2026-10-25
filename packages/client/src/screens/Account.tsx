import { useEffect, useState } from 'react';
import { api, type Me, type Proof, type SpendingSummary, type TrashEntry, type UserRow } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { TopBar } from './Lobby';
import { MIN_PASSWORD, deviceName, makePasskey, passkeyProof, passkeysWork } from './Auth';

const usd = (v: number) => (v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const when = (t: number | null) => (t ? new Date(t).toLocaleDateString() : 'never');
const inviteLink = (code: string) => `${location.origin}${location.pathname}#/invite/${code}`;

/**
 * Your account: your name, how you sign in (a password, passkeys, or both) and your AI budget. Changing how you sign
 * in asks you to confirm it is you first (your current password, or a passkey).
 */
export function Account({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(me.displayName);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [keyName, setKeyName] = useState(deviceName());
  const run = async (fn: () => Promise<Me>, done?: string) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      onMe(await fn());
      if (done) setNote(done);
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  /** Confirm it is you: the current password when typed, else a passkey. */
  const proof = async (): Promise<Proof> => (current ? { password: current } : passkeyProof());
  const canProve = !!current || me.passkeys.length > 0;
  const problem = next && next.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters.` : again && next !== again ? 'The new passwords do not match.' : '';
  return (
    <div className="page">
      <Backdrop />
      <TopBar me={me} />
      <div className="page-inner" style={{ maxWidth: 560 }}>
        <div className="panel">
          <div className="panel-head"><h3>Your account</h3><div className="spacer" /><span className="muted small">{me.username} · {me.isAdmin ? 'administrator' : 'player'}</span></div>
          <div className="panel-body col" style={{ gap: 14 }}>
            <form
              className="row"
              style={{ gap: 8, alignItems: 'flex-end' }}
              onSubmit={(e) => {
                e.preventDefault();
                run(() => api.setDisplayName(name), 'Name saved.');
              }}
            >
              <div className="field grow">
                <label>Your name (what other players see)</label>
                <input className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
              </div>
              <button className="btn" disabled={busy || !name.trim() || name.trim() === me.displayName}>Save</button>
            </form>
            {error && <div className="error-text">{error}</div>}
            {note && <div className="small gold">{note}</div>}
          </div>
        </div>

        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head"><h3>Signing in</h3></div>
          <div className="panel-body col" style={{ gap: 14 }}>
            {me.hasPassword && (
              <div className="field">
                <label>Current password (to confirm changes below{me.passkeys.length ? '; or leave it empty and use a passkey' : ''})</label>
                <input type="text" autoComplete="username" value={me.username} readOnly hidden />
                <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
              </div>
            )}
            <div className="col" style={{ gap: 8 }}>
              <div className="small">Passkeys</div>
              {me.passkeys.length ? (
                me.passkeys.map((p) => (
                  <div key={p.id} className="row small" style={{ gap: 8 }}>
                    <span className="grow">{p.name}</span>
                    <span className="muted">added {when(p.createdAt)} · last used {when(p.lastUsedAt)}</span>
                    <button className="btn sm ghost" disabled={busy || !canProve} onClick={() => confirm(`Remove the passkey "${p.name}"?`) && run(async () => api.removePasskey(p.id, await proof()), 'Passkey removed.')}>Remove</button>
                  </div>
                ))
              ) : (
                <div className="muted small">None yet.</div>
              )}
              {passkeysWork() && (
                <div className="row" style={{ gap: 8 }}>
                  <input className="input grow" value={keyName} maxLength={40} onChange={(e) => setKeyName(e.target.value)} title="A name for the new passkey" />
                  <button
                    className="btn"
                    style={{ whiteSpace: 'nowrap' }}
                    disabled={busy || !canProve}
                    onClick={() =>
                      run(async () => {
                        const c = await api.passkeyAddStart(await proof());
                        return api.passkeyAddFinish(c.flow, await makePasskey(c.options), keyName);
                      }, 'Passkey added.')
                    }
                  >
                    Add a passkey
                  </button>
                </div>
              )}
            </div>
            <form
              className="col"
              style={{ gap: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const m = await api.setPassword(await proof(), next);
                  setCurrent('');
                  setNext('');
                  setAgain('');
                  return m;
                }, 'Password saved. Your other sessions were signed out.');
              }}
            >
              <div className="small">{me.hasPassword ? 'Change your password' : 'Add a password'}</div>
              <input className="input" type="password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
              <input className="input" type="password" placeholder="New password again" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
              {problem && <div className="error-text">{problem}</div>}
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" disabled={busy || !canProve || !next || next !== again || !!problem}>{me.hasPassword ? 'Change password' : 'Add password'}</button>
                {me.hasPassword && me.passkeys.length > 0 && (
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => confirm('Remove your password? You will sign in with a passkey only.') && run(async () => api.clearPassword(await proof()), 'Password removed.')}>
                    Remove password
                  </button>
                )}
              </div>
            </form>
            <div className="hint">Changes to how you sign in ask for your current password or one of your passkeys.</div>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head"><h3>AI budget</h3></div>
          <div className="panel-body col" style={{ gap: 8 }}>
            <Budget spent={me.ai.spentMonth} limit={me.ai.budget} period="this month" />
            <div className="hint">What building daydreams, painting checks and conversations with people have cost this month on paid models. It starts again on the 1st.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Spent against a budget, as a bar. */
function Budget({ spent, limit, period }: { spent: number; limit: number | null; period: string }) {
  const frac = limit ? Math.min(1, spent / Math.max(0.0001, limit)) : 0;
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row small"><span>{usd(spent)} {period}</span><div className="spacer" /><span className="muted">{limit === null ? 'no limit' : `of ${usd(limit)}`}</span></div>
      {limit !== null && <div className="budget-bar"><div style={{ width: `${frac * 100}%`, background: frac > 0.9 ? 'var(--danger)' : frac > 0.6 ? 'var(--gold)' : 'var(--good)' }} /></div>}
    </div>
  );
}

/** An editable cell: commits on Enter or leaving it, when changed. */
function EditCell({ value, onSet, width, prefix, number }: { value: string; onSet: (v: string) => void; width: number; prefix?: string; number?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    const t = v.trim();
    if (t === value || !t || (number && !(Number(t) >= 0))) return setV(value);
    onSet(t);
  };
  return (
    <div className="row" style={{ gap: 4 }}>
      {prefix && <span className="muted small">{prefix}</span>}
      <input className="input" style={{ width, padding: '3px 6px' }} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </div>
  );
}

/** An invite link to pass on, with a copy button. */
function InviteLink({ code, expires }: { code: string; expires: number | null }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLink(code);
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6 }}>
        <code className="small" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{link}</code>
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {expires && <div className="tiny muted">Works until {new Date(expires).toLocaleDateString()}.</div>}
    </div>
  );
}

/** Administrators make accounts (invite links), set names and budgets, disable or reset accounts, remove passkeys. */
export function Users({ me }: { me: Me }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [budget, setBudget] = useState('10');
  const [admin, setAdmin] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
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
  const status = (u: UserRow) => (u.status === 'invited' ? (u.inviteExpires && u.inviteExpires < Date.now() ? 'invite expired' : 'invited') : u.status);
  return (
    <div className="page">
      <Backdrop />
      <TopBar me={me} />
      <div className="page-inner" style={{ maxWidth: 900 }}>
        <div className="panel">
          <div className="panel-head"><h3>Users</h3></div>
          <div className="panel-body col" style={{ gap: 14 }}>
            <form
              className="row wrap"
              style={{ gap: 8, alignItems: 'flex-end' }}
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  const u = await api.createUser({ displayName, isAdmin: admin, monthlyBudgetUsd: Number(budget) || 0 });
                  setOpen(u.id);
                  setDisplayName('');
                  setBudget('10');
                  setAdmin(false);
                });
              }}
            >
              <div className="field grow">
                <label>Who it is for (they can change it)</label>
                <input className="input" value={displayName} maxLength={32} onChange={(e) => setDisplayName(e.target.value)} placeholder="a name" />
              </div>
              <div className="field" style={{ width: 110 }}>
                <label>Budget / month</label>
                <input className="input" value={budget} onChange={(e) => setBudget(e.target.value)} />
              </div>
              <label className="row small" style={{ gap: 6, paddingBottom: 9 }}>
                <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> administrator
              </label>
              <button className="btn primary" disabled={!displayName.trim()}>Create invite</button>
            </form>
            {error && <div className="error-text">{error}</div>}
            {spending && (
              <div className="studio-ai col" style={{ gap: 6 }}>
                <div className="small">AI spending today across the server</div>
                <Budget spent={spending.today} limit={spending.dailyTotalUsd} period="today" />
                <div className="hint">
                  The server's daily ceiling is set in config/genai.json under "spending"{spending.adminsUnlimited ? '; administrators are unlimited' : ''}. Each player's monthly budget is set below.
                </div>
              </div>
            )}
            <table className="table">
              <thead>
                <tr><th>Name</th><th>User name</th><th>Role</th><th>Status</th><th>This month</th><th>Budget</th><th /></tr>
              </thead>
              <tbody>
                {(users ?? []).map((u) => {
                  const self = u.id === me.id;
                  return [
                    <tr key={u.id}>
                      <td>{self ? <>{u.displayName}<span className="muted"> (you)</span></> : <EditCell value={u.displayName} width={130} onSet={(v) => act(() => api.updateUser(u.id, { displayName: v }))} />}</td>
                      <td className="small">{u.username ?? <span className="muted">not chosen yet</span>}</td>
                      <td>
                        <select className="input" style={{ padding: '3px 6px' }} disabled={self} value={u.isAdmin ? 'admin' : 'player'} onChange={(e) => act(() => api.updateUser(u.id, { isAdmin: e.target.value === 'admin' }))}>
                          <option value="player">player</option>
                          <option value="admin">admin</option>
                        </select>
                      </td>
                      <td className={`small ${u.status === 'disabled' ? 'bad' : 'muted'}`}>{status(u)}</td>
                      <td className="small">{usd(u.ai.spentMonth)}</td>
                      <td>{u.isAdmin && spending?.adminsUnlimited ? <span className="small muted">unlimited</span> : <EditCell value={String(u.monthlyBudgetUsd)} width={60} prefix="$" number onSet={(v) => act(() => api.updateUser(u.id, { monthlyBudgetUsd: Number(v) }))} />}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {!self && <button className="btn sm ghost" onClick={() => setOpen(open === u.id ? null : u.id)}>{open === u.id ? 'Close' : 'More'}</button>}
                      </td>
                    </tr>,
                    open === u.id && !self && (
                      <tr key={`${u.id}-more`}>
                        <td colSpan={7}>
                          <div className="col" style={{ gap: 10, padding: '6px 0 10px' }}>
                            {u.status === 'invited' && u.inviteCode && (
                              <div className="col" style={{ gap: 4 }}>
                                <div className="small">Send {u.displayName} this invite link{u.username ? ` (they sign in as ${u.username})` : '; they choose their user name'}:</div>
                                <InviteLink code={u.inviteCode} expires={u.inviteExpires} />
                              </div>
                            )}
                            {u.status !== 'invited' && (
                              <div className="small muted">
                                Signs in with {[u.hasPassword && 'a password', u.passkeys.length && `${u.passkeys.length} passkey${u.passkeys.length > 1 ? 's' : ''}`].filter(Boolean).join(' and ') || 'nothing (reset the account to give them a new invite link)'}.
                              </div>
                            )}
                            {u.passkeys.map((p) => (
                              <div key={p.id} className="row small" style={{ gap: 8 }}>
                                <span className="grow">Passkey "{p.name}"</span>
                                <span className="muted">last used {when(p.lastUsedAt)}</span>
                                <button className="btn sm ghost" onClick={() => confirm(`Remove ${u.displayName}'s passkey "${p.name}"?`) && act(() => api.removeUserPasskey(u.id, p.id))}>Remove</button>
                              </div>
                            ))}
                            <div className="row" style={{ gap: 8 }}>
                              {u.status !== 'invited' && (
                                <button className="btn sm" onClick={() => act(() => api.updateUser(u.id, { enabled: u.status === 'disabled' }))}>{u.status === 'disabled' ? 'Enable' : 'Disable'}</button>
                              )}
                              <button
                                className="btn sm danger"
                                onClick={() => confirm(u.status === 'invited' ? `Give ${u.displayName} a new invite link? The old one stops working.` : `Reset ${u.displayName}? Their password and passkeys are removed and they are signed out; they set the account up again from a new invite link (keeping their user name). Their daydreams and reveries stay.`) && act(() => api.resetUser(u.id))}
                              >
                                {u.status === 'invited' ? 'New invite link' : 'Reset account'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
            <div className="hint">Change your own account on your account page. If every administrator is locked out, use the server console: npm run users -w @gd/server -- reset &lt;user name or id&gt;</div>
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
