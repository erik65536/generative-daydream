/**
 * A turn on the GPU for a program the caller runs itself on this PC (SkinTokens from the animator in development):
 * when the turn comes, everything else is unloaded and the caller runs its program, then ends the turn. The caller
 * checks in at least every `staleMs` while it waits and works; a caller that stops checking in (it crashed) loses
 * its turn. The program exits when done, so there is nothing to unload.
 */
import type { GpuAdapter, RunContext } from '../scheduler';

export interface HoldWork {
  /** Last time the caller checked in. */
  seen: number;
  /** The caller ended its turn. */
  released?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HoldAdapter implements GpuAdapter<HoldWork> {
  readonly name = 'hold';
  readonly freeBetweenModels = true;
  constructor(private readonly staleMs = 30_000, private readonly tickMs = 250) {}

  async alive() {
    return true;
  }

  async unload() {}

  async run(work: HoldWork, ctx: RunContext): Promise<unknown> {
    for (;;) {
      if (work.released) return undefined;
      if (ctx.signal.aborted) throw new Error('cancelled');
      if (Date.now() - work.seen > this.staleMs) throw new Error('the caller stopped checking in');
      await sleep(this.tickMs);
    }
  }
}
