/** Who is asking: the session cookie, signed-in users, and administrators. */
import type http from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import * as store from './storage';

export function cookie(req: Request | http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return undefined; // a malformed cookie is no session
    }
  }
  return undefined;
}

export type AuthedRequest = Request & { user: store.User };

/** Signed-in users only (an active account: a disabled one's sessions end). */
export function auth(req: Request, res: Response, next: NextFunction) {
  const user = store.sessionUser(cookie(req, 'gd_session'));
  if (!user) return void res.status(401).json({ error: 'Please sign in.' });
  (req as AuthedRequest).user = user;
  next();
}

export function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (!(req as AuthedRequest).user?.isAdmin) return void res.status(403).json({ error: 'Admins only.' });
  next();
}
