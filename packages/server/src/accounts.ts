/**
 * Accounts on the web: signing in (password or passkey), joining by invite link, your own account, and user
 * administration. See storage.ts for an account's life (invited, active, disabled).
 *
 * Passkeys use WebAuthn (SimpleWebAuthn). A passkey belongs to the site's host name, taken from the page's own origin
 * (checked against the request), so one made on localhost works only there. A ceremony (registering or using a
 * passkey) is a challenge kept here for five minutes under a random flow id the browser sends back.
 *
 * Changing how you sign in (setting, replacing or removing a password; adding or removing a passkey) needs a proof
 * that it is you: your current password, or a passkey used just before. An open session alone is not enough.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import * as store from './storage';
import { adminOnly, auth, cookie, type AuthedRequest } from './auth';
import { genai } from './genai/service';
import { monthlyBudgetFor } from './spending';

const SITE = 'Generative Daydream';
const round = (usd: number) => Math.round(usd * 10000) / 10000;

// ------------------------------------------------------------------------------------ views

const passkeyView = (p: store.Passkey) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt });

export function meOf(u: store.User) {
  const budget = monthlyBudgetFor(u.id);
  return {
    id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin, hasPassword: !!u.passwordHash,
    passkeys: store.listPasskeys(u.id).map(passkeyView),
    ai: { spentMonth: round(store.spentThisMonth(u.id).usd), budget: Number.isFinite(budget) ? budget : null },
  };
}

const userRow = (u: store.User) => ({
  ...meOf(u), status: u.status, createdAt: u.createdAt, monthlyBudgetUsd: u.monthlyBudgetUsd,
  inviteCode: u.status === 'invited' ? u.inviteCode : null, inviteExpires: u.status === 'invited' ? u.inviteExpires : null,
});

// ------------------------------------------------------------------------------------ sessions and attempts

const setSession = (req: Request, res: Response, token: string) =>
  res.setHeader('Set-Cookie', `gd_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${req.secure ? '; Secure' : ''}`);

/** Failed attempts per key (an account, an address, invite codes from an address): a growing lockout after five. */
const failures = new Map<string, { n: number; until: number }>();
const locked = (k: string) => (failures.get(k)?.until ?? 0) > Date.now();
const fail = (k: string) => {
  // Forget old entries now and then, so the map stays small.
  if (failures.size > 5000) for (const [key, f] of failures) if (f.until < Date.now()) failures.delete(key);
  const f = failures.get(k) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (f.n - 5));
  failures.set(k, f);
};
const tooMany = (res: Response) => void res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });

// ------------------------------------------------------------------------------------ passkey ceremonies

interface Flow {
  challenge: string;
  rpID: string;
  origin: string;
  /** What the ceremony is for, and for whom. */
  purpose: 'sign-in' | 'proof' | 'register';
  userId?: string;
  expires: number;
}
const flows = new Map<string, Flow>();

function newFlow(f: Omit<Flow, 'expires'>): string {
  const now = Date.now();
  for (const [k, v] of flows) if (v.expires < now) flows.delete(k);
  const id = crypto.randomBytes(18).toString('base64url');
  flows.set(id, { ...f, expires: now + 5 * 60_000 });
  return id;
}

/** Take a flow (once): it must be for this purpose (and user) and not expired. */
function takeFlow(id: unknown, purpose: Flow['purpose'], userId?: string): Flow {
  const f = typeof id === 'string' ? flows.get(id) : undefined;
  if (typeof id === 'string') flows.delete(id);
  if (!f || f.expires < Date.now() || f.purpose !== purpose || (userId !== undefined && f.userId !== userId)) throw new Error('That took too long, or was not for this. Try again.');
  return f;
}

/** Use a passkey: the user whose passkey answered the flow's challenge (and its counter is moved on). */
async function usePasskey(flow: Flow, response: AuthenticationResponseJSON): Promise<store.User> {
  const pk = store.getPasskey(String(response?.id ?? ''));
  if (!pk || (flow.userId && pk.userId !== flow.userId)) throw new Error('That passkey is not known here.');
  const r = await verifyAuthenticationResponse({
    response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rpID, requireUserVerification: false,
    credential: { id: pk.id, publicKey: pk.publicKey as Uint8Array<ArrayBuffer>, counter: pk.counter, transports: pk.transports as never },
  });
  if (!r.verified) throw new Error('That passkey did not check out.');
  store.passkeyUsed(pk.id, r.authenticationInfo.newCounter);
  return store.getUser(pk.userId)!;
}

/** Register a passkey for a user from a finished registration. */
async function registerPasskey(flow: Flow, response: RegistrationResponseJSON, userId: string, name: string) {
  const r = await verifyRegistrationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rpID, requireUserVerification: false });
  if (!r.verified) throw new Error('That passkey could not be added.');
  const c = r.registrationInfo.credential;
  store.addPasskey({ id: c.id, userId, name, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [] });
}

async function registrationOptions(u: store.User, rpID: string) {
  return generateRegistrationOptions({
    rpName: SITE, rpID, userName: u.username ?? u.displayName, userDisplayName: u.displayName, userID: new TextEncoder().encode(u.id), attestationType: 'none',
    excludeCredentials: store.listPasskeys(u.id).map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
}

// ------------------------------------------------------------------------------------ routes

const Proof = z.object({ password: z.string().max(200).optional(), passkey: z.object({ flow: z.string(), response: z.unknown() }).optional() }).optional();

export function mountAccounts(app: Express, o: { sameOrigin: (req: http.IncomingMessage) => boolean }) {
  /** The page's origin and the site name passkeys belong to; refused for a request from another site. */
  const rpOf = (req: Request): { origin: string; rpID: string } => {
    const origin = req.headers.origin;
    if (!origin || !o.sameOrigin(req)) throw new Error('Passkeys work only on this site.');
    return { origin, rpID: new URL(origin).hostname };
  };

  /** Run a handler, answering its thrown error as a 400. */
  const handle = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: (e as Error).message });
    }
  };

  /** That the signed-in user is who they say: their current password, or a passkey they just used. */
  const prove = async (u: store.User, proof: z.infer<typeof Proof>) => {
    if (proof?.password !== undefined) {
      if (locked(`u:${u.id}`)) throw new Error('Too many failed attempts. Try again in a few minutes.');
      if (!store.checkPassword(u, proof.password)) {
        fail(`u:${u.id}`);
        throw new Error('Your current password is wrong.');
      }
      return;
    }
    if (proof?.passkey) {
      await usePasskey(takeFlow(proof.passkey.flow, 'proof', u.id), proof.passkey.response as AuthenticationResponseJSON);
      return;
    }
    throw new Error('Confirm it is you first: your current password, or one of your passkeys.');
  };

  // ---------------------------------------------------------------- signing in

  app.post('/api/auth/login', (req, res) => {
    const body = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'User name and password are required.' });
    const keys = [`u:${body.data.username.trim().toLowerCase()}`, `ip:${req.ip}`];
    if (keys.some(locked)) return tooMany(res);
    const u = store.verifyUser(body.data.username, body.data.password);
    if (!u) {
      keys.forEach(fail);
      return void res.status(401).json({ error: 'Wrong user name or password.' });
    }
    keys.forEach((k) => failures.delete(k));
    setSession(req, res, store.createSession(u.id));
    res.json(meOf(u));
  });

  app.post('/api/auth/passkey/start', handle(async (req, res) => {
    const rp = rpOf(req);
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
    res.json({ flow: newFlow({ challenge: options.challenge, ...rp, purpose: 'sign-in' }), options });
  }));

  app.post('/api/auth/passkey/finish', handle(async (req, res) => {
    if (locked(`ip:${req.ip}`)) return tooMany(res);
    let u: store.User;
    try {
      u = await usePasskey(takeFlow(req.body?.flow, 'sign-in'), req.body?.response as AuthenticationResponseJSON);
    } catch (e) {
      fail(`ip:${req.ip}`);
      throw e;
    }
    if (u.status !== 'active') throw new Error(u.status === 'disabled' ? 'This account is disabled.' : 'This account is not set up yet.');
    setSession(req, res, store.createSession(u.id));
    res.json(meOf(u));
  }));

  app.post('/api/auth/logout', (req, res) => {
    const t = cookie(req, 'gd_session');
    if (t) store.deleteSession(t);
    res.setHeader('Set-Cookie', `gd_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- joining by invite

  /** The invited account behind a code (wrong codes count against the address). */
  const invited = (req: Request): store.User => {
    if (locked(`join:${req.ip}`)) throw new Error('Too many failed attempts. Try again in a few minutes.');
    const u = store.userByInvite(String(req.params.code ?? ''));
    if (!u) {
      fail(`join:${req.ip}`);
      throw new Error('This invite link is not valid (it may have been used or have expired). Ask for a new one.');
    }
    return u;
  };
  const JoinName = z.object({ username: z.string().max(40).optional(), displayName: z.string().max(60).optional() });

  /** The user name chosen when setting up (an account reset keeps the one it has). */
  const chosenName = (u: store.User, username?: string) => u.username ?? store.validUsername(username ?? '');

  app.get('/api/join/:code', handle((req, res) => {
    const u = invited(req);
    res.json({ username: u.username, displayName: u.displayName });
  }));

  app.post('/api/join/:code/password', handle((req, res) => {
    const u = invited(req);
    const body = JoinName.extend({ password: z.string().max(200) }).parse(req.body);
    store.claimInvite(u.id, body);
    store.setPassword(u.id, body.password);
    store.activateUser(u.id);
    setSession(req, res, store.createSession(u.id));
    res.json(meOf(store.getUser(u.id)!));
  }));

  app.post('/api/join/:code/passkey/start', handle(async (req, res) => {
    const u = invited(req);
    const body = z.object({ username: z.string().max(40).optional() }).parse(req.body ?? {});
    const rp = rpOf(req);
    // The passkey carries the user name, so it is chosen (and checked) before the device makes one.
    const options = await registrationOptions({ ...u, username: chosenName(u, body.username) }, rp.rpID);
    res.json({ flow: newFlow({ challenge: options.challenge, ...rp, purpose: 'register', userId: u.id }), options });
  }));

  app.post('/api/join/:code/passkey/finish', handle(async (req, res) => {
    const u = invited(req);
    const body = JoinName.extend({ flow: z.string(), response: z.unknown(), name: z.string().max(40).default('Passkey') }).parse(req.body);
    const flow = takeFlow(body.flow, 'register', u.id);
    store.claimInvite(u.id, body);
    await registerPasskey(flow, body.response as RegistrationResponseJSON, u.id, body.name);
    store.activateUser(u.id);
    setSession(req, res, store.createSession(u.id));
    res.json(meOf(store.getUser(u.id)!));
  }));

  // ---------------------------------------------------------------- your account

  app.get('/api/me', auth, (req, res) => {
    res.json(meOf((req as AuthedRequest).user));
  });

  app.patch('/api/account', auth, handle((req, res) => {
    const u = (req as AuthedRequest).user;
    const body = z.object({ displayName: z.string().max(60) }).parse(req.body);
    store.setDisplayName(u.id, body.displayName);
    res.json(meOf(store.getUser(u.id)!));
  }));

  /** Start a passkey proof (to confirm it is you before changing how you sign in). */
  app.post('/api/account/proof/start', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    const rp = rpOf(req);
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred', allowCredentials: store.listPasskeys(u.id).map((p) => ({ id: p.id, transports: p.transports })) });
    res.json({ flow: newFlow({ challenge: options.challenge, ...rp, purpose: 'proof', userId: u.id }), options });
  }));

  /** Set or replace your password. Your other sessions are signed out. */
  app.post('/api/account/password', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    const body = z.object({ proof: Proof, next: z.string().max(200) }).parse(req.body);
    await prove(u, body.proof);
    store.setPassword(u.id, body.next, cookie(req, 'gd_session'));
    res.json(meOf(store.getUser(u.id)!));
  }));

  app.delete('/api/account/password', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    await prove(u, Proof.parse(req.body?.proof));
    store.clearPassword(u.id);
    res.json(meOf(store.getUser(u.id)!));
  }));

  app.post('/api/account/passkeys/start', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    await prove(u, Proof.parse(req.body?.proof));
    const rp = rpOf(req);
    const options = await registrationOptions(u, rp.rpID);
    res.json({ flow: newFlow({ challenge: options.challenge, ...rp, purpose: 'register', userId: u.id }), options });
  }));

  app.post('/api/account/passkeys/finish', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    const body = z.object({ flow: z.string(), response: z.unknown(), name: z.string().max(40).default('Passkey') }).parse(req.body);
    await registerPasskey(takeFlow(body.flow, 'register', u.id), body.response as RegistrationResponseJSON, u.id, body.name);
    res.json(meOf(store.getUser(u.id)!));
  }));

  app.delete('/api/account/passkeys/:id', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    await prove(u, Proof.parse(req.body?.proof));
    store.removePasskey(u.id, String(req.params.id), true);
    res.json(meOf(store.getUser(u.id)!));
  }));

  // ---------------------------------------------------------------- administration

  /** An administrator's change to another account (not their own: no locking yourself out by a slip). */
  const target = (req: Request): store.User => {
    const id = String(req.params.id);
    if (id === (req as AuthedRequest).user.id) throw new Error('Change your own account on the Account page.');
    const u = store.getUser(id);
    if (!u) throw new Error('No such user.');
    return u;
  };

  app.get('/api/admin/users', auth, adminOnly, (_req, res) => {
    res.json(store.listUsers().map(userRow));
  });

  /** The whole server's AI spending today and its ceiling. */
  app.get('/api/admin/spending', auth, adminOnly, (_req, res) => {
    const s = genai().config.spending ?? {};
    res.json({ today: round(store.spentTodayTotal()), dailyTotalUsd: s.dailyTotalUsd ?? null, adminsUnlimited: s.adminsUnlimited !== false, systemMonth: round(store.spentThisMonth('system').usd) });
  });

  /** Make an account: invited, with a name saying who it is for and a code for its invite link. */
  app.post('/api/admin/users', auth, adminOnly, handle((req, res) => {
    const body = z.object({ displayName: z.string().max(60), isAdmin: z.boolean().default(false), monthlyBudgetUsd: z.number().min(0).max(10_000).optional() }).parse(req.body);
    res.json(userRow(store.createUser(body)));
  }));

  app.patch('/api/admin/users/:id', auth, adminOnly, handle((req, res) => {
    const u = target(req);
    const body = z.object({ displayName: z.string().max(60).optional(), monthlyBudgetUsd: z.number().min(0).max(10_000).optional(), isAdmin: z.boolean().optional(), enabled: z.boolean().optional() }).parse(req.body);
    if (body.displayName !== undefined) store.setDisplayName(u.id, body.displayName);
    if (body.monthlyBudgetUsd !== undefined) store.setMonthlyBudget(u.id, body.monthlyBudgetUsd);
    if (body.isAdmin !== undefined) store.setAdmin(u.id, body.isAdmin);
    if (body.enabled !== undefined) store.setEnabled(u.id, body.enabled);
    res.json(userRow(store.getUser(u.id)!));
  }));

  /** Invited again with a new code: its password and passkeys are removed and it is signed out. */
  app.post('/api/admin/users/:id/reset', auth, adminOnly, handle((req, res) => {
    res.json(userRow(store.resetUser(target(req).id)));
  }));

  app.delete('/api/admin/users/:id/passkeys/:pid', auth, adminOnly, handle((req, res) => {
    const u = target(req);
    store.removePasskey(u.id, String(req.params.pid), false);
    res.json(userRow(store.getUser(u.id)!));
  }));
}
