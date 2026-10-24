# Server architecture: accounts, jobs and model access

The game server answers players; long work (building a world, painting it, rebalancing rules, studio edits)
runs as **jobs** that survive restarts; every model call goes through one **gateway** that shares scarce models
fairly. This keeps the server responsive and lets development continue while worlds are being built.

## Accounts

- Invite only: there is no sign-up. An administrator creates an account on the **Users** page (or with
  `npm run users -w @gd/server -- invite <id> [--admin]`); the server makes a one-time password shown once.
- Signing in with a one-time password allows nothing but choosing a new password (the API answers
  `403 password_change_required`; game connections are refused).
- Users change their password with their current one; their other sessions are signed out.
- Administrators reset passwords (a new one-time password; every session of that user ends) and set each
  account to `normal` or `admin`. The last administrator cannot be demoted.
- A server without accounts creates `admin` with a one-time password printed to the console.
- Repeated failed sign-ins lock that user id and address out for a while.

Code: `storage.ts` (users, sessions), `auth.ts` (sign-in and admin middleware), `index.ts` (routes), `cli/users.ts`, client `screens/Auth.tsx` and
`screens/Account.tsx`.

## Jobs

A job is a row in the shared SQLite database (`jobs/queue.ts`): kind (`world`, `rules`, `art`, `studio`, `animate`), its
world, owner, parameters, status, progress, the stage checklist, a log (`job_log`) and a **lease**.

```
queued → running ⇄ waiting → done | failed | cancelled
              ↑ lease runs out (worker stopped) → claimed again, resumes
```

- The web server only enqueues (one active job per world, at most two per player) and reads progress.
- A **worker** (`jobs/worker.ts`) claims the most urgent queued job, renews its lease while working, and runs
  it. A worker that dies lets its lease lapse; the job is claimed again and resumes.
- **Checkpoints**: a world build saves each finished step (concept, rules, atlas, creatures, story, each
  zone's content, the balanced rules, and every step of every place's painting) under `data/worlds/<id>/draft/`. A resumed build skips them; the seed
  is fixed when the job is queued, so the resumed world is the same world. Painting saves every image as it is
  approved, so a resumed paint job continues with what is left. Studio tasks resume after their first stage.
- **Safe points**: asked to restart, a worker sets `yieldRequested`; jobs stop at the next stage boundary,
  zone, or painting round (images already painted are scored and kept), are re-queued, and the worker exits.
- **Cancel** marks the job; it stops at its next check. A job's model calls carry its cancel check (call
  context `cancelled`): a ComfyUI prompt it is waiting on is removed or interrupted, an animator step is killed,
  and a call still waiting for the GPU gives up its turn. What it finished stays for a later resume.

### Processes

| mode | how | when |
| --- | --- | --- |
| in-process | `npm start` (default) | one machine, simplest |
| separate worker | `GD_WORKER=external` on the server, `npm run worker -w @gd/server` (one or more) | development, and to scale work out |

`npm run dev` runs the server under `tsx watch` and the worker separately: a code change restarts the server
at once, and touches `data/.worker-reload`; the worker pauses its jobs at their next safe point, exits with
code 75 and is started again with the new code. Nothing being built is lost.

Several workers may share one database (each claims different jobs). `jobConcurrency` in `config/genai.json`
sets how many jobs one worker runs at once (default 1, for a single local GPU).

## Model gateway

Every call (`genai/service.ts`) carries a priority from its context (`genai/context.ts`): **interactive**
(a player waiting on an NPC: `npc.*`, `narration`), **studio** (an owner editing), **background** (building and
painting).

- **Local GPU groups** (`genai/gpu.ts`): within a process, calls on a group run one at a time, most urgent
  first. Across processes, a lease in the database decides who uses the GPU: a process keeps it while it has
  work (so batches stay on one loaded model), hands it over between calls when someone more urgent waits, and
  after 90 s to anyone waiting. A process that exits frees it; one that dies loses it within 45 s. The process
  that takes over unloads whatever another left loaded.
- **Back-pressure**: when a provider is busy, rate-limited, overloaded or unreachable, the call waits and
  retries with backoff instead of failing. Player-facing calls give up after ~12 s (the game falls back to
  procedural behaviour); background work waits up to `waitForModelsMs` (default 30 min) and its job shows
  `waiting` with the reason, then carries on.
- Non-transient errors (bad requests, unparseable output after retries) are tried again a few times; then
  the build stops, to be resumed once the model works.

## The admin GPU page

`#/gpu` (`client/src/screens/Gpu.tsx`, API `server/src/gpu/admin.ts` under `/api/admin/gpu`, administrators
only) shows and controls everything that uses the GPU. GPU work passes through several layers, and the page is
one view over them rather than another queue:

| layer | where | what the page shows | what it controls |
| --- | --- | --- | --- |
| job queue | `jobs` table | running and waiting jobs (owner, world, priority, step, elapsed, which worker), recent outcomes | cancel / stop, priority, move up or down |
| build GPU queue | in memory, per build (`worldgen/gpu.ts`) | each build's running and pending GPU tasks | — |
| GPU scheduler | in memory per process, lease in `gpu_lease` (`genai/gpu.ts`) | who holds each GPU group, the call running (model, job, elapsed), who waits | pause (all, or animation alone) |
| ComfyUI | its HTTP API | running and pending prompts by origin, recent failures, prompts and images per hour | remove / interrupt a prompt, unload models |
| GPU | `nvidia-smi`, else ComfyUI `/system_stats` | VRAM in use, utilisation | — |
| animator | the `animate` job, per-actor files | actors waiting and failed (with the error) per world | retry a failed actor |

The schedulers live in memory, and in development the worker and CLI runs are separate processes, so the web
server cannot see them directly. Each process therefore publishes its **presence** (`gpu/presence.ts`): a
`gpu_procs` row with its role (`server`, `worker`, `cli` + script and arguments), the GPU calls queued and
running in its scheduler, its builds' GPU queues and the jobs it runs, written within a second of a change and
every 5–15 s as a heartbeat (silent for 20 s: shown as gone). Every ComfyUI prompt carries a tag in
`extra_data.gd` (process, role, job id, world, kind, workflow; the animator's Python steps get it through
`GD_PROMPT_TAG`), so prompts from CLI runs are labelled too. Processes on older code send no tag: their prompts
show as *untagged* (client `generative-daydream`) and their lease holder as *unregistered*, most likely a CLI run.

Controls act through the same shared layers, so they reach the separate worker:

- **Pause** (`gpu_control`): workers claim no new job (or no `animate` job), and each process's GPU scheduler
  holds calls of paused work before their next turn while players' calls (rank 0) go past them; a held call
  does not keep the GPU lease from other processes. The call in progress finishes.
- **Stop** a running job: its cancel flag, plus removing or interrupting every ComfyUI prompt tagged with its id.
- **Priority / move**: a queued job's priority, or a swap of priority and queued-at time with its neighbour.
- **ComfyUI prompts** of any origin (CLI runs included) can be removed (pending) or interrupted (running, only
  if it is still the one running); **unload** frees ComfyUI's models and every loaded LLM router model.
- CLI runs are outside the job queue: only their ComfyUI prompts can be controlled; they are stopped in their
  terminal.

Destructive actions need `confirm: true` (the page asks first) and every action is written to `gpu_audit` with
the administrator's name, shown as the page's admin log. The page polls every 2 s; reading every actor's
animation files is cached for 15 s.

## Models and providers

The server decides which model serves each purpose (`config/genai.json`: `providers` and `purposes`); players
do not choose and there are no per-user keys. Local models are configured today (llama.cpp router, ComfyUI,
llama.cpp decision models). Provider adapters for OpenAI-compatible APIs, OpenAI Responses, Anthropic and
Google (text and images) exist behind the same purpose interface, so moving a purpose to a hosted model is a
config change: the gateway's priorities, waiting and retries apply to every provider, and `concurrency` per
provider limits parallel calls.

## Growing further

- Many machines: move the queue and leases from SQLite to Postgres (or Redis), and world folders and art to
  object storage; workers then run anywhere.
- Game instances still live in the web server process; a separate game runtime with snapshotting would let
  the web tier restart without disconnecting players.
- Per-purpose budgets and cost estimates before large hosted-image runs.
