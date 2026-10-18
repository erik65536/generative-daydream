# Generative Daydream

A GenAI-driven 2D isometric RPG engine. Describe a world — high fantasy, a derelict space station, a cozy animal village, an office printer apocalypse — and the engine dreams up its places, people, monsters, items, main story and twists, then lets you walk into it and play: real-time exploration, Divinity-style turn-based combat, free-text conversations with NPCs who remember you and can change your quests.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 and sign in as `admin` with the one-time password the server prints on its first start (you choose your own password next). Accounts are invite only: administrators create them on the **Users** page, and `npm run users -w @gd/server -- reset <user id>` resets a password from the console. Then choose **Dream a new world**. With no AI configured, everything uses the built-in procedural generators, so the full game is playable immediately. Add models later (below) and new worlds use them.

- `npm run dev` — game server (port 3000, restarts on every change), job worker (pauses its jobs at a safe point and restarts with new code; they resume from checkpoints) + Vite client (port 5173)
- `npm run build && npm start` — production: the server also serves the built client on port 3000 (`GD_PORT` to change) and runs jobs itself; set `GD_WORKER=external` and run `npm run worker -w @gd/server` (one or more) to run them in separate processes. See [docs/server-architecture.md](docs/server-architecture.md).
- `npm test` — world generation validation, gameplay simulation, combat balance, mock-LLM pipeline, image post-processing
- `npm run typecheck`

Data (accounts, worlds, saves, generated art, AI call logs) lives in `data/` (`GD_DATA_DIR` to move it).

## How it is built

```
packages/shared   Fixed game rules shared by server and client: attributes, damage types, statuses, surfaces,
                  45 pre-balanced skills, item bases and affixes, crafting, monster archetypes, quest objective
                  types, NPC action vocabulary, stats & combat math, protocol, pathfinding.
packages/server   TypeScript (Node) authoritative game server.
  genai/          Provider layer: OpenAI-compatible chat, OpenAI Responses, Anthropic, Google Gemini, ComfyUI,
                  OpenAI images, Gemini images, llama.cpp decision models, procedural. Structured output with zod
                  validation, JSON repair, retry-with-feedback, concurrency limits, call log, and a GPU scheduler
                  that keeps one local model resident at a time. Image pipeline: LLM-written descriptive prompts,
                  native alpha or background removal, seamless textures, cut-off detection, scoring by a decision
                  model or vision LLM, regenerate until good enough.
  worldgen/       Generation pipeline: concept → atlas → monsters/skills/items/affixes → main story →
                  per-town and per-area content → procedural layouts → assembly & validation → art.
  game/           Instances: zones, movement, traps, interactions, loot, trade, crafting, quests, NPC dialogue,
                  gossip/memory, combat (turns, AP, armor, statuses, surfaces), tactical AI, saves.
packages/client   React UI + canvas isometric renderer (chunk-cached ground with soft blending, pitched-roof
                  buildings, lighting and day/night, fog of war, weather, particles, combat overlays).
config/           genai.example.json, ComfyUI workflow template.
```

### Design principles

- **Fixed mechanics, generated flavor.** Every world shares one balanced rule set. The AI renames mechanics ("Health" may be "Hull Integrity", gold may be "Acorns"), picks which skills/systems fit, and writes names, descriptions, characters and story. It never invents numbers.
- **Closed action sets.** NPCs choose from a fixed list of actions (give item, offer quest, complete/modify/add objective, fail quest, trade, attack, join party, remember, reveal location, teach skill, create a small quest, …). The schema sent to the model uses dynamic enums of the valid quest/item/zone/skill ids for *that* conversation, and the engine validates every action before executing it.
- **Every generation step has a procedural fallback**, field by field. A weak or misbehaving local model degrades content quality, never playability. The assembler resolves every story reference (fuzzy matching names), guarantees every quest is completable, every exit is reachable, and every quest item can be obtained.
- **Pre-generate everything that can be.** Worlds are generated once and saved. Any number of save instances can be played from one world.

### Storage

| What | Where | Why |
|---|---|---|
| Accounts, sessions, catalog of worlds and saves | `data/gd.sqlite` (SQLite, WAL) | Relational, shared by the server and CLI tools |
| A world | `data/worlds/<id>/world.json` + `assets/` | Written during generation, then read whole: plain JSON stays inspectable, hand-editable and portable (copy the folder) |
| A save (instance) | `data/instances/<id>.sqlite` | State split into sections (players, zones, NPCs, conversations, journal, explored maps); an autosave writes only what changed, in one transaction; one file per save |

Older layouts are migrated automatically on start (originals of JSON files go to `data/legacy-json/`).

### Gameplay summary

- Towns with enterable buildings (shops, inns, homes), wilderness, and dungeons with bosses, gates and levers, traps, chests, shrines, readable lore, waypoints for fast travel.
- Real-time exploration; combat starts when enemies spot you (or you strike first). Turn-based combat: action points, movement cost, physical/magic armor that must be broken before control effects land, surfaces (fire, water, ice, poison, blessed) and element interactions (wet + shock may stun).
- Solo (with a "lone wolf" bonus), a party of up to four you control, or recruit NPC companions (AI-controlled unless you choose to command them).
- Main story in arcs; each arc ends with a revelation. Side quests per town; NPCs can adapt quests in response to what you say and do, and (optionally) create new ones.
- NPC communication level (set per world): tell someone your birthday is tomorrow and they may remember; at "small-town" level, the town can gather for you on the day.
- Saves are continuous; hard saves create a separate copy. Leaving pauses the world unless you enable "keep running", in which case elapsed time is applied when you return.
- Multiplayer is experimental: an instance owner can open it, other users join with their own characters, and combat includes everyone within range, each player controlling their own characters on their turns.

## Configuring AI models

Copy `config/genai.example.json` to `config/genai.json`, edit it, then click **Reload config** on the **AI models** page (top bar). That page also lets the admin test each purpose and shows recent calls with timings and errors.

Each purpose maps to a provider:

| Purpose | Used for | Notes |
|---|---|---|
| `world.design` | Concept, map, monsters, main story | Smartest model you have |
| `world.content` | Towns, residents, side quests, tilesets, item/skill names | Many calls; can run in parallel |
| `npc.decision` | NPC actions + speech each conversation turn | Latency matters; structured output, or a decision model (actions) with the LLM for speech |
| `npc.dialogue` | Optional separate speech model | Only when `combineNpcDecisionAndDialogue` is false |
| `image.texture` / `image.sprite` / `image.icon` | Art | ComfyUI, OpenAI images, Gemini images |
| `image.check` | Scoring generated images | Decision model or vision LLM; heuristics run regardless |
| `image.prompt` | Writing long descriptive prompts for the image model | Used when the image provider has `"promptStyle": "descriptive"` |

Provider types: `openai-chat` (OpenAI and any OpenAI-compatible server: llama.cpp, LM Studio, vLLM, Ollama, OpenRouter), `llamacpp-decision` (llama.cpp `/v1/systemone` decision models), `openai-responses`, `anthropic` (official SDK, structured outputs, server-side refusal fallbacks enabled — set `"extraBody": {"fallbacks": false}` to disable), `google`, `comfyui`, `openai-image`, `google-image`, `procedural`. API keys can be literal or `"env:VAR_NAME"`. `structured` can be `json_schema` (native constrained decoding), `json_object`, or `prompt` (schema in the prompt only) for servers without schema support.

World generation runs all text steps first (including writing image prompts) and images last. Providers that share a `"gpu"` group never run at the same time: before switching models the engine unloads the resident one (llama.cpp router `/models/unload`, ComfyUI `/free`), and when it takes the GPU it also evicts anything another process left loaded. Image providers can set `"promptStyle": "descriptive"` (long observer-style paragraphs, for Qwen Image / Flux / Krea) or `"tags"` (SDXL), and `"alpha": "native"` (the model outputs transparency) or `"cutout"` (background removed in code).

## Local setup (16 GB VRAM)

`config/genai.example.json` matches the tested local setup:

1. **llama.cpp in router mode** (`llama-server --models-dir .\models --port 9931 --parallel 1 --ctx-size 16384 --cache-type-k q8_0 --cache-type-v q8_0`) serving a text/vision LLM (tested: Qwen3.8-27B IQ3_S) and a decision model (tested: vllm-d3-flash). `--parallel 1` matters: the default splits the context into 4 slots of 4k, too small for town generation.
2. **ComfyUI** on `http://127.0.0.1:8188` with Qwen Image 2.1 Turbo (int8, native transparency, `config/comfyui/qwen_image_2_1_turbo_t2i.json`). Krea 2 Turbo and SDXL workflows are included as alternatives. Workflows are API-format JSON with `{{prompt}}`, `{{negative}}`, `{{seed}}`, `{{width}}`, `{{height}}`, `{{checkpoint}}`, `{{steps}}`, `{{cfg}}` placeholders.

All three share the GPU group `local`, so only one is loaded at a time.

## Known limitations (v1)

- Without an image model, all art is procedural vector art drawn by the client. It is coherent and readable, but generated sprites/textures are what will make worlds feel unique. Generated character sprites are single-pose images (animated with bob/lean/flip), not frame-animated.
- Combat balance was tuned with automated AI-vs-AI simulations (`packages/server/test/balance.test.ts`); it needs human playtesting, especially for higher levels and long campaigns.
- The rule-based fallback NPC brain handles common intents (work, trade, rest, news, joining, persuasion, gifts, remembering dates) but real conversation quality depends on the decision model.
- Multiplayer works mechanically but is lightly tested; there is no lobby chat or invite flow beyond "open to others".
- Accounts are local username/password (scrypt) with cookie sessions; there is no password reset or OAuth.
