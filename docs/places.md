# Places

How a place is made: every place is one big top-down 2D map, painted by an image model (and, once the new reader
exists, read back to find where people can walk). The painter designs the geometry; the game controls the view, the place's edge and its ways out,
and reads the map closely. This records the pipeline and why each choice won. The code: `worldgen/mapdraw.ts`
(planning and painting), `mapread.ts` (reading), `maprepair.ts` (check and repair), `mapgrid.ts` (the plan's grid),
`placement.ts` (where everything goes), `zones.ts` (a place from design to game data), `comfy.ts` (ComfyUI calls).
How it fits the game is in `world-art.md`.

It replaced painted isometric places (an illustration outpainted chunk by chunk, read back with SAM 3 and MoGe 2),
whose layouts could not be controlled and whose reading of 2.5D paintings was the weak point. Plans written by an
LLM (grid atlases, vectors, command languages, graphs) were tried before that and judged poor: the painter designs
far better levels.

## Pipeline

Studied in two rounds in October 2026 (reports: side-session notes `tile-outpaint/REPORT.md` and
`REPORT_ROUND2.md`). `mapdraw.ts` paints the map; `zones.ts` plans it and turns it into game data.

1. **Plan (Luna, `planMap`).** Luna is told the whole method and the goal (a fun level with distinct areas, a strong
   theme and one connected network). She writes the whole-map layout with one dominant area much larger than the
   rest (for a dungeon, the great chamber), what each tile of the map holds (a distinct area or set piece, with what
   crosses into its neighbours and on which side), the ground, the style, the floor, the barrier (its look, its
   surface material alone, its colour) and what a way out through the barrier looks like. The arrangement suits the
   place (organic for caves and ruins, rows for a barracks), never uniform repetition. The painter takes words
   literally: no heights, facades or views (they tilt the view), and a way out is never a tunnel mouth, gate or dark
   opening (drawn as a black shape that reads as a pit).
2. **Whole-place painting (Krea 2 Turbo, from noise).** The whole place in one picture at Krea's own size (about
   1.5 MP), eight seeds. Luna checks the view on each (decision API) and Sol (the purpose's stronger model) whether
   every area can be reached; the best connected, top-down, on-theme painting is the place's plan. Only 2 of 8 city
   paintings were connected (walled courtyards), 4 of 8 for the town and the wilds, 6 of 8 for the dungeon.
3. **Enlarge and detail.** SeedVR2 enlarges the painting to the map's size (a whole factor, then resampled). Krea
   then repaints it at 0.3 in overlapping 1024 px windows (stride 768, centre outward) with Differential Diffusion:
   strength 0 over pixels already detailed, ramping up across the overlap, so each window continues the finished
   work. Each window is told what its part shows, written by Luna from the painting with a grid on it.
4. **Exits (`placeExits`, `wayOut`).** For each planned side, Sol picks one of seven spots along it (within ±20% of
   the plan) where a street or path already reaches the edge. Krea paints Luna's exit look as a strip, the strip is
   laid at the exit, and it is repainted with a soft edge (48 px) so it blends.
5. **Barrier (`paintBarrier`).** Krea paints the barrier's surface from its flat colour, Luna checks it shows the
   barrier alone, and it is made seamless (`atmosphere.seamless`: it repeats every 1024 px along the band). It is
   laid in a 128 px band round the edge (not at the exits) and repainted at 0.75 in windows round the perimeter;
   the repaint fades out 96 px inside the band (half-cut buildings are finished or removed) and 128 px into the
   barrier already painted (stretches blend without steps).
6. **Check and close (`checkAndClose`).** Sol checks each exit on a crop (a longer way out when blocked, twice at
   most), then reviews the whole map as a level designer and lists unplanned ways off it; each is closed with a
   soft patch 6 m deep where the ground ends before the barrier, up to three rounds.
7. **Where people can walk: a stand-in.** Everywhere except the barrier band, which opens at the exits; each exit is
   a spot just inside its gap. No entrances or landmarks are found yet. The readers below (`readMap`, `repairMap`)
   are kept but not used: they were made for 1.4 MP maps (Qwen's plan of a whole big map runs out of memory) and a
   new reader will replace them.
8. **Settle** (`settlePlace`): Luna places everything on the numbered spots; the map is brought to game scale; the
   navigation grid, people, things, monster packs and traps are laid out (see `world-art.md`).

Every step is saved under `data/worlds/<id>/draft/places/<zone>/` (the plan, each whole-place painting with its
checks, the enlarged and detailed map, the notes, exit spots and textures, the map after its exits, its barrier and
its checks), so a resumed build continues where it stopped. A town takes about 20–25 GPU minutes plus SeedVR2, and
about $0.06–0.11 of OpenAI (almost all Sol).

## Settings and why

| Setting | Value | Why |
| --- | --- | --- |
| Map size | town 3×2 tiles, wilds 4×4, dungeon 4×2 (1024 px each) | Bigger places than one painting allows; the whole-place painting keeps them one design |
| Scale | 40 painted px per metre (`PAINT_PXM`) | Five sizes of a character in the narrowest passages: the size that walks through comfortably was 32 px/m, the one that looks normal 45, on all four test places. 40 leaves characters a little short but never squeezing through (the user's choice); the game draws 46.9, so maps are shown about 1.2× |
| Global plan | one whole-place painting, best of eight | Tiles outpainted one by one have no global layout; AnyPaint and per-tile masked repaints ignore a whole-place guide; cross-faded tiles ghost |
| Detail strength | 0.3 over SeedVR2 | Keeps the plan exactly; 0.5 let rooms drift. SeedVR2 alone is consistent but plainer |
| Exits | Sol's spot, painted look, soft edge | Gaps left to chance were blocked by houses and walls; flat strips looked pasted; Luna's spot picks were close to chance |
| Barrier | seamless surface texture, masked repaint 0.75 with fades | AnyPaint continued the place into the band; a texture of "a river" came out with banks and houses; an unseamed texture showed a line every 1024 px |
| Checks | Sol for connection, exits and the level review; Luna for the view | Luna's "can a person walk out here" contradicted the picture; the view rule needs both "large fronts" and "ground hidden" (either alone misjudged good maps) |

## Reading the map (not in use)

Kept for the reader that will replace the stand-in. `mapread.ts`, two readers that make different mistakes, and Luna where they disagree:

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

## Check and repair (not in use)

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

- **Dense towns leak.** A city's streets reach a thin barrier in many places; Sol's review rounds close some and find
  others. Accepted for now (extra ways out are not ideal but do not break a map). Ideas: a wider barrier, or the
  town's closed edge (a wall, river or cliff) designed into the whole-place painting.
- **Closing patches show** as straight-edged blocks of barrier; an irregular patch shape should hide them.
- **Some ground is hidden** behind large trees and tall roofs (the slight angle is welcome, but not that).
- **Sol varies** between calls (different unplanned openings in each round); acting only on openings found twice would
  make repairs more targeted.
- **Walkability is a stand-in** (everywhere but the barrier): buildings, water and walls are walkable until the new
  reader exists.
- **Rooms.** New worlds have no building interiors; an older world's room is painted as one tile.
