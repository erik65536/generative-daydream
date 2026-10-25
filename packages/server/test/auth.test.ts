import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { changePassword, createSession, findUser, inviteUser, listUsers, resetPassword, sessionUser, setAdmin, verifyUser } from '../src/storage';
import { cookie } from '../src/auth';

const uid = () => `t_${crypto.randomBytes(4).toString('hex')}`;

describe('invite-only accounts', () => {
  it('invites with a one-time password that must be replaced', () => {
    const name = uid();
    const { user, password } = inviteUser(name);
    expect(user.mustChangePassword).toBe(true);
    expect(user.isAdmin).toBe(false);
    expect(password).toMatch(/^[A-Za-z2-9]{14}$/);
    expect(verifyUser(name, password)?.id).toBe(user.id);
    expect(() => inviteUser(name.toUpperCase())).toThrow(/taken/);
    expect(() => inviteUser('a b')).toThrow(/User ids/);

    const keep = createSession(user.id);
    const other = createSession(user.id);
    expect(() => changePassword(user.id, 'wrong', 'a-new-password', keep)).toThrow(/current password/);
    expect(() => changePassword(user.id, password, 'short', keep)).toThrow(/at least/);
    expect(() => changePassword(user.id, password, password, keep)).toThrow(/different/);
    changePassword(user.id, password, 'a-new-password', keep);
    expect(findUser(name)!.mustChangePassword).toBe(false);
    expect(verifyUser(name, password)).toBeNull();
    expect(verifyUser(name, 'a-new-password')).not.toBeNull();
    // The session that changed it stays; the others are signed out.
    expect(sessionUser(keep)?.id).toBe(user.id);
    expect(sessionUser(other)).toBeNull();
  });

  it('admin resets sign the user out and require a new password', () => {
    const name = uid();
    const { user, password } = inviteUser(name);
    changePassword(user.id, password, 'chosen-password');
    const s = createSession(user.id);
    const fresh = resetPassword(user.id);
    expect(sessionUser(s)).toBeNull();
    expect(findUser(name)!.mustChangePassword).toBe(true);
    expect(verifyUser(name, 'chosen-password')).toBeNull();
    expect(verifyUser(name, fresh)).not.toBeNull();
  });

  it('keeps at least one administrator', () => {
    const a = inviteUser(uid(), true).user;
    const b = inviteUser(uid()).user;
    setAdmin(b.id, true);
    expect(findUser(b.username)!.isAdmin).toBe(true);
    setAdmin(b.id, false);
    expect(findUser(b.username)!.isAdmin).toBe(false);
    // Demote every other administrator; the last one cannot be demoted.
    for (const u of listUsers()) if (u.isAdmin && u.id !== a.id) setAdmin(u.id, false);
    expect(() => setAdmin(a.id, false)).toThrow(/at least one/);
    expect(findUser(a.username)!.isAdmin).toBe(true);
  });

  it('reads the session cookie, and takes a malformed one for none', () => {
    const req = (c: string) => ({ headers: { cookie: c } }) as never;
    expect(cookie(req('a=1; gd_session=abc%20def'), 'gd_session')).toBe('abc def');
    expect(cookie(req('gd_session=%E0%A4%A'), 'gd_session')).toBeUndefined();
    expect(cookie(req('other=1'), 'gd_session')).toBeUndefined();
  });
});
