/**
 * Who a model call is for, carried through async code: how urgent it is (a player waiting on an NPC beats a
 * world build) and whom to tell while it waits for a busy or unreachable model.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Purpose } from './types';

export type Priority = 'interactive' | 'studio' | 'background';
export const PRIORITY_RANK: Record<Priority, number> = { interactive: 0, studio: 1, background: 2 };

export interface CallContext {
  priority: Priority;
  /** Told why the call is waiting (null when it goes ahead again). */
  onWait?: (why: string | null) => void;
  /** Whose budget pays for it (unset: the server's own). */
  userId?: string;
}

const store = new AsyncLocalStorage<CallContext>();

export const withCallContext = <T>(ctx: CallContext, fn: () => T): T => store.run(ctx, fn);
export const callContext = (): CallContext | undefined => store.getStore();

/** Calls made while playing are interactive unless the caller says otherwise. */
export function priorityOf(purpose: Purpose): Priority {
  const ctx = store.getStore();
  if (ctx) return ctx.priority;
  return purpose.startsWith('npc.') || purpose === 'narration' ? 'interactive' : 'background';
}
