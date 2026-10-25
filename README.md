# Generative Daydream

A GenAI-driven 2D top-down RPG engine. Describe a theme — high fantasy, a derelict space station, a cozy animal village, an office printer apocalypse — and the engine dreams up its places, people, monsters, items, rules, main story and twists, then lets you walk into it and play: real-time exploration, Divinity-style turn-based combat, free-text conversations with people who remember you and can change your quests.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 and sign in as `admin` with the one-time password the server prints on its first start (you choose your own password next). Accounts are invite only: administrators create them on the **Users** page, and `npm run users -w @gd/server -- reset <user id>` resets a password from the console. Building a daydream needs OpenAI and ComfyUI behind the GPU broker (below); then choose **Dream a new daydream**.

- `npm run dev` — game server (port 3000, restarts on every change), job worker (pauses its jobs at a safe point and restarts with new code; they resume from checkpoints) + Vite client (port 5173)
- `npm run build && npm start` — production: the server also serves the built client on port 3000 (`GD_PORT` to change) and runs jobs itself; set `GD_WORKER=external` and run `npm run worker -w @gd/server` (one or more) to run them in separate processes. See [docs/server-architecture.md](docs/server-architecture.md).
- `npm test` (`npx vitest run` from the repository root) — world generation against a mock model, gameplay simulation, combat balance, the GPU broker, image post-processing
- `npm run broker` — the GPU broker (on the GPU PC, started by hand before building: [docs/gpu-broker.md](docs/gpu-broker.md))
- `npm run typecheck`

Data (accounts, worlds, saves, generated art, AI call logs) lives in `data/` (`GD_DATA_DIR` to move it).

## How it is built

```
packages/shared   Fixed game rules shared by server and client: attributes, damage types, statuses, surfaces,
                  45 pre-balanced skills, item bases and affixes, crafting, monster archetypes, quest objective
                  types, NPC action vocabulary, stats & combat math, protocol, pathfinding.
packages/server   TypeScript (Node) authoritative game server.
  genai/          Provider layer: OpenAI (Responses for text and strict structured output, decisions, transcription)
                  and ComfyUI behind the GPU broker. zod validation, retry-with-feedback, concurrency limits,
                  spending caps, call log. Image pipeline: Luna-written prompts with a chroma-key backdrop per asset,
                  Krea 2 + BiRefNet in one ComfyUI job, cut against the known backdrop (edges un-mixed), the cut
                  scored without a model, content checked by Luna's decision model, repainted until good.
  worldgen/       Generation as a task graph: concept → rules ∥ world plan → creatures → story → every place's
                  people and lore → assembly → balancing → companions; places are painted, read and furnished on
                  the GPU meanwhile (from the world plan on), then characters, objects and icons.
  anim/           Actor animation: a 3D model and rig from each painted standing view, sprite sheets per clip in
                  eight directions (Python steps in packages/server/animator).
packages/gpu-broker  The one door to the GPU for every installation (docs/gpu-broker.md).
  game/           Instances: zones, movement, traps, interactions, loot, trade, crafting, quests, NPC dialogue,
                  gossip/memory, combat (turns, AP, armor, statuses, surfaces), tactical AI, saves.
packages/client   React UI + canvas renderer (each place's top-down map as the ground, figures in depth
                  order, lighting and day/night, fog of war, weather, particles, combat reach rings).
config/           genai.example.json, broker.example.json, ComfyUI workflow templates.
```

### Design principles

- **Fixed mechanics, generated flavor.** Every world's rules are generated as data and priced by one engine: the AI picks which skills and systems fit and writes names, descriptions, characters and story, in plain game words (Health, Gold, Fire) unless the theme truly calls for another recognisable word. It never invents numbers.
- **Closed action sets.** NPCs choose from a fixed list of actions (give item, offer quest, complete/modify/add objective, fail quest, trade, attack, join party, remember, reveal location, teach skill, create a small quest, …). The schema sent to the model uses dynamic enums of the valid quest/item/zone/skill ids for *that* conversation, and the engine validates every action before executing it.
- **The build guarantees playability.** The assembler resolves every story reference (fuzzy matching names), guarantees every quest is completable, every exit is reachable, and every quest item can be obtained. A step that keeps failing stops the build, which resumes from its checkpoints. At play time people answer with simple rule-based replies when the model is out of budget or down.
- **Pre-generate everything that can be.** Worlds are generated once and saved. Any number of save instances can be played from one world.

### Storage

| What | Where | Why |
|---|---|---|
| Accounts, sessions, catalog of worlds and saves | `data/gd.sqlite` (SQLite, WAL) | Relational, shared by the server and CLI tools |
| A world | `data/worlds/<id>/world.json` + `assets/` | Written during generation, then read whole: plain JSON stays inspectable, hand-editable and portable (copy the folder) |
| A save (instance) | `data/instances/<id>.sqlite` | State split into sections (players, zones, NPCs, conversations, journal, explored maps); an autosave writes only what changed, in one transaction; one file per save |

### Gameplay summary

- Towns, wilds and dungeons, each one big top-down painting (see `docs/places.md`): people work outside their painted buildings (no interiors), dungeons and wilds hold monster packs, bosses in their lairs, traps, chests and readable lore. A crafting station stands at each town's workshop when the daydream has crafting. Fast travel between visited towns is a rule the daydream's maker can switch on (off by default).
- Real-time exploration; combat starts when enemies spot you (or you strike first). Turn-based combat: action points, movement cost, surfaces and element interactions. Health and resources come back by themselves out of combat (there is no resting or healing by people).
- Solo (with a "lone wolf" bonus), four heroes you make and control, or your hero with three companions made with the world (played by the AI unless you choose to command them, and someone to talk to on the road).
- Main story in arcs; each arc ends with a revelation. Side quests per town; NPCs can adapt quests in response to what you say and do, and (optionally) create new ones.
- NPC communication level (set per world): tell someone your birthday is tomorrow and they may remember; at "small-town" level, the town can gather for you on the day.
- Saves are continuous; hard saves create a separate copy. Leaving pauses the world unless you enable "keep running", in which case elapsed time is applied when you return.
- Multiplayer is experimental: an instance owner can open it, other users join with their own characters, and combat includes everyone within range, each player controlling their own characters on their turns.

## Configuring AI models

Copy `config/genai.example.json` to `config/genai.json`, put `OPENAI_API_KEY` in `.env` at the repository root, then click **Reload config** on the **AI models** page (top bar, administrators). That page also tests each purpose and shows recent calls with timings and errors.

Each purpose maps to a provider:

| Purpose | Used for | Provider |
|---|---|---|
| `world.design` | Concept, world plan, rules, story, each place's plan; Sol (its `strongModel`) checks paintings | OpenAI (Luna) |
| `world.content` | Towns, residents, side quests, lore, companions | OpenAI (Luna) |
| `image.prompt` | Each asset's Krea prompt, its chroma-key backdrop and (creatures) its view | OpenAI (Luna) |
| `npc.decision` | A person's actions and words in each turn of a conversation | OpenAI (Luna, standard tier for latency) |
| `narration` | Short flavour text, the legends of top-rarity items | OpenAI |
| `image.check` | Checks painted art and places | OpenAI decisions |
| `image.sprite` / `image.icon` | Characters, creatures, objects and item icons | ComfyUI (Krea 2 + BiRefNet) |
| `speech.input` | Talking to people by voice | OpenAI transcription |

Provider types: `openai-responses`, `openai-decision`, `openai-transcribe` and `comfyui`. API keys can be literal, `"env:VAR_NAME"` or `"credential:NAME"` (a systemd credential). Paid calls are charged to the user they are for, within daily budgets (`spending`).

World generation runs text and image work side by side: places are painted as top-down maps as soon as they have a name, while the story is still being written. ComfyUI needs Krea 2 (with its AnyPaint LoRA and nodes), Qwen-Image 2.1 Turbo, SeedVR2 and BiRefNet (`config/comfyui/`, see `docs/places.md` and `docs/world-art.md`). It sits behind the GPU broker, which gives every installation's work its turn on the GPU and unloads one model before the next: copy `config/broker.example.json` to `config/broker.json` on the GPU PC and start it with `npm run broker`; the comfyui provider's `baseUrl` is the broker's address. Animation also needs the `animation` block (local paths to a Python with numpy, scipy and Pillow, the clip library and optionally SkinTokens).

## Known limitations (v1)

- Building a world needs OpenAI and the GPU broker: the build waits while either is away, retries, and can be resumed.
- People walking behind a painted building are drawn over it (no occlusion yet).
- Combat balance was tuned with automated AI-vs-AI simulations (`packages/server/test/balance.test.ts`); it needs human playtesting, especially for higher levels and long campaigns.
- The rule-based stand-in for people (when out of budget, or the model is down) handles common intents (work, trade, news, persuasion, gifts, remembering dates); real conversation needs the model.
- Multiplayer works mechanically but is lightly tested; there is no lobby chat or invite flow beyond "open to others".
- Accounts are local username/password (scrypt) with cookie sessions; there is no password reset or OAuth.
