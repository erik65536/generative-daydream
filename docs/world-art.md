# Places and art

Every world is imagined from scratch, so nothing here names an environment. A place is one large painting, and
the game reads it back to learn where people can walk. Characters, creatures, a few objects and item icons are
separate images drawn over the paintings.

## A place, from words to ground

`worldgen/zones.ts` builds each place in two stages, so painting can start before the world is assembled:

1. **Paint and read** (`paintAndRead`, needs only what the place is: name, description, buildings, ways out).
   Luna plans the place as one design cut into parts (`outpaint.ts`); Krea 2 paints it centre-out; Luna names
   what to look for; SAM 3 and MoGe 2 find the walkable floor, entrances and landmarks (`reading.ts`); Luna
   checks the colouring once. A painting that cannot work (too little ground, too few ways out) is painted
   again with a new seed, at most three times. See `painted-zones.md` for the settings and why.
2. **Settle** (`settlePlace`, after assembly). Luna places every building, way out, person and thing on the
   numbered spots of the reading; the painting is brought to game scale (SeedVR2 2× and a Lanczos resize when it
   must grow) and saved as `place_<zoneId>`; the walk and sight masks become the place's navigation grid; and
   monster packs, the boss and traps are spread by walking distance from the way in. A building the painting
   has no entrance for is dropped (its interior goes, its people move outdoors).

Every step is saved under `data/worlds/<id>/draft/places/<zoneId>/`, so a resumed build continues where it
stopped.

## Ground metres

Game positions are metres on the ground. The painting is the 2:1 isometric projection of that ground: a metre
runs 32 picture pixels across and 16 down (`ISO_X`, `ISO_Y`), and a person 1.75 m tall is 82 px. The navigation
grid (`shared/world/nav.ts`) has half-metre cells: walkable (where a person's centre may stand) and see-through.
Fog of war is remembered per square metre.

People are discs of 0.45 m (`shared/world/walking.ts`): two never stand closer than 0.9 m; walks go around
strangers and can squeeze past allies at a cost. Combat movement budgets are metres, and a move stops exactly
where the budget runs out. The client draws the reach as a ring (traced over the reachable cells) with a ring
per action point. Surfaces (fire, ice, oil) lie in square-metre patches.

## The image pipeline (characters, objects, icons)

1. **Plan** (`art.ts`, `planAssets`): heroes in every presentation, people, creatures, bosses, the objects the
   game draws over every painting (`obj_chest` with its open variant, `obj_sign`, `obj_waypoint`), item icons.
   Variants ride along: walk and attack poses. Assets are repainted when missing, failed, changed, or made by an
   older pipeline (`ART_VERSION`).
2. **Prompts**: Luna writes one observer-style paragraph per asset, following the image model's prompt profile
   (`genai/promptprofiles.ts`). Subjects stand alone: no scenery, fog or glows, studio-lit.
3. **Generate**: variants are painted from the approved base image as a reference (`editWorkflow`).
4. **Clean** (`genai/matte.ts`): cutout when the model has no alpha, matte cleanup, backdrop, darkness and fog
   detection.
5. **Check**: the checker sees the cutout on magenta beside its alpha mask. Rejects are repainted with new
   seeds; the best attempt is kept.

In a build, image work runs on the build's GPU queue (`worldgen/gpu.ts`), which keeps using the loaded model
while there is work for it; loading and unloading is the GPU scheduler's job (`genai/gpu.ts`).

## World studio

Owners open `#/world/<id>/studio` to see and change everything a world is made of (`worldgen/studio.ts`, client
`screens/Studio.tsx`):

- **Places**: the painting with its people, creatures and features marked; name, description and hidden lore;
  how it was painted (layout and style); repaint its people.
- **People**, **Quests**: every text field is editable; "Rewrite with AI" revises one with the owner's
  direction. Renames carry into every text that mentions the old name. A person whose look changes is repainted.
- **Creatures** and **Art**: every image with its brief and image prompt; the owner can replace either
  (`world.artOverrides`), reset, or repaint with new seeds.

## Tools

- `src/cli/genlive.ts`: build a world end to end outside the web server.
- `src/cli/paintworld.ts`: paint (or repaint) a world's character and item art.
- `src/cli/placepeek.ts`: a settled place's painting with its walkable ground and everything placed in it marked.
- `src/cli/sheet.ts`: contact sheet of any folder of PNGs on magenta.
