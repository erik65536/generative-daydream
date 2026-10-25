# Places and art

Every world is imagined from scratch, so nothing here names an environment. A place is one top-down 2D map, and
the game reads it back to learn where people can walk. Characters, creatures, a few objects and item icons are
separate images drawn over the maps.

## A place, from words to ground

`worldgen/zones.ts` builds each place in two stages, so painting can start before the world is assembled:

1. **Make the map** (`paintAndRead`, needs only what the place is: name, description, buildings, ways out and the
   sides they leave by). Luna plans the map; Krea 2 paints the whole place once (best of eight, Sol checking every
   area can be reached), SeedVR2 enlarges it and Krea adds detail; exits are painted where Sol finds a street
   reaching the edge, then a barrier round the edge; Sol closes unplanned ways out. Where people can walk is read
   back by Qwen (three plans) with Luna where they disagree, then made usable without repainting (narrow passages
   widened, cut-off areas joined). See `places.md` for the pipeline, the settings and why.
2. **Settle** (`settlePlace`, after assembly). Luna places every building, way out, person and thing on the
   numbered spots of the reading; the map is brought to game scale (a Lanczos resize; SeedVR2 2× first when it
   must grow more than 1.5×) and saved as `place_<zoneId>`; the walk and sight plans become the place's navigation grid; and monster
   packs (in open ground), the boss (in the lair placement chose) and traps are spread by walking distance from the
   way in. Town buildings are painted, never
   entered: each is someone's workplace (`zone.buildings`), and they stand outside its entrance; with crafting,
   the crafting station stands at the crafter's workshop, and with fast travel a waypoint stands in the town.
   While Luna places things, the place's air is made (`atmosphere.ts`, below), and the light its map carries is
   measured from its pixels.

Every step is saved under `data/worlds/<id>/draft/places/<zoneId>/`, so a resumed build continues where it
stopped.

## Ground metres

Game positions are metres on the ground, x to the right and y down the map. The map is a top-down view of that
ground at one scale, `PX_PER_METRE` (82/1.75, about 46.9 px): a metre runs that many pixels across and down, and a
person 1.75 m tall is drawn 82 px tall. Figures are drawn from a three-quarter camera over the flat map (below),
so what lies flat around their feet (contact shadows, the rings under them) is drawn flattened to match. The
navigation grid (`shared/world/nav.ts`) has half-metre cells: walkable (where a person's centre may stand) and
see-through. Fog of war is remembered per square metre.

People are discs of 0.45 m (`shared/world/walking.ts`): two never stand closer than 0.9 m; walks go around
strangers and can squeeze past allies at a cost. Combat movement budgets are metres, and a move stops exactly
where the budget runs out. The client draws the reach as a ring (traced over the reachable cells) with a ring
per action point. Surfaces (fire, ice, oil) lie in square-metre patches.

## Air and light

Every place has one mist of its own, used for both fog of war and the painting's edge, and its characters are lit
like the painting they stand in. The game never paints past the walkable ground; mist covers the rest.

- **Mist tile** (`worldgen/atmosphere.ts`, saved as `mist_<zoneId>`, `look.mist`). Luna writes what drifts in the
  place (sea fog, ash haze, cave spores) from its description, art direction and colours; fixed framing asks for
  a top-down texture of wisps over near-black, filling the frame. Krea 2 paints a 1024 px square on the place's
  turn of the build's GPU queue. It is made seamless as texture artists do: rolled by half so its edges meet in a
  cross in the middle, and the cross painted over by AnyPaint (only the band is kept, so the edges still meet
  exactly). Circular padding does not help a transformer like Krea's, and no extra nodes are needed. Then its
  large-scale brightness is divided out (a wrap-around blur) and stretched to the full range, so it repeats
  without a visible pattern and its brightness reads as density. The prompt and the painted tile are draft steps.
- **Light** (`look.painted`): the mean colour of the painting's brightest tenth (its light), of its darkest third
  (its shadows) and its mean brightness.
- **Mist in the game** (client `render/mist.ts`): WebGL at half resolution, drawn onto the view twice a frame,
  both times as two layers of the tile drifting at different speeds (the nearer one moves a little faster with
  the camera, for depth). The *ground pass*, right after the painting, fills everything past its edge, so there
  is never a border, and figures drawn after it stay crisp when they walk out to a way at the edge. The *air
  pass*, over the figures, covers unexplored ground (a dim veil over ground out of sight) and lays a veil inside
  the edge, solid over the last half metre (paintings often darken their outer rows), thinning over about two
  metres, and clear around the party, so the painting sinks softly into the mist. The mist's density erodes the coverage, so it breaks into wisps rather than a blur. Its
  thin parts take the place's fog colour, its wisps the measured light; the view's light (night, gloom, the
  party's light) falls on both passes alike. Places without a tile get generated noise. Without WebGL the fog of
  war is a plain veil. The minimap fades the painting's edge.
- **Figures in the place's light** (client `render/light.ts`). Each figure (people, creatures, the chest, sign
  and waypoint) is drawn once into a scratch canvas, and a copy is multiplied by a top-to-bottom gradient: the
  place's light hue at the head, the painting's own colour around its feet at the feet (a tiny blurred copy of the
  painting, sampled under it), brighter or darker with that ground; then cut back to the figure's shape and washed
  faintly with the light from the upper left. Under it lies a soft contact shadow, flattened as the figures' camera
  sees the ground, sized from the body (0.45 m) in the place's own shadow colour, stronger on brighter ground.
- **Camera clamp** (developer panel, "Clamp camera", remembered per browser, off by default): the view stays
  inside the painting; a place smaller than the screen sits centred with mist around it.

## The image pipeline (characters, objects, icons)

Everything is painted with Krea 2, like the places, so the art is one style. Krea has no transparency: each asset
is painted on a plain chroma-key backdrop and cut out of it.

1. **Plan** (`art.ts`, `planAssets`): a hero for every class and kin (`spr_hero_<class>_<kin>`: the kin's look and
   gender in the class's outfit; each kin is one gender), people (the companions among them), creatures, bosses, the
   objects the game draws over the paintings (`obj_chest`, `obj_sign`, `obj_craft_station`, `obj_waypoint` when the
   world has them), and item icons. Every actor is one
   base image in a neutral standing pose, the view the 3D animation step builds the rigged figure from: **front**
   for people and upright figures, **side** (in profile, facing left) for animals and other body plans. The
   plan records it in `asset.view` (people are planned as front; Luna picks a creature's view). Assets are
   repainted when missing, failed or changed (or re-rolled by the owner).
2. **Prompts** (`genai/images.ts`): Luna writes one observer-style paragraph per asset (subjects stand alone: no
   scenery, fog, glows or cast shadow, studio-lit) and, in the same answer, picks its **backdrop**: green
   (#00b140), blue (#0047bb) or magenta (#ff00ff), whichever hue the subject uses least along its outline,
   highlights and glows. For a mostly see-through subject (glass, crystal, a ghost) the backdrop shows through
   it, so Luna picks the key colour closest to the colour it should look inside. The prompt ends with the
   backdrop sentence, colour and hex included (`genai/cutout.ts`, `backdropSentence`).
3. **Paint and mark** (`config/comfyui/krea2_cutout.json`): one ComfyUI job paints with Krea 2 Turbo (people
   832×1216, side views 1216×832, props and icons 1024×1024) and runs BiRefNet (ComfyUI's built-in Remove
   Background, `background_removal/birefnet.safetensors`) on the result; it returns the untouched painting with
   BiRefNet's mask as alpha.
4. **Cut** (`genai/cutout.ts`): the backdrop's colour field is estimated from the pixels joined to the image
   border. BiRefNet says where the subject is; the key says how opaque each edge pixel is (`alpha =
   (C−B)·(F−B)/|F−B|²` against the nearby subject colour F), with the backdrop's own shadows counted as backdrop.
   Sizeable patches of backdrop inside the subject (the middle of a ring, the gaps in a swarm) are cut out. The
   backdrop is un-mixed from soft edges (`F = (C − (1−a)·B) / a`, kept between the pixel's colour and the
   subject's, and any backdrop hue beyond the subject's own removed), so no coloured fringe is left on hair,
   fur or thin dark edges. Separate pieces (coins in a heap, a swarm, floating stones) are all kept.
5. **Score the cut** (no model): against the key. If the subject is patterned in the key colour, the key cannot
   judge it: the next attempt uses another key colour. Rejected when backdrop is left behind (more than 2.5% of
   the cutout's opacity, or a separate piece that is mostly backdrop) or the subject is cut away (more than 6%).
   Also: cut off by the frame, too small.
6. **Check the content**: the checker (Luna's decision model) sees the painting on its backdrop and judges the
   subject, match to the brief, framing, darkness, text, and the pose (front or side, neutral, whole body); for
   side views it says which way the creature faces, and one facing right is mirrored. It never judges the cut:
   in the bake-off it flagged clean cutouts as often as bad ones.
7. **Keep**: attempts repeat with new seeds up to `maxAttempts`; the best one is trimmed (actors kept up to 768 px
   on their long side, props 512, icons 256) and saved. Weak results are repaired with a rewritten prompt that
   names what went wrong.

The bake-off behind these choices (13 subjects, 4 backdrop strategies, 8 cutters, scored automatically, by Luna
and by eye): the key-based score agreed with the eye on 93% of the cutouts on chroma backdrops (no false alarms),
Luna's cutout check on 59%; Lucida and BiRefNet dynamic-matting made glass see-through, SAM 3 dropped all but one
piece of a swarm. Neutral grey or white backdrops make the score blind (silver, highlights and beards look like
backdrop).

In a build, image work runs on the build's GPU queue (`worldgen/gpu.ts`) with the places, on the same Krea model;
loading and unloading is the GPU broker's job. Animation (walk and attack) is not painted:
it comes from the 3D-rigged sprite sheets built from the base view; until then the game draws the base image.

## Characters in motion

Every character and creature is animated from one painted standing view (front for people, side for animals): a
3D model is made from it, rigged, moved by clips, and rendered at the game's camera into sprite sheets, so every
clip exists in all eight screen directions. The model and rig are kept, so a new clip or a new look is only a
re-render. Server code: `src/anim/` (TypeScript) and `animator/` (Python); client `render/actors.ts`.

1. **Model** (`animator/mesh.py`): Pixal3D, pixel-aligned TRELLIS.2 (native ComfyUI nodes): the view, cut out with
   BiRefNet, becomes a mesh (remeshed, about 60k faces, UV-unwrapped, a 2048 texture baked from its colour voxels).
   One straight-on view meshes best; several generated views at once average their small differences into a muddy
   texture. Small parts are kept (boots under a long coat come out as their own pieces; dropping them leaves a
   figure standing on its hem), and the mesh is checked against the picture: Pixal3D is pixel-aligned, so their
   height-to-width ratios agree (0.93 to 1.01); a mesh under 0.9 lost parts and is made again with another seed.
2. **Rig.** *Humanoids* (`rig_human.py`): SAM 3D Body fits Meta's MHR body (127 joints) to the same view; the
   body is aligned to the mesh (similarity ICP), its bones folded into the game's 20-bone skeleton and its skin
   copied to the mesh (nearest body points, smoothed over the mesh). The figure is stood up along its
   feet-to-neck axis (the image's camera may look down) and turned to face +Z. Then the ankles are checked: each
   should sit in a boot, a few centimetres from the mesh around it. Some seeds make the lower body one mass (a long
   coat down to the ground, no legs), which reads as a figure standing in front of a post; an ankle more than 9 cm
   from the mesh has the model made again with another seed, and the one that covers the ankles better is kept.
   *Other bodies* (`skintokens.py`, `rig_auto.py`): SkinTokens (UniRig's successor) rigs any mesh, and its chains
   are named. Legged walkers (dogs, crabs, spiders): the leaves near the ground are feet, each leg gets its side,
   its place front to back and its gait phase (a lateral-sequence walk for four legs, alternating tripods for more);
   the path to the far, high end is the spine and head, chains behind the hips the tail. Floaters are levelled so
   their chains hang straight down (tentacles). The texture's colours are
   matched to the painting (TRELLIS bakes a flat, muddy albedo) and sharpened a little.
3. **Clips.** *Humanoids* (`retarget.py`): Quaternius' Universal Animation Library (CC0), retargeted by bone
   direction (A-pose and T-pose rigs map onto each other); per clip it measures the stride (from how fast a planted
   foot slides under the hips) and the event frame (the hand's fastest moment). *Quadrupeds and floaters*:
   procedural clips per body plan (`src/anim/page/clips.js`): gaits with IK feet and ground contact, a lunge, a
   howl or a pulse, a flinch, a fall.
4. **Sheets** (`src/anim/render.ts`): three.js in headless Chromium (Playwright): orthographic, looking down the
   screen at the configured pitch (default 35°: a classic three-quarter view of figures standing on a flat map; the
   faces read, since the rigs are made from front views, and heights stretch only 1.22× to the game's 82 px person),
   `PX_PER_METRE` across, three toon bands and an ink outline (inverted hull), rendered at 2× sheet resolution and
   reduced. A first pass finds the smallest cell that holds
   every frame of every clip in every direction; the anchor (the ground under the actor) is the same in every cell.

**Clips**: idle, walk, run (moving faster than `RUN_SPEED`), attack, cast, hit, die. **Format**
(`shared/world/anim.ts`): one WebP sheet per clip saved as asset `<key>@anim-<clip>`, a row per direction in the
order S, SW, W, NW, N, NE, E, SE and a column per frame, at `scale` (2) sheet pixels per picture pixel; the
sprite's own record carries `anim`: cell, anchor, height, body plan, the image it was made from, and per clip its
frames, frame rate, loop, stride and event frame. A repainted actor (a new image file) is animated again.

**Body plans** come from the painted view: people and upright figures are painted from the front (humanoid);
animals and other bodies from the side, and of those, ones that hover or drift are floaters and the rest walk on
legs. Art without a recorded view is read from its brief the same way (`anim/actors.ts`).

**When**: animation follows the art in the background. Whenever a build, an art job or a studio task finishes, the
world's `animate` job is queued if any character or creature lacks current sheets (`anim/job.ts`). It does one
actor per run (the heroes, then the first place's people and creatures, then the rest by place, bosses last) and
queues itself again, at a low priority, so builds and studio work take turns with it; it does not count as the
world's one active job, and it saves only its actor's records onto the world as it is on disk. An actor that fails
keeps its still image until its picture changes or the owner asks again. Steps are kept per actor in
`data/worlds/<id>/anim/<key>/`, so a stopped job resumes.

**In the game** (`render/actors.ts`): the row is the screen direction the actor faces; dead or downed actors fall
and stay down; damage plays the hit, a blow or arrow the attack, any other skill the cast, over whatever else is
going on; moving actors walk or run with their gait's frame rate set by their ground speed over the clip's stride,
so feet keep to the ground. Actors without sheets keep the still image with its procedural bob and lean.

**GPU**: meshing and the body fit run on ComfyUI through the GPU scheduler; SkinTokens needs about 14 GB, so it
takes the GPU as its own "provider" in ComfyUI's group: ComfyUI and the local LLM are unloaded first. Rendering
is light and runs beside anything. Costs on an RTX 4090 Laptop: a humanoid about 4 minutes (model 3.5, body fit
and rig seconds, sheets about 20 s), a creature about 5.

**Configuration** (`config/genai.json`, local paths): `animation: { python, library, skintokens?: { dir, python,
device? }, comfyProvider?, scale?, pitch? }`. Sheets for a changed camera are rendered again from the kept rigs
(`cli/animate.ts --redo=render` does one world at once). `python` needs numpy, scipy and Pillow (ComfyUI's embedded Python has them);
without `skintokens` only humanoids are animated. Chromium comes with Playwright (`npx playwright-core install
chromium`).

**Licences** (the game ships rendered sprites, not the models): Pixal3D is MIT (third-party parts keep their own
terms); TRELLIS.2 is MIT, and ComfyUI's native port leaves out the non-commercial nvdiffrast; DINOv3 (Pixal3D's
image encoder) and SAM 3D Body / MHR are under Meta's licences, which allow commercial use with an acceptable-use
clause (no weapons, military or trade-controlled uses); SkinTokens' code is MIT; Quaternius' clips are CC0. A
lawyer should read the Meta licences and the MHR model's terms before release.

## World studio

Owners open `#/world/<id>/studio` to see and change everything a world is made of (`worldgen/studio.ts`, client
`screens/Studio.tsx`):

- **Places**: the map with its people, creatures and features marked; name, description and hidden lore;
  how it was painted (its plan and style); repaint its people.
- **People**, **Quests**: every text field is editable; "Rewrite with AI" revises one with the owner's
  direction. Renames carry into every text that mentions the old name. A person whose look changes is repainted.
- **Creatures** and **Art**: every image with its brief and image prompt; the owner can replace either
  (`world.artOverrides`), reset, or repaint with new seeds. A character's or creature's card shows its animation:
  its clips playing in turn while it turns through the eight directions (or one clip and direction picked), or that
  it waits its turn or failed and why; "Render the clips again" and "Make a new 3D model" queue it again.

## Tools

- `src/cli/genlive.ts`: build a world end to end outside the web server.
- `src/cli/paintworld.ts`: paint (or repaint) a world's character and item art.
- `src/cli/resettle.ts`: make a world's places again from their saved steps and settle them.
- `src/cli/animate.ts`: animate a built world's characters and creatures (`--body=<key>:<plan>` to set a body
  plan, `--redo=render|clips|rig|mesh` to redo from a step).
- `src/cli/placepeek.ts`: a settled place's map with its walkable ground and everything placed in it marked.
- `src/cli/npctalk.ts`: talk to a world's people with the configured model, without saving (for tuning prompts).
- `src/cli/strictcheck.ts`: send every model-facing schema to OpenAI in strict mode, so a schema it refuses fails at once.
- `src/cli/users.ts`: accounts from the console (invite, reset, list).
- `src/cli/paintpeek.ts`: paint a few of a world's assets into a scratch folder (the world is not changed) and draw a contact sheet: each painting, its cutout on dark and on a loud colour, and its scores.
