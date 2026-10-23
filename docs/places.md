# Places

How a place is made: every place is one top-down 2D map, painted by an image model and read back to find where
people can walk. The painter designs the geometry; the game controls the view, the place's edge and its ways out,
and reads the map closely. This records the pipeline and why each choice won. The code: `worldgen/mapdraw.ts`
(planning and painting), `mapread.ts` (reading), `maprepair.ts` (check and repair), `mapgrid.ts` (the plan's grid),
`placement.ts` (where everything goes), `zones.ts` (a place from design to game data), `comfy.ts` (ComfyUI calls).
How it fits the game is in `world-art.md`.

It replaced painted isometric places (an illustration outpainted chunk by chunk, read back with SAM 3 and MoGe 2),
whose layouts could not be controlled and whose reading of 2.5D paintings was the weak point. Plans written by an
LLM (grid atlases, vectors, command languages, graphs) were tried before that and judged poor: the painter designs
far better levels.

## Pipeline

1. **Plan (Luna, `planMap`).** The place described as only a map seen straight from above shows it: its ground
   plan, roofs, paths, open spaces and where things are, with counts ("four cottages around a square"). Words about
   height, slopes, views, facades or balconies pull every painter into a three-quarter view (a hillside city came
   out in perspective on every model until they were gone). Also the style, the main floor and the barrier that
   closes the place's edges (dense forest, black rock, outer walls), each with a colour, and the place's light.
2. **Frame guide (`frameGuide`).** A crude picture of the place's frame: a 2.5 m band of the barrier's colour round
   the edge, floor-coloured gaps 4 m wide where the ways out leave (running 6 m in), flat floor colour inside.
   Ways out across the edge face where they lead on the world map (a room's door out is at the bottom); two on one
   side sit at a third and two thirds of it.
3. **Paint (Krea 2 Turbo, image to image at denoise 0.6).** The prompt opens with a lead that names the picture as
   a flat 2D top-down map ("every building drawn only as the shape of its roof"; for rooms, "the inside of one
   building with the roof taken away"), then the plan, the edge and its ways out. The frame's composition survives
   the denoise (a true top-down view, an edge closed all round, gaps where asked) while everything drawn is new.
4. **View check (Luna, decision API).** One call: is it seen straight down (the main question asks her to look for
   building fronts), and is it a finished, detailed painting (a bare guide answers "straight down" too). A map
   that fails is painted again with a new seed.
5. **Read** (below): where people can stand, what blocks sight, buildings and their entrances, landmarks.
6. **Check and repair** (below): the ways out, closed edges, and the walkable ground joined into one place.
7. A map without enough walkable ground (towns 350 m², wilds 600, dungeons 120, rooms 25) is made again with a new
   seed, at most three tries; the best try is kept. Imperfect ways out are accepted: where the map has no opening
   on a side that needs one, the main ground nearest the planned gap stands in.
8. **Settle** (`settlePlace`): Luna places everything on the numbered spots; the map is brought to game scale; the
   navigation grid, people, things, monster packs and traps are laid out (see `world-art.md`).

Every step is saved under `data/worlds/<id>/draft/places/<zone>/` (the plan, the guide, each map with its view
check, the detector names, SAM's colouring, Qwen's walk plan, the arbitrated plan, each repair round, the reading's
numbers and the placement), so a resumed build continues where it stopped. `cli/readpeek.ts` shows a world's maps
step by step from these files, without asking any model.

## Settings and why

| Setting | Value | Why |
| --- | --- | --- |
| Painter | Krea 2 Turbo | The only one of three that takes the guide (Qwen 2.1 Turbo's 8-step schedule returns the guide unchanged). With prompts alone, Krea was top-down on 13 of 18 maps, Qwen Turbo 12, full Qwen 11: Qwen draws town houses as icons with their fronts showing and floats the place as an island in fog |
| Guide denoise | 0.6 | 0.6 got the asked ways out exactly in 7 of 12 maps, 0.75 in 5, prompts alone in 2. It also fixed the angle where new seeds and rewritten prompts could not: the hillside city 3 of 3, the gingerbread village 2 of 3 (0 of 12 otherwise). At 0.92 Krea ignores the guide |
| Map size | towns 44×36 m, wilds 52×40, dungeons 28×22, rooms 14×11; about 1.4 MP | The size Krea paints best at; smaller places are painted closer |
| Plan grid | 0.25 m cells, 0.35 m clearance | A character's centre keeps 0.35 m from anything not open |
| View check | Luna, decision API, one call | No false accepts on 54 maps (about 1 s, $0.0003). Zoomed quadrants lose context (all said "top"); Sol was too strict (fronts everywhere) at ten times the cost; MoGe's normals caught only strong three-quarter views |

## Reading the map

`mapread.ts`, two readers that make different mistakes, and Luna where they disagree:

1. **SAM.** Luna names what the map shows as an object detector would (floors, stairs, walls, buildings, water,
   props, trees, doors). SAM 3 finds each name in overlapping 1024 px tiles (it sees about 1000 px, so a whole map at
   once misses small objects). The most specific (smallest) detection wins each pixel. A wall mask whose inside is
   mostly floor keeps only its rim (the detector filled in a walled yard); a detection covering over a third of the
   map is ignored (a "hedge" mask over a whole garden). Cells take their majority class. Luna then checks the
   colouring once, the map beside it and the legend in a strip of its own (a legend over the colouring hid a third
   of it), dropping names that grabbed the wrong thing and adding better ones; SAM reads again with them.
   SAM is strong on clutter (desks, cars) but weak where names drift (a dark flooded temple read almost no floor).
2. **Qwen.** Qwen-Image 2.1's edit mode redraws the map as a flat three-colour plan: white where a person can walk,
   blue for water and the outside, black for solid things. Strong on structure and the outside, weak on clutter.
   With two colours it sometimes flipped the sea to walkable; giving the outside its own colour fixed that.
3. **Arbitration.** Where the two agree (about 70% of a map, right 94% of the time) the cell is settled. Every joined
   patch where they disagree is settled by Luna on the decision API: a zoomed crop with a crosshair, beside the
   whole map, every metre over the patch ("can a person stand here?"), each cell taking its nearest sample's answer;
   patches under 1 m² take Qwen's answer. One sample per patch was not enough (a big patch is not all one thing).

At 255 hand-labelled points on six maps: SAM 85%, Qwen 80%, Luna alone on crops 87%, arbitrated 91%; arbitrated
also had the best reach (76% of the truly walkable points in the main joined ground, 87% of that ground truly
walkable). It costs one to three cents of Luna per map. Luna judging two whole colourings could not pick the better
one (she always preferred the cleaner-looking one). Sight is blocked by SAM's walls, buildings and trees.

**Spots.** Entrances: SAM's building pieces of 6 m² or more, each at a detected door on or by it, else the open
ground nearest the middle of its lower side. Landmarks: the largest props, trees and pools with walkable ground
within 1.5 m. Ways out: from the repair (below). Open ground: spread evenly over the walkable cells.

## Check and repair

`maprepair.ts`:

- **Openings** are runs of open floor along the map's edge (the floor itself, not the clearance-trimmed walk: that
  hid painted paths running off the edge). On each side that wants a way out, the opening of the main region nearest
  where the guide put the gap is kept (keeping the widest opening of any region kept rock specks and corners). A
  missing one gets a route from the main region to that spot, painted as a way out. Other openings are blocked in
  the plan only (painting them shut by the place's barrier works, but a wild place's edge can have twenty openings
  at about a minute each, so it is off: `PAINT_CLOSURES`).
- **Cut-off regions** of 4 m² or more (or 1% of the walkable ground) are joined to the main region along the
  cheapest route, painted as a passage.
- Each repair is painted by Krea 2 AnyPaint in a window around it (at least 512 px, the repair plus about 160 px:
  the window is the reference, so the patch matches) and checked there alone by Qwen's walk plan, with one retry
  on another seed. Only the masked area is pasted back (blurred 2 px).
- **The plan follows each repair by construction** (a passage is open, a closure blocked). Reading the whole map
  again after a repair brings back the readers' noise, and the loop never settles.
- Up to four rounds; a round that makes the check worse is undone. The final plan blocks the edge except at the
  ways out, so nobody walks off the map elsewhere.

Lessons from AnyPaint: paint in a window, never the whole map; never cross-fade two paintings (ghosting); to make it
follow a shape, paste a crude version of the shape into the masked area first. An outpainted barrier ring round a
finished map failed: AnyPaint ignored the crude barrier and continued the floor outwards.

## Known weaknesses

- **Mirrored exits.** Krea mirrors ways out (wanting top and left, it often paints a bottom one too). Extra
  openings are blocked in the plan only, so a painted path can seem to lead out where nobody can walk. Opposite
  sides are the easy case.
- **Subjects that invite a three-quarter view** (candy cottages) can still come out with fronts showing; the view
  check rejects them and the place is painted again.
- **Rooms.** New worlds have no building interiors (town buildings are only painted; their people stand outside),
  so rooms are painted only for older worlds. The frame can turn a room into an outdoor compound; the lead for
  rooms asks for the inside of one building with the roof removed.
- **Dense quarters** with streets leaving every side (a city quarter) have no natural closed edge.
- **Narrow paths** (hedge mazes, about 1 m) are lost to the 0.35 m clearance.
- Verified in a validation run on nine briefs before these fixes: 4 of 22 runs gave a fully usable map, and the
  causes were the exits after clearance, the opening choice and no area test, all addressed here. The place
  pipeline still needs a new validation run.
