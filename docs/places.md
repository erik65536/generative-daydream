# Places

How a place is made: every place is one big top-down 2D map, painted by an image model and read back to find where people can
walk. The painter designs the geometry; the game controls the view, the place's edge and its ways out,
and reads the map closely. This records the pipeline and why each choice won. The code: `worldgen/mapdraw.ts`
(planning and painting), `mapread.ts` (reading), `mapfix.ts` (making the reading usable), `mapgrid.ts` (the plan's grid),
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
7. **Read** (`readPlace`): where people can walk, made usable without repainting, with building entrances,
   landmarks and a spot just inside each way out's gap (below).
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

## Reading the map

Studied in October 2026 on five maps (the four study places and Brinewake) against 400 hand-labelled points; the
report is in the side-session notes (`walkability/REPORT.md`). `mapread.ts`:

1. **Qwen's plans of the whole map.** Qwen-Image 2.1's edit mode redraws the whole map, resized to about 1.4 or
   2.4 MP, as flat plans: white where a person can walk, black for solid things (filled, not outlined), blue for
   water, pits and the outside. Three prompts (`WALK_READINGS`): the earlier three-colour plan at 2.4 MP, a
   game-mask wording, and the user's "fill objects with black" idea with blue added (as written, two colours, it
   flipped: streets black, houses white). A fourth plan also paints buildings red (`BUILDING_PLAN`). Each is right
   at 85–87% of the points; tile by tile at full size was worse (a tile has no context: rows of roofs read as floor).
2. **Luna where they split.** The readings share their mistakes, so a vote gains little, but where they split is where
   the map is uncertain. Each patch of split cells up to 20 m² gets one look with the patch outlined; a bigger one is
   sampled every 2 m, each sample a 12 m close-up asking what is under a ring at the point (ground, building, wall,
   plant, object, water, void), each cell taking its nearest sample. Patches under 2 m² take the majority. The prompt
   explains the problem (a walk mask for a game, what a wrong answer costs) and gives the place's description. A
   question of what is there was better calibrated than "can a person stand here?" (which leaned to yes).
3. **Water by the place.** Each patch most plans painted blue, inside the place, gets one look: can the character walk
   across it here (a shallow puddle, ice meant for walking) or is it a barrier (a pond, canal, marsh, darkness)?

Buildings are the building plan's red pieces of 6 m² or more (only in places with buildings: a dungeon's dark stone
comes out red); each has an entrance at the walkable ground nearest the middle of its lower side. Landmarks are the
largest solid things standing in walkable ground. Buildings block sight.

At the points: 91–92% right after the fixes below, 88–89% of the truly walkable points reachable, 92–93% of the
reachable ground truly walkable; about 2–3 GPU minutes (four Qwen plans) and a cent or two of Luna per map. SAM 3 with
Luna's names (the earlier reader, 85% on the old small maps) was weak here: names drift ("frozen runnel" took the snow
trails; a dungeon read almost wholly wrong), its masks take minutes to save per map, and arbitrating it with Qwen
helped only on towns. Sol on crops was no better than Luna (87% against 95% on the same points) at forty times the
price.

## Making it usable

`mapfix.ts`, without repainting (the character may clip a little through things that look solid):

- specks cleaned (blocked under 0.5 m² inside open ground opens, open under 1 m² closes);
- the barrier band blocked except the gaps at the ways out;
- every region cut off at two cells' clearance and at least 4 m² is shown to Luna ("ground the player should
  reach?"); a rejected one is blocked with its margin, so the narrower clearance cannot join a roof or a cliff top;
- the character's centre keeps one cell (0.25 m) from blocked ground (`CLEARANCE`): thin walls stay, passages a
  reader drew a little narrow open (0.5 m kept 97% precision but lost reach; none let people onto roof edges);
- every other cut-off region of 4 m² or more joins the main one along the cheapest route, carved 0.45 m either side,
  when that punches through at most 3 m of blocked ground; every way out joins however far.

This lifted reach from about 77% to 89% at a few points of precision.

## Known weaknesses

- **Dense towns leak.** A city's streets reach a thin barrier in many places; Sol's review rounds close some and find
  others. Accepted for now (extra ways out are not ideal but do not break a map). Ideas: a wider barrier, or the
  town's closed edge (a wall, river or cliff) designed into the whole-place painting.
- **Closing patches show** as straight-edged blocks of barrier; an irregular patch shape should hide them.
- **Some ground is hidden** behind large trees and tall roofs (the slight angle is welcome, but not that).
- **Sol varies** between calls (different unplanned openings in each round); acting only on openings found twice would
  make repairs more targeted.
- **Reading edges.** Most remaining reading mistakes are where all of Qwen's plans agree and are wrong: street edges
  lost to buildings drawn a little fat, thin dungeon walls and small props blurred into floor.
- **Rooms.** New worlds have no building interiors; an older world's room is painted as one tile.
