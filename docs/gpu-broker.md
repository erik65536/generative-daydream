# GPU broker

Stage 1 is built: the broker (`packages/gpu-broker`, `npm run broker`), the ComfyUI pass-through, holds, and the
game's one ComfyUI client. Stages 2–4 below are still to do.

## The problem

There is one GPU (16 GB, on the GPU PC) and more than one installation of the game using it:
- production on the game box;
- development on the GPU PC itself;
- later, perhaps a second checkout or a CLI run.

Before the broker, each installation decided GPU turns with a lease in **its own** SQLite database, so the
installations cannot see each other. Two things go wrong when they overlap:
- **Both sides switch models freely.** The game unloads ComfyUI (`/free`) between Krea, SAM 3 and SeedVR2,
  because together they do not fit. Production and development, each unaware of the other, interleave their
  prompts. The best case is slow model switching. The worst case is running out of memory, if a model such as
  SeedVR2 does not give its memory back.
- **SkinTokens runs outside ComfyUI.** It needs about 14 GB. The animator frees ComfyUI's memory and starts it,
  but a painting queued by the other installation in the meantime loads Krea on top of it.

A shared lock would fix this only while every GPU program cooperates. Each program would also have to know how to
unload every other program. Every new GPU tool would make that worse.

## The idea

A **broker** runs on the GPU PC and is **the only way to reach the GPU**:
- Each GPU program sits behind an **adapter** that knows how to run its work and how to free its memory.
- Callers (production, development, CLI runs) send work with a priority, and the broker runs it one piece at a
  time.
- ComfyUI goes back to listening on 127.0.0.1, so nothing else can reach it.
- Adding a GPU tool later means writing one adapter. The callers do not change.

```
game box (prod) ──┐                       ┌─ ComfyUI 127.0.0.1:8188   (Krea, SAM 3, Qwen edit, SeedVR2,
                  ├─▶ broker :8190 (LAN) ─┤                            Pixal3D, SAM 3D Body, BiRefNet)
GPU PC (dev) ─────┘   one queue, one      └─ SkinTokens (runs demo.py in its venv, one task at a time)
                      program on the GPU     … later: any other GPU tool as one more adapter
```

## The broker

- **Code:** a new workspace package, `packages/gpu-broker`, written in Node and TypeScript, with shared types in
  `packages/shared`.
- **How it runs:** on the GPU PC as a long-lived process of its own. It does not start or stop with `npm run dev`,
  so restarting development never drops production's work. It is started by hand (`npm run broker`), like
  ComfyUI, with no service or scheduled task. While it is not running, both installations' GPU work waits, and
  their jobs say they are waiting for the GPU broker.
- **Config:** `config/broker.json`, git-ignored:

```jsonc
{
  "listen": "0.0.0.0:8190",
  "clients": { "prod": "credential-or-env:...", "dev": "..." },   // one bearer token per installation
  "adapters": {
    "comfyui":    { "url": "http://127.0.0.1:8188", "freeBetweenModels": true },
    "skintokens": { "dir": "E:/tools/skintokens", "python": "E:/tools/skintokens/.venv/Scripts/python.exe" }
  },
  "holdMs": 180000,   // how long one caller's model may keep the GPU while others of the same rank wait
  "graceMs": 1500     // after a piece of work ends, how long to wait for that caller's next piece on the same model
}
```

- **Security:**
  - Every request carries `Authorization: Bearer <token>`, and the token names the client (prod or dev), which the
    queue and the admin page show.
  - The Windows firewall allows port 8190 from the game box only. Development reaches the broker on 127.0.0.1.
  - Production keeps its token as the systemd credential `gpu-broker`.

### The adapter interface

```ts
/** One GPU program behind the broker. */
interface GpuAdapter<W = unknown> {
  readonly name: string;                       // "comfyui", "skintokens", …
  /** The model a piece of work loads. Work for the loaded model runs back to back without unloading. */
  modelOf(work: W): string;
  /** Whether changing models inside this program needs an unload first (ComfyUI: yes, they do not fit together). */
  readonly freeBetweenModels?: boolean;
  /** Answering at all (the admin page; work is held, not failed, while it is down). */
  alive(): Promise<boolean>;
  /** Do the work. `signal` aborts it (a caller cancelled). Progress goes to the queue view. */
  run(work: W, ctx: { id: string; signal: AbortSignal; progress(p: number, step?: string): void }): Promise<unknown>;
  /** Give back every byte of GPU memory this program holds. */
  unload(): Promise<void>;
}
```

How the two first adapters fill it in:

| | ComfyUI | SkinTokens |
|---|---|---|
| `modelOf` | the `workflow` named in the prompt's `extra_data.gd` tag, else the loader nodes' model files (the same parsing as `workflowModels` in `gpu/comfyqueue.ts`) | `"skintokens"` |
| `run` | `POST /prompt` with `prompt_id` set to the broker's own id (ComfyUI accepts an id chosen by the caller, as a UUID), then wait until `/history/<id>` says it is done or failed | start `demo.py --input mesh.glb --output skintokens.glb` in a temporary folder; the result is the output file |
| `unload` | `POST /free {unload_models: true, free_memory: true}` | nothing: the process has exited and its memory is free |
| abort | remove the prompt from ComfyUI's queue, or `/interrupt` if it is running | kill the process tree |

### The scheduler

There is one queue for the whole GPU, and only one piece of work runs at a time across all adapters. When the
broker picks the next piece:
1. **Rank first.** The caller's rank: 0 means a player is waiting, 1 a studio edit, 2 a world build,
   3 background animation. This keeps the game's current order: work a player is waiting on goes before a build.
2. **Stay on the loaded model.** Among equal ranks, work for the loaded adapter and model goes first. After a piece
   finishes, the broker waits `graceMs` for the same caller's next piece. Callers submit one piece, wait for it,
   then submit the next; without the grace period, every gap would hand the GPU to the other installation and
   force a model switch.
3. **Fairness.** A caller keeps the loaded model for at most `holdMs` while another caller of the same rank waits.
   After that the turn passes, oldest work first. Development cannot starve production, and production cannot
   starve development.
4. **Switching.** Before running work for a different adapter, the broker calls `unload()` on the resident one.
   For the same adapter with another model, it unloads only if the adapter is `freeBetweenModels`. While the
   broker does not know what is loaded (just started, or after an error), it unloads every adapter first, as
   `evictOthers` does today.
5. **Down adapters.** Work for an adapter that does not answer stays queued, the caller is told it is waiting, and
   other adapters' work goes ahead.

Admin controls live in the broker, where they cover every installation:
- pause everything, or one kind of work (as the animation pause does today);
- cancel a piece of work;
- move a piece up or down.

The queue is kept in memory. If the broker restarts, callers polling an id it no longer knows get a 404. The game
treats that as a retryable error and submits again, as it already does when ComfyUI is unreachable.

## How ComfyUI requests pass through

The broker speaks ComfyUI's own HTTP API, so the game's ComfyUI code keeps its shape:

| Request | What the broker does |
|---|---|
| `POST /upload/image` | Passes it straight to ComfyUI. Uploads use no GPU, so they are not queued. |
| `POST /prompt` | Gives the prompt an id and queues it with its rank and tag from `extra_data.gd`. Answers at once with `{prompt_id}`. |
| `GET /history/<id>` | **Queued:** `{}`, the same "not yet" ComfyUI gives, plus the header `X-Broker-State: queued; position=3`. **Running or finished:** ComfyUI's own answer for that id, with `X-Broker-State: running` or `done`. **Unknown id:** 404. |
| `GET /view?…` | Passes it straight through: the output files are ComfyUI's. |
| `POST /queue {delete:[id]}`, `POST /interrupt` | Cancels that one piece of work, whether it is queued in the broker or running in ComfyUI. Never another client's work. |
| `POST /free` | Ignored and answered OK. Only the broker unloads. |
| `GET /system_stats` | ComfyUI's answer, plus the broker's own `nvidia-smi` reading. The broker runs on the GPU PC, so the admin page gets real VRAM numbers again. |
| `GET /broker/queue` | New: every client's work, queued and running, the resident model and the pauses. This is what the admin GPU page reads. |

**Timeouts:** today a caller's deadline counts from when it submits (5–15 minutes). Time spent waiting behind the
other installation must not count against it. While `X-Broker-State` says `queued`, the caller does not count
time, and reports "waiting for the GPU (position 3)" to its job. Plain ComfyUI never sends the header, so the same
caller still works without a broker.

## Animation: its GPU steps become broker work

Each step of the animator (`anim/animator.ts`, `packages/server/animator/`) needs something different:

| Step | Needs | Where it runs after this pass |
|---|---|---|
| mesh (Pixal3D), body (SAM 3D Body) | ComfyUI | Python on the game box sends the prompts through the broker (its `comfy.py` uses the broker's URL and token) |
| skintokens (non-humanoid rig) | the GPU alone, outside ComfyUI | **the broker's `skintokens` adapter**: `mesh.glb` goes up, `skintokens.glb` comes back |
| rig-human, rig-auto, retarget | CPU: numpy, scipy, Pillow | the game box: `apt install python3-numpy python3-scipy python3-pil` |
| render (three.js sheets) | WebGL in headless Chromium | the game box, on its integrated graphics (or software rendering) |

The animator therefore does **not** move to the GPU PC as a whole:
- Its orchestration stays in the game: the checkpoints in `data/worlds/<id>/anim/<key>`, the retry with another
  seed when a mesh loses parts, and the leg check.
- Only the work that needs the GPU crosses to the broker.
- The broker stays a general GPU runner with no game logic in it.

For SkinTokens, the broker takes a general **task** request for adapters that work on files instead of speaking a
protocol of their own:

```
POST   /broker/tasks            multipart: adapter=skintokens, rank, tag, args (JSON), files (mesh.glb)  → {id}
GET    /broker/tasks/<id>       → {state: queued|running|done|failed, position?, progress?, error?, files?: [...]}
GET    /broker/tasks/<id>/files/<name>
DELETE /broker/tasks/<id>       cancel
```

The renderer is the first candidate for another adapter. If rendering on the box's integrated graphics proves too
slow, a `render` adapter on the GPU PC takes the rig files and returns the sheets. Nothing else changes.

## What changes in the game

1. **One ComfyUI client.** `worldgen/comfy.ts`'s `execute` and `ComfyUIProvider.run` in `genai/providers.ts` are
   two copies of the same submit-and-wait loop. Merge them into one function that:
   - sends the bearer token;
   - follows `X-Broker-State` for the deadline and the waiting message;
   - treats a 404 on its own id as retryable;
   - cancels through `/queue {delete}`.

   `animator/comfy.py` gets the same rules.
2. **A rank on every prompt.** `PromptTag` (`gpu/presence.ts`) gains `rank`, taken from the call's priority in
   `callContext()`: interactive 0, studio 1, background 2, animation 3. The Python steps already receive the tag
   through `GD_PROMPT_TAG`.
3. **No in-game GPU lease.** The `comfy` provider has the broker's URL and token. The game's own lease and
   unloading (`genai/gpu.ts`) are gone: the broker is the only door to the GPU.
4. **A build's own GPU order stays.** `worldgen/gpu.ts` (`GpuQueue`) still orders one build's work, so each place
   is painted, read and upscaled before the next starts, and the build's own steps are not interleaved. The broker
   orders between callers, and the build orders within itself.
5. **The animator's SkinTokens step goes through the broker.** `animation.skintokens` becomes
   `{ "broker": true }`: upload the mesh, wait for the task, download the rig. The `exclusive()` workaround (posing
   as a provider in the ComfyUI group) goes away. `animation.python` on the box is `/usr/bin/python3`.
6. **The admin GPU page** reads `/broker/queue` (every installation's work, the resident model, real VRAM) and
   sends pause, cancel and reorder to the broker. The game's own process view (the jobs and build queues of each
   process, from `gpu/presence.ts`) stays as it is.
7. **Config.** Both installations point `comfy.baseUrl` at the broker:
   - development at `http://127.0.0.1:8190`;
   - production at `http://<GPU PC LAN address>:8190`, with `apiKey: "credential:gpu-broker"`.

   ComfyUI goes back to `--listen 127.0.0.1`. The firewall rule from `docs/hosting.md` moves from port 8188 to
   8190.

## Order of work

1. **Broker core, ComfyUI pass-through and the unified client. Done.**
   - Tests: the scheduler with fake programs (`packages/gpu-broker/test/scheduler.test.ts`), the pass-through
     against a fake ComfyUI (`front.test.ts`), and the game's client waiting in the broker's queue
     (`packages/server/test/comfyclient.test.ts`).
   - Tried on the GPU PC: a production-style painting with a token waited behind a development hold, was told
     "Waiting for the GPU (next)", then painted through the real ComfyUI.
   - Also built: **holds** (`POST /broker/holds`, then `GET` at least every 30 s, `DELETE` to end). A hold is a
     turn on the whole GPU for a program the caller runs itself on the GPU PC. Development's SkinTokens uses one
     (`withBrokerHold` in `genai/comfyclient.ts`) until the SkinTokens adapter of stage 3.
   - **To use it in development:**
     - Copy `config/broker.example.json` to `config/broker.json` and start it with `npm run broker`.
     - In `config/genai.json`, give the `comfy` provider `"baseUrl": "http://127.0.0.1:8190"`.
     - Requests from this PC need no token.
2. **Production through the broker.** Firewall on 8190, ComfyUI on localhost only. Check it by running a
   production build and a development build at once and watching the broker's queue and VRAM.
3. **SkinTokens adapter and animation in production.**
   - The box installs Python's numpy, scipy and Pillow, and Playwright's Chromium.
   - Turn the `animation` block on in `/etc/gd/genai.json`.
   - Measure rendering on the box's integrated graphics.
4. **The admin GPU page on the broker.**

## Settled and open questions

- **SeedVR2 and SAM 3 after `/free`:** settled. They give their memory back, so `freeBetweenModels` with ComfyUI's
  `/free` is enough.
- **Starting the broker:** settled. It is started by hand, with no service or scheduled task.
- **Rendering speed on the box:** to be tested. Integrated graphics of that generation are limited, so a `render`
  adapter on the GPU PC is likely. Measure how long eight directions of sheets take on the box before deciding.
