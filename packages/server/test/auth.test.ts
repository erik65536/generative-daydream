import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import express from 'express';
import {
  activateUser, addPasskey, claimInvite, clearPassword, createSession, createUser, findUser, getUser, listUsers, removePasskey, resetUser,
  sessionUser, setAdmin, setEnabled, setPassword, userByInvite, verifyUser, INVITE_DAYS,
} from '../src/storage';
import { cookie } from '../src/auth';
import { mountAccounts } from '../src/accounts';
import { activeUser } from './helpers';

const name = () => `t_${Math.random().toString(36).slice(2, 10)}`;

describe('accounts', () => {
  it('an invite becomes an account when its player picks a user name and a way to sign in', () => {
    const u = createUser({ displayName: 'Robin', monthlyBudgetUsd: 4 });
    expect(u).toMatchObject({ status: 'invited', username: null, displayName: 'Robin', monthlyBudgetUsd: 4, isAdmin: false });
    expect(u.inviteCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(u.inviteExpires! - Date.now()).toBeGreaterThan((INVITE_DAYS - 0.01) * 86400_000);
    expect(userByInvite(u.inviteCode!.toLowerCase())?.id).toBe(u.id);
    // Not signed in until it is set up.
    expect(sessionUser(createSession(u.id))).toBeNull();

    const taken = activeUser().username!;
    expect(() => claimInvite(u.id, { username: taken.toUpperCase() })).toThrow(/taken/);
    expect(() => claimInvite(u.id, { username: 'a b' })).toThrow(/User names/);
    expect(() => claimInvite(u.id, {})).toThrow(/Choose a user name/);
    const mine = name();
    claimInvite(u.id, { username: mine, displayName: 'Robin Hood' });
    expect(() => setPassword(u.id, 'short')).toThrow(/at least/);
    setPassword(u.id, 'a-chosen-password');
    activateUser(u.id);
    expect(getUser(u.id)).toMatchObject({ status: 'active', username: mine, displayName: 'Robin Hood', inviteCode: null });
    expect(userByInvite(u.inviteCode!)).toBeUndefined();
    expect(verifyUser(mine.toUpperCase(), 'a-chosen-password')?.id).toBe(u.id);
  });

  it('a reset sends the account back to an invite: same user name, no way to sign in, signed out', () => {
    const u = activeUser();
    addPasskey({ id: `pk_${name()}`, userId: u.id, name: 'Phone', publicKey: new Uint8Array([1]), counter: 0, transports: [] });
    const s = createSession(u.id);
    const r = resetUser(u.id);
    expect(r).toMatchObject({ status: 'invited', username: u.username, passwordHash: null });
    expect(sessionUser(s)).toBeNull();
    expect(verifyUser(u.username!, 'a-chosen-password')).toBeNull();
    // The user name stays as it was.
    claimInvite(u.id, { username: name() });
    expect(getUser(u.id)!.username).toBe(u.username);
  });

  it('a disabled account cannot sign in and is signed out', () => {
    const u = activeUser();
    const s = createSession(u.id);
    setEnabled(u.id, false);
    expect(sessionUser(s)).toBeNull();
    expect(verifyUser(u.username!, 'a-chosen-password')).toBeNull();
    setEnabled(u.id, true);
    expect(verifyUser(u.username!, 'a-chosen-password')?.id).toBe(u.id);
    expect(() => setEnabled(createUser({ displayName: 'Not yet' }).id, true)).toThrow(/not been set up/);
  });

  it('keeps a way to sign in: no clearing the only password, no removing the only passkey', () => {
    const u = activeUser();
    expect(() => clearPassword(u.id)).toThrow(/passkey/);
    const pk = `pk_${name()}`;
    addPasskey({ id: pk, userId: u.id, name: 'Laptop', publicKey: new Uint8Array([1]), counter: 0, transports: [] });
    clearPassword(u.id);
    expect(() => removePasskey(u.id, pk, true)).toThrow(/only way/);
    // An administrator may (the account then needs a reset).
    removePasskey(u.id, pk, false);
  });

  it('keeps at least one active administrator', () => {
    const a = activeUser(true);
    const b = activeUser();
    setAdmin(b.id, true);
    expect(findUser(b.username!)!.isAdmin).toBe(true);
    setAdmin(b.id, false);
    for (const u of listUsers()) if (u.isAdmin && u.id !== a.id) setAdmin(u.id, false);
    expect(() => setAdmin(a.id, false)).toThrow(/at least one/);
    expect(() => setEnabled(a.id, false)).toThrow(/at least one/);
    expect(() => resetUser(a.id)).toThrow(/at least one/);
  });

  it('reads the session cookie, and takes a malformed one for none', () => {
    const req = (c: string) => ({ headers: { cookie: c } }) as never;
    expect(cookie(req('a=1; gd_session=abc%20def'), 'gd_session')).toBe('abc def');
    expect(cookie(req('gd_session=%E0%A4%A'), 'gd_session')).toBeUndefined();
    expect(cookie(req('other=1'), 'gd_session')).toBeUndefined();
  });
});

describe('accounts on the web', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountAccounts(app, { sameOrigin: () => true });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());
  const post = async (p: string, body: unknown, c?: string) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };

  it('joins by invite link with a password, then signs in; a used or wrong code does nothing', async () => {
    const u = createUser({ displayName: 'Sam' });
    const code = u.inviteCode!;
    expect(await (await fetch(`${base}/api/join/${code}`)).json()).toEqual({ username: null, displayName: 'Sam' });
    const mine = name();
    const joined = await post(`/api/join/${code}/password`, { username: mine, displayName: 'Samwise', password: 'a-chosen-password' });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ username: mine, displayName: 'Samwise', hasPassword: true, passkeys: [] });
    expect(joined.cookie).toMatch(/^gd_session=/);
    expect((await post(`/api/join/${code}/password`, { username: name(), password: 'another-password' })).status).toBe(400);
    expect((await fetch(`${base}/api/join/AAAA-BBBB-CCCC`)).status).toBe(400);
    const signed = await post('/api/auth/login', { username: mine, password: 'a-chosen-password' });
    expect(signed.status).toBe(200);
    // Changing the password needs the current one.
    expect((await post('/api/account/password', { next: 'a-new-password' }, signed.cookie)).status).toBe(400);
    expect((await post('/api/account/password', { proof: { password: 'wrong' }, next: 'a-new-password' }, signed.cookie)).status).toBe(400);
    expect((await post('/api/account/password', { proof: { password: 'a-chosen-password' }, next: 'a-new-password' }, signed.cookie)).status).toBe(200);
  });
});
