/**
 * The order a build's image work takes on the one local GPU. Tasks run one at a time, most urgent first; among
 * equally urgent ones, a task for the model already loaded goes first (switching models costs time). Each place has
 * its own priority, so it is painted, read and upscaled before the next starts, and places become ready one by
 * one. While Luna reads a painting, the GPU goes on to the next place's painting.
 * Loading and unloading is genai's GPU scheduler's job (every ComfyUI call goes through it); this only orders whole
 * tasks so their calls are not interleaved. Text work (Luna) runs alongside, unlimited by it.
 */

/** Which model a task loads (the reader is SAM 3 and MoGe 2 together: both are small). */
export type GpuModel = 'krea' | 'reader' | 'seedvr2';

interface Task {
  model: GpuModel;
  /** Lower runs first. */
  priority: number;
  run: () => Promise<void>;
  cancel: (e: Error) => void;
}

export class GpuQueue {
  private tasks: Task[] = [];
  private loaded: GpuModel | null = null;
  private busy = false;

  constructor(private readonly stopped: () => boolean = () => false) {}

  /** Run `fn` when its turn comes; resolves with its result. */
  run<T>(model: GpuModel, priority: number, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({ model, priority, run: () => fn().then(resolve, reject), cancel: reject });
      void this.pump();
    });
  }

  private next(): Task | undefined {
    if (!this.tasks.length) return undefined;
    const rank = (t: Task) => t.priority + (t.model === this.loaded ? 0 : 1e-6);
    const t = this.tasks.reduce((a, b) => (rank(b) < rank(a) ? b : a));
    this.tasks.splice(this.tasks.indexOf(t), 1);
    return t;
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let t = this.next(); t; t = this.next()) {
        if (this.stopped()) {
          t.cancel(new Error('cancelled'));
          continue;
        }
        this.loaded = t.model;
        await t.run();
      }
    } finally {
      this.busy = false;
    }
  }
}
