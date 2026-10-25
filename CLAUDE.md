# Generative Daydream: notes for Claude

A GenAI-built 2D top-down RPG. An owner describes a theme; a job builds the whole world once (rules, places
painted as top-down maps, people, story, art, animation), and then anyone plays it in their own saves. In the
interface a world is a **daydream** and a save is a **reverie**. Start with `README.md`, then the doc for the area
you touch.

## Where things are explained

| Doc | Covers |
|---|---|
| `README.md` | What the game is, package layout, storage, model purposes, quick start |
| `docs/server-architecture.md` | Accounts, who may see or play what, jobs and workers, the model gateway, the admin GPU page |
| `docs/hosting.md` | The production box (systemd, Caddy, credentials), deploying, one-time upgrades, console tools there, moving worlds |
| `docs/gpu-broker.md` | The GPU broker: every installation's ComfyUI work goes through it |
| `docs/places.md` | How a place is painted, read for walkable ground, and furnished |
| `docs/world-art.md` | Characters, creatures, objects and icons: prompts, painting, cutting out, checks; animation |
| `docs/rulesets.md` | Generated rules: the power budget and the balance simulation |

## Commands

- `npm run dev`: server on 3000 (restarts on every change), job worker (pauses its jobs at a safe point and
  restarts with new code), client on 5173.
- `npx vitest run` from the repository root, and only from there. Tests use `data-test/` and a config with no
  models, never `data/`. After a database schema change, delete `data-test/gd.sqlite*` before running them.
- `npm run typecheck` covers all four packages.
- Console tools live in `packages/server/src/cli/`, each documented at its top. Run them with
  `npx tsx src/cli/<tool>.ts` from `packages/server`:
  - `users`: invites, resets, administrators.
  - `worldpack`: move a world and its saves between machines.
  - `placepeek`: see a place's map, walkable ground and placements.
  - `paintworld`, `resettle`, `animate`: rework a built world's art, places or animation.
  - `genlive`: build a world from the command line.
  - `npctalk`: talk to a world's people without saving.
  - `paintpeek`: try the art pipeline on a few assets.
  - `strictcheck`: check every model schema against OpenAI's strict mode.

## Rules of the house

- **Secrets.**
  - Never print or commit `.env`, `config/genai*.json`, `config/broker.json` or anything holding API keys.
  - If a local config needs a change, make it without echoing values (or tell the user exactly what to change),
    and keep any backup outside the repository unless git ignores it.
- **Spend.**
  - OpenAI calls cost real money and builds take hours of GPU.
  - Keep spend deliberate and report it.
  - Prefer the saved steps of a build (`data/worlds/<id>/draft/`) and the peek tools over building again.
- **No backwards compatibility.**
  - Old worlds, saves and characters need not keep working.
  - Every database change needs an upgrade path: a script in `deploy/` (see `deploy/upgrade-accounts.cjs`) and
    steps in `docs/hosting.md`.
  - Upgrade the user's dev database too (back it up first).
- **Dependencies.** Ask the user before installing anything new.
- **Security.**
  - What matters is authentication, access to other people's things, remote code execution and writing arbitrary
    files.
  - Players cheating in their own game does not matter.
- **Words.**
  - Game text uses plain game terms (Health, Gold, Fire) unless a theme truly needs another word.
  - The interface says daydream and reverie.
  - Docs and reports are full sentences a cold reader can follow.
- **Quality.** Aim for studio quality and simple, general rules over special cases. Match the surrounding code's
  comment density and naming.
- **Git.**
  - In a worktree, commit on its branch.
  - Merge into main or push only when the user says so.
  - Never commit `.claude/launch.json` port changes made for a worktree.

## Working on it

- **Several checkouts.** Worktrees under `.claude/worktrees/` each have their own `data/`. A worktree can run on
  other ports through its `.claude/launch.json`, such as 3100/5180. Worlds built in one checkout are moved to
  another with `worldpack`.
- **Accounts in development.**
  - `config/dev-test-account.example.json` names the local test account used for automated playtests.
  - Invites (`#/invite/<code>`), passkeys and the first-administrator rule are described in
    `docs/server-architecture.md`.
  - Passkeys need a real host name or `localhost`, and an automated browser has no authenticator.
- **Browser playtests.**
  - The game screen exposes `window.__gd`, the game client: `state`, and `send(message)` with the messages in
    `packages/shared/src/protocol.ts`.
  - Administrators also have `dev` messages: `goto` a place, `reveal` the map, `peace`, and `reload` the world.
  - Screenshots often show the previous frame; take another.
  - A test that saves a reverie in real data must delete it afterwards.
- **Model work.**
  - Text, decisions and speech use OpenAI (Luna, with Sol as the stronger check).
  - Images use ComfyUI behind the GPU broker (`npm run broker` on the GPU PC).
  - The server refuses to start on a provider type it does not know.
- **Builds.**
  - A build runs as a job with checkpoints. Restarting the server or worker is safe: jobs resume.
  - A change to server or shared code restarts the worker at its next safe point.
