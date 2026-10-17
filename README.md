# Generative Daydream

A GenAI-driven 2D isometric RPG engine. Describe a world — high fantasy, a derelict space station, a cozy animal village, an office printer apocalypse — and the engine dreams up its places, people, monsters, items, main story and twists, then lets you walk into it and play: real-time exploration, Divinity-style turn-based combat, free-text conversations with NPCs who remember you and can change your quests.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173, create an account (the first account becomes the administrator), and choose **Dream a new world**. With no AI configured, everything uses the built-in procedural generators, so the full game is playable immediately. Add models later (below) and new worlds use them.

- `npm run dev` — game server (port 3000, auto-restart) + Vite client (port 5173)
- `npm run build && npm start` — production: the server also serves the built client on port 3000 (`GD_PORT` to change)
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
                  OpenAI images, Gemini images, procedural. Structured output with zod validation, JSON repair,
                  retry-with-feedback, concurrency limits, call log. Image pipeline: seamless textures,
                  background removal, cut-off detection, vision-model scoring, regenerate until good enough.
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
- **Pre-generate everything that can be.** Worlds are generated once and saved (`data/worlds/<id>/world.json` + `assets/`). Any number of save instances can be played from one world.

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
| `npc.decision` | NPC actions + speech each conversation turn | Latency matters; structured output |
| `npc.dialogue` | Optional separate speech model | Only when `combineNpcDecisionAndDialogue` is false |
| `image.texture` / `image.sprite` / `image.icon` | Art | ComfyUI, OpenAI images, Gemini images |
| `image.check` | Vision model scoring generated images | Optional; heuristics run regardless |

Provider types: `openai-chat` (OpenAI and any OpenAI-compatible server: llama.cpp, LM Studio, vLLM, Ollama, OpenRouter), `openai-responses`, `anthropic` (official SDK, structured outputs, server-side refusal fallbacks enabled — set `"extraBody": {"fallbacks": false}` to disable), `google`, `comfyui`, `openai-image`, `google-image`, `procedural`. API keys can be literal or `"env:VAR_NAME"`. `structured` can be `json_schema` (native constrained decoding), `json_object`, or `prompt` (schema in the prompt only) for servers without schema support.

World generation runs all text steps first and images last, so on a single GPU you can let one model unload before the image model loads (Ollama/LM Studio do this automatically).

## What I need from you for local testing (16 GB VRAM)

1. **A text model behind an OpenAI-compatible endpoint with JSON-schema support.** Recommended: `llama-server` (llama.cpp) or LM Studio with **Qwen3-14B Q4_K_M** (~9 GB) — or Qwen3-8B / Gemma-3-12B if you want more headroom — and a context of at least **16k** tokens (town prompts plus output reach ~10k). Disable "thinking" for speed (the example config passes `enable_thinking: false`). Point `local-llm.baseUrl` at it. This one endpoint can serve `world.design`, `world.content`, `npc.decision` and `narration`.
2. **ComfyUI** on `http://127.0.0.1:8188` with an **SDXL** checkpoint (base or a stylized finetune). Set `comfy.checkpoint` to the file name. The included workflow (`config/comfyui/sdxl_txt2img.json`) is a plain txt2img graph; swap in your own API-format workflow using the `{{prompt}}`, `{{negative}}`, `{{seed}}`, `{{width}}`, `{{height}}`, `{{checkpoint}}`, `{{steps}}`, `{{cfg}}` placeholders.
3. *(Optional)* **A small vision model** for `image.check`, e.g. Qwen2.5-VL-3B/7B via llama.cpp, LM Studio or Ollama. On 16 GB alongside SDXL, prefer the 3B, or leave `image.check` as `procedural` (heuristic checks still catch missing subjects, cut-off figures and failed background removal).

When those are up, tell me the URLs/model names and I'll tune prompts, temperatures and token limits against what your models actually produce.

## Known limitations (v1)

- Without an image model, all art is procedural vector art drawn by the client. It is coherent and readable, but generated sprites/textures are what will make worlds feel unique. Generated character sprites are single-pose images (animated with bob/lean/flip), not frame-animated.
- Combat balance was tuned with automated AI-vs-AI simulations (`packages/server/test/balance.test.ts`); it needs human playtesting, especially for higher levels and long campaigns.
- The rule-based fallback NPC brain handles common intents (work, trade, rest, news, joining, persuasion, gifts, remembering dates) but real conversation quality depends on the decision model.
- Multiplayer works mechanically but is lightly tested; there is no lobby chat or invite flow beyond "open to others".
- Accounts are local username/password (scrypt) with cookie sessions; there is no password reset or OAuth.
