# Levels and art

Every world is imagined from scratch, so nothing here names an environment. The engine knows a small,
neutral vocabulary; the level designer and art director (the LLM) decide what it means in each place.

## Level design: the layout plan

The atlas step gives every zone a `layout` plan (`ZoneLayoutPlan`, stored on the zone):

| field | values | meaning |
| --- | --- | --- |
| structure | open, grid, hub, rooms, caves | free-form ground, blocks between straight lanes, a centre with enterable structures, chambers and corridors, irregular hollows |
| enclosed | true / false | under a roof or ceiling: no sky, day/night, rain or snow |
| blockers | amount (sparse, some, dense) + arrangement (scattered, clusters, rows, edges) | the large impassable element (the "tree" role) |
| hazard | none, pools, river, channels | impassable liquid, chasm or void (the "water" role) |
| structures | roofed, walled | how a town's enterable places look: roofed buildings or walled rooms seen from above |
| clutter | sparse, some, dense | small objects (rock, plant, rubble roles) |

`resolvePlan` fills gaps and clamps the structure to what each zone kind supports (towns: hub or grid;
wildernesses: open or grid; dungeons: rooms or caves). The generators in `worldgen/layout.ts` read only the
plan: plaza or enclosed hub or street-grid towns; natural or gridded travel areas; room or cave dungeons.
A forest, a parking garage and a giant bathroom are all expressible; none is special-cased.

## Art direction

Before painting, each tileset gets an art-direction pass (`directTilesets`): the LLM sees the place, its
level design in words, and decides what every fixed element is there (in an office, the "tree" role might be
a cubicle partition and "shrine" a coffee station). Prompts describe physical things only. Towns with roofed
structures also get a roof surface; every tileset gets a crafting station.

## The image pipeline

1. **Plan** (`planAssets`): surfaces, the props each zone actually places, roofs, heroes in every
   presentation, people, creatures, bosses, item icons. Variants ride along: walk and attack poses for every
   character, an opened chest. Assets are repainted when missing, failed, changed, or made by an older
   pipeline (`ART_VERSION`).
2. **Prompts**: an LLM writes one observer-style paragraph per asset, following the image model's prompt
   profile (`genai/promptprofiles.ts`: qwen-image-2, flux, sdxl; override any field in
   `config/prompt-profiles/<id>.json`). Subjects stand alone: no scenery, fog or glows, studio-lit so they
   read on dark maps.
3. **Generate**: variants are painted from the approved base image as a reference (`editWorkflow`), which
   keeps the same character or object across frames.
4. **Clean** (`genai/matte.ts`): border-colour cutout when the model has no alpha, then matte cleanup (keep
   the opaque subject and a thin soft edge; drop faint haze), opaque-backdrop detection, darkness and fog
   signals (fog: a smooth opaque "skirt" spreading sideways beyond the subject's body near its base,
   measured at a fixed size so smoothly shaded art is not mistaken for it). Surfaces must be one continuous
   material: a framed shape (a pool in a floor, a pit) is rejected, and near-black surfaces are lifted to a
   readable brightness (`liftDark`).
5. **Check**: the checker sees the cutout on magenta beside its alpha mask, so leftovers are visible, and
   answers quality, match, single subject, whole, clean, dark and text questions. Rejects are repainted with
   new seeds; the best attempt is kept.

## World studio

Owners open `#/world/<id>/studio` (the "Open the world studio" button on the world page) to see and change
everything a world is made of (`worldgen/studio.ts`, client `screens/Studio.tsx`):

- **Places**: each zone's map, top-down, as the bare layout (atlas) or with its painted art; its name,
  description and hidden lore; the people and quests there; and its elements (what floor, wall, "tree" and so
  on are in this place) with their art. "Redesign the look" reruns art direction for the place (with the
  owner's direction, if given) and repaints its surfaces and props; "Repaint all its art" re-rolls them.
- **People**, **Quests**: every text field is editable; "Rewrite with AI" revises one person or quest with the
  owner's direction. Renames are carried into every text that mentions the old name. A person whose look
  changes is repainted. Quest objectives keep their game logic; only their wording changes.
- **Creatures** and **Art**: every image with its brief and the image prompt written for the model. The owner
  can replace either (`world.artOverrides`), reset to the world's own, or repaint with new seeds (`roll`).
  Filters find low scores, failures, customised and out-of-date images.

Edits apply at once; regeneration runs as a world job, shown as a checklist. Only changed or re-rolled images
are painted (`planAssets(w, level, only)`).

## Tools

- `src/cli/arttune.ts`: repaint a few assets of a world into a scratch folder with a labelled contact sheet.
- `src/cli/paintworld.ts`: paint a whole world outside the web server.
- `src/cli/layoutpeek.ts`: ASCII view of a layout for a plan.
- `src/cli/sheet.ts`: contact sheet of any folder of PNGs on magenta.
