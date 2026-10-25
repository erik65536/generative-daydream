/**
 * Getting in: signing in (user name and password, or a passkey) and setting an account up from its invite link
 * (#/invite/<code>): a user name (unless the account already has one), a name others see, then a passkey, a password
 * or both.
 */
import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, type Me, type Proof } from '../api';
import { Backdrop } from '../ui/Backdrop';
import { navigate } from '../App';

export const MIN_PASSWORD = 8;
export const passkeysWork = () => browserSupportsWebAuthn();

/** A passkey cancelled in the browser's own dialog is not an error worth showing. */
const cancelled = (e: unknown) => (e as Error)?.name === 'NotAllowedError' || (e as Error)?.name === 'AbortError';

/** Use a passkey for a ceremony the server started; returns the browser's answer. */
export async function answerPasskey(options: unknown) {
  return startAuthentication({ optionsJSON: options as never });
}

/** Make a passkey for a ceremony the server started. */
export async function makePasskey(options: unknown) {
  return startRegistration({ optionsJSON: options as never });
}

/** A passkey proof that it is you, ready to send with a change. */
export async function passkeyProof(): Promise<Proof> {
  const c = await api.proofStart();
  return { passkey: { flow: c.flow, response: await answerPasskey(c.options) } };
}

/** A default name for a new passkey: the kind of device it was made on. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone or iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="page">
      <Backdrop />
      <div className="auth">
        <div className="title">Generative<br />Daydream</div>
        <div className="subtitle">Describe a daydream. Then walk into it.</div>
        {children}
      </div>
    </div>
  );
}

export function AuthScreen({ onAuthed }: { onAuthed: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<Me>) => {
    setBusy(true);
    setError('');
    try {
      onAuthed(await fn());
    } catch (err) {
      if (!cancelled(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withPasskey = () =>
    run(async () => {
      const c = await api.passkeySignInStart();
      return api.passkeySignInFinish(c.flow, await answerPasskey(c.options));
    });
  return (
    <Shell>
      <form
        className="panel panel-body col"
        style={{ padding: 24, gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api.login(username, password));
        }}
      >
        <div className="field">
          <label>User name</label>
          <input className="input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username webauthn" />
        </div>
        <div className="field">
          <label>Password</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary lg" disabled={busy || !username || !password}>Enter</button>
        {passkeysWork() && (
          <button type="button" className="btn" disabled={busy} onClick={withPasskey}>Sign in with a passkey</button>
        )}
        <div className="hint">This server is invite only. Ask its administrator for an invite link.</div>
      </form>
    </Shell>
  );
}

/** Setting up an account from its invite link: a user name and a name, then a passkey, a password or both. */
export function InviteScreen({ code, onAuthed }: { code: string; onAuthed: (me: Me) => void }) {
  const [invite, setInvite] = useState<{ username: string | null; displayName: string } | null>(null);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [keyName, setKeyName] = useState(deviceName());
  useEffect(() => {
    api.invite(code).then((i) => {
      setInvite(i);
      setName(i.displayName);
    }, (e) => setError(e.message));
  }, [code]);
  const done = (me: Me) => {
    navigate('#/');
    onAuthed(me);
  };
  const run = async (fn: () => Promise<Me>) => {
    setBusy(true);
    setError('');
    try {
      done(await fn());
    } catch (err) {
      if (!cancelled(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const problem = password && password.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters.` : again && password !== again ? 'The passwords do not match.' : '';
  /** The user name to send: none when the account already has one. */
  const chosen = invite?.username ? undefined : username.trim();
  const nameOk = !!invite?.username || /^[\w.-]{3,24}$/.test(username.trim());
  if (!invite)
    return (
      <Shell>
        <div className="panel panel-body col" style={{ padding: 24, gap: 12 }}>
          {error ? <div className="error-text">{error}</div> : <div className="spinner" />}
          <button className="btn ghost sm" onClick={() => navigate('#/')}>Sign in instead</button>
        </div>
      </Shell>
    );
  return (
    <Shell>
      <div className="panel panel-body col" style={{ padding: 24, gap: 14 }}>
        <div className="small">{invite.username ? <>Welcome back, <b>{invite.username}</b>. Set up how you sign in again.</> : 'Welcome! Choose your user name and how you sign in.'}</div>
        {!invite.username && (
          <div className="field">
            <label>User name (to sign in; it cannot be changed later)</label>
            <input className="input" autoFocus value={username} maxLength={24} onChange={(e) => setUsername(e.target.value)} placeholder="3-24 letters, numbers, . - _" autoComplete="username" />
          </div>
        )}
        <div className="field">
          <label>Your name (what other players see)</label>
          <input className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        </div>
        {passkeysWork() && (
          <div className="studio-ai col" style={{ gap: 8 }}>
            <div className="small">A passkey: sign in with your fingerprint, face or device PIN. No password to remember.</div>
            <div className="row" style={{ gap: 8 }}>
              <input className="input grow" value={keyName} maxLength={40} onChange={(e) => setKeyName(e.target.value)} title="A name for this passkey, to tell it apart later" />
              <button
                className="btn primary"
                style={{ whiteSpace: 'nowrap' }}
                disabled={busy || !name.trim() || !nameOk}
                onClick={() =>
                  run(async () => {
                    const c = await api.joinPasskeyStart(code, chosen);
                    return api.joinPasskeyFinish(code, { flow: c.flow, response: await makePasskey(c.options), name: keyName, username: chosen, displayName: name });
                  })
                }
              >
                Create a passkey
              </button>
            </div>
          </div>
        )}
        <form
          className="col"
          style={{ gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api.joinWithPassword(code, { username: chosen, displayName: name, password }));
          }}
        >
          <div className="small">{passkeysWork() ? 'Or a password:' : 'Choose a password:'}</div>
          <input type="text" autoComplete="username" value={invite.username ?? username} readOnly hidden />
          <input className="input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <input className="input" type="password" placeholder="Password again" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          {(error || problem) && <div className="error-text">{error || problem}</div>}
          <button className="btn" disabled={busy || !name.trim() || !nameOk || !password || password !== again || !!problem}>Set password</button>
        </form>
        <div className="hint">You can add the other one (and more passkeys) later on your account page.</div>
      </div>
    </Shell>
  );
}
