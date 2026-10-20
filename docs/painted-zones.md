# Painted zones

How a place is made: no tile grid at all. The whole zone is painted as one large illustration, built up chunk by
chunk with outpainting, and the game reads the painting back to find where people can walk. This document records
what was tried and why the current settings won. The code: `packages/server/src/worldgen/outpaint.ts` (painting),
`reading.ts` (reading back and placement), `zones.ts` (a place from design to game data), `comfy.ts` (ComfyUI
calls). How it fits the game is in `world-art.md`.

It replaced tiled maps (generated layouts with textures and props), which never looked natural and would have
taken too many GPU hours to paint prop by prop.

## Pipeline

1. **Plan (Luna).** `planChunks` designs the whole place once (`layout`), then cuts it into a grid of parts
   (3×2 so far): a shared `style` line (light, palette, materials) and 2–4 sentences per part describing exactly
   the slice of the layout inside it.
2. **Centre chunk (Krea 2 Turbo, text-to-image).** Painted first, from the camera block, the style line and its
   part. The camera block includes "a close view from inside the level: it fills the whole frame edge to edge
   and continues past every edge"; without it the model paints a model or diorama floating on a background.
3. **Outward chunks (Krea 2 Turbo + AnyPaint).** Centre-out order. Each 1728×864 window holds already painted
   pixels plus the unpainted area; AnyPaint fills the unpainted area.
4. **Upscale (SeedVR2 2×)** to game scale. Looks clean on the tested canvases.
5. **Read back** (next step): Luna names what to look for, SAM 3 and MoGe find the walkable ground, entrances and
   landmarks.

## Settings and why

| Setting | Value | Why |
| --- | --- | --- |
| Engine | Krea 2 Turbo + AnyPaint (community LoRA and nodes) | Seamless, coherent joins and richer detail than every Qwen 2.1 variant in all three test zones |
| Window | 1728×864 | Fits 16 GB VRAM; 2400×1216 edit-mode references crashed ComfyUI |
| Order | Centre-out | Drift spreads both ways instead of piling up in one corner |
| Margin | 360 px (about 20% of the window) | A picture's outer strip is where the model darkens (vignette) and "finishes" the scene; cutting it before the next chunk continues makes one connected place instead of islands. 300 was close; 800 cut more objects and made islands |
| AnyPaint reference | 768 px | At its default 384 the model barely sees fragments at the boundary and orphans or erases them (a roof cut in half); at 512/768 it continues them. Same peak VRAM, ~10% slower |
| Paste-back | Hard cut 48 px into the old paint, no crossfade | AnyPaint redraws a 32 px band and restores the rest of the known area, so just past the band its output matches the old paint; a crossfade there only blurred the seam |
| VRAM | Free before the first chunk and when the workflow switches | Reloading the same model between chunks is wasted time; two differently patched models at once do not fit |

## Prompt rules for Luna

The painter reads every word literally and paints each word's most common picture. The planning prompt now
says so and asks for appearance, not names: "a cart track" painted a railway in 3 of 3 seeds, and even "wheel
ruts" drew rail-like lines, so long parallel marks on the ground are left out. Never mention something to exclude
it. Fixes like this must be general rules for Luna, never patches for one zone. The game draws people,
creatures, chests, loot, shrines and signs itself, so the painting never includes them.

## Reading the painting back

`reading.ts` (run for every place by `zones.ts`; `cli/placepeek.ts` shows a settled place):

1. **Luna reads** the painting and names, as an object detector would: walkable surfaces, connectors (stairs,
   ramps, bridges), blocked surfaces, the enterable structure ("house", "office room"), the entrance, a scale
   object of known height, and landmarks. She can reject a picture that cannot work as this kind of place, but
   never for a detail that differs from the description (that rejected good paintings, at 8 GPU minutes each).
2. **SAM 3 detects** every term. Where detections overlap, the most specific one (the smallest object) decides
   the pixel: a pier mask spanning the water between its arms loses to the water, and a "water" mask spread
   over a wet street loses to the street. Two exceptions. A walkable detection lying mostly inside a blocker
   and clearly above the ground around that blocker is its top: "wooden planks" matched each tabletop of an
   inn as its own small object, which beat the bigger "wooden tables" mask. Height comes from MoGe's depth
   (disparity less a plane fitted over the walkable detections, in screen pixels of the floor's depth
   gradient): tabletops and counters measured 2–3.3 "metres" of that scale above their surroundings, a shop
   floor inside a room-wide "stone walls" mask and shores inside spread "water" masks at most 1.1, so the cut
   is 1.5. Containment alone is not enough: it erased those floors and shores. And a connector detection
   covering a quarter of the picture is ignored: "stone bridge" matched a whole mine, and since connectors win
   over blockers, its dark pools became floor.
3. **MoGe normals** keep only flat, upward-facing ground. Connectors are walkable although they slope, but never
   steeper than 70° (a connector name such as "narrow passage between houses" matched whole houses, and their
   walls became walkable). Inside an enterable structure only flat floor is walkable, so walls stay solid while a
   lane the structure's outline overlaps stays open; but stairs and ramps keep their slope there too, since the
   structure can be the whole place (a mine's stairs lie inside its "mine tunnel" and were cut off). A
   connector detection is a stair or ramp when at least a quarter of it slopes between floor and wall
   (20–70°): stairs measured about 45%, doorways and thresholds (floor plus a vertical frame) 7–15%. The floor's
   facing is fitted starting from the commonest facing on the ground, not the mean: a "ship deck" mask also
   covering the hull's sides pulled the mean so far that the deck read as not flat. Dropping
   the structure rule for place-sized structures instead let a shop's doorway connector turn its walls and
   shelves green.
4. **Clearance** for a character's feet (0.35 m measured on the ground: a ground circle is a 2:1 ellipse in the
   picture, so up and down count double), then the largest connected region. Doorways are **portals**: a door
   joins the floor at its foot to the floor beyond the wall (looked for straight up, within 4 m), as in most
   isometric games. This connects rooms behind full-height walls. In towns, where doors lead into buildings,
   nothing is joined. An interior's front door often stands at the picture's bottom with its threshold running
   off the canvas; then the floor at its foot is looked for inside the doorway's lower half (starting the search
   from the doorway's middle instead lost portals elsewhere: the middle often shows floor through the door). The
   passage is carved as wide as the doorway (at most 2 m), and runs on a metre into the floor at both ends: a
   0.4 m line fell between the navigation grid's cells, and a passage touching the room's floor only at its tip
   joined in the painting but not on the grid (Tamsin's Inn's door could not be reached from most of the room).
5. **Luna checks** the colouring (an overlay without markers) and names causes in detector terms, never terms
   already used: a cut-off area gets the thing that joins it (a doorway, a bridge landing). She can also drop a
   name the detector matched to the wrong thing ("puddles" read as the whole cobbled road). One cached re-read
   applies them.
   **Sol checks once more** when the painting still falls short (walkable area under the kind's minimum, or
   fewer edge exits than the place's ways out): `gpt-6.1-sol` (the purpose's `strongModel`, through a per-call
   `model` on `genai().structured`) gets the same check, told what falls short ("only 41 m² is green walkable
   ground, it needs at least 350"), before the place is repainted. A repaint costs about 8 GPU minutes; the
   check about half a cent (3,300 tokens in and 300 out, at Sol's flex price of $1 / $5 per million; spend is
   charged at Sol's prices, built into `genai/spend.ts`). It runs at most once per painting, only on failure, only when Luna judged the picture
   usable (a check changes detector names, not that verdict), and its read is kept only if it scores higher
   (area and edge exits, as when choosing among paintings). Because the corrected read is saved, a resumed
   build never asks again. `cli/strongcheck.ts <world> <zone>:<seed>` tries it on a saved painting without saving.
   On the ship dungeon (w_livemvg3pu5d z_d1_0:309205, saved read "wooden planks": 41 m²) Sol named "weathered
   grey wooden ship decks" and the read reached 315 m², the same as hand-picked terms, but 0 edge exits instead
   of 1: the ship stands in water and only the cut-off shore touches the edge. The painting has no way out, so
   repainting it is still right, and the earlier read is kept.
6. **Luna places** buildings, exits, people and features at numbered candidate spots: entrances (grouped by the
   structure detection they sit on, with doors closer than a metre merged), edge exits, landmarks, and open
   ground spread evenly (never on stairs). Markers are sized for the downscaled view and never cover each other.
   Ways out and doors are always set on walkable ground (the nearest point, however far), so a weak reading can
   never leave one unreachable. A placement is saved per painting (`placement_<seed>.json`): spots are picture
   positions, and one saved per place was reused when a resumed build settled a different painting, which put
   an inn's way out metres from its door.

### Diagnosing a reading

`cli/readpeek.ts` re-reads saved drafts (`data/worlds/<world>/draft/places/<zone>/canvas_<seed>.png` with its
`read_<seed>.json`) without asking Luna; SAM and MoGe answers are disk-cached, so a re-read takes seconds
(ComfyUI must be running). Output goes to `data/readpeek/`:

- `<zone>_<seed>.jpg`, a contact sheet: candidate spots, the colouring Luna sees, every detection as a numbered
  box (by kind; dashed when ignored as the whole scene, lost as a blocker's top, or winning no pixels), MoGe
  normals, height above the floor from MoGe depth, and structures, stairs/ramps, entrances and portals.
- `<zone>_<seed>.txt`: the read, the scale as measured, each detection's term, size, box and fate (with the
  slope share of connectors), each entrance and the portal it made, and the spots.
- `--edit '{"notWalkable":[...]}'` tries other detector terms on one place; `--save <run>` keeps a run's numbers
  and colourings and `--compare <run>` prints what changed and writes before/after images. Save a run before
  changing a rule, compare after, and look at every place that changed (Saltglass and Lornwick included).

`cli/placepeek.ts` shows a settled place as the game has it (navigation grid, placed features and people;
`--mark x,y` shows a ground position, such as a player's from a reverie).

`cli/resettle.ts <world> [zone ...]` settles a built world's places again with the reader as it is now, from the
saved paintings (nothing is painted or re-read by Luna; Luna places each painting once). Each place keeps the
painting it shows (`--repick` chooses again; `--dry` only shows the choices). The world file and place images are
backed up first. Reveries keep their state; a saved position that is off a place's new ground moves back onto it
(people and monsters to where the place puts them, the party to the way in) when the place next loads.

**Scale.** Krea paints each kind of place at a steady scale, but not the same one: towns and wilds about 41 px per
metre of height, dungeons about 100, single rooms about 120 (doors measured 40–43, 90–120 and 87–135). A measured
scale is trusted within 0.75–1.33× of its kind's typical scale, otherwise the typical scale is used: an anvil's box
(stump included) gave 165, a counter's top 244. With one typical scale for all, every room fell back to 41, and
people were drawn at a third of their size indoors. Rooms therefore shrink to about 0.4× at game scale and hold
14–34 m²; dungeons 46–80 m² (so one painting makes a small dungeon). Minimum areas per kind follow.

**Navigation grid.** The game walks on half-metre cells and never cuts corners. A cell is walkable when any part of
it lies on the walk mask (the centre and eight points 0.2 m out, at most 0.28 m away): the mask already keeps a
character's centre 0.35 m from obstacles, and with centre sampling alone a passage running up the picture (diagonal on the grid)
broke into corner-touching cells, which cut off doors and edges even in Lornwick. `readpeek` reports how much of the
grid is joined to the first door and every door, edge and landmark spot it cannot reach; check it after any change
to the reader (five sample points per cell still left a neck in the inn unjoined).

A painting rule asking for knee-height cutaway walls was tried and dropped: Krea ignored it, and portals made
it unnecessary. Krea's 1728 px windows already paint at about 41 px/m against the game's 47, so the upscale
factor should come from the measured scale, not a fixed 2×.

## Rejected (and why)

- **Plain noise-mask inpainting** (SetLatentNoiseMask), for Qwen and for Krea: the model barely sees the known
  pixels while it decides the layout, giving islands and visible tone steps at the seam.
- **Qwen 2.1 edit-mode outpainting**: seamless with the fill-frame prompt, but sparser and flatter than Krea.
  The ausboss outpaint LoRA came out blurrier, and is non-commercial.
- **Blend bands and crossfades** (16–96 px, two-band blends): ghosting and blur. New and old paint never meet
  in a fade.
- **Post-processing**: vignette flattening, colour matching, colour transfer. The model's raw output is kept.
- **Sketch then redraw** (a turbo sketch repainted whole by the base model): seamless but capped at about 3 MP,
  and it reinterprets the scene. Not needed now that the sketch itself is seamless.
- **img2img with tuned weights**: magic numbers that would be wrong for some zones.
- **Seam-strip repaint** after compositing: misaligned roofs and walls.
- **Cheapest-path margin cut**: works, but fragile and special-case.
- **Disagreement score to reject bad chunks**: did not separate a cut-off roof from plain cobbles; a fixed
  threshold would be unreliable.

## Open questions

- More seeds and zones, larger zones (4×3) and drift at scale.
- A vision check on coherence that rejects a zone and repaints with a new seed. Vision models see a downscaled
  view, so it may miss detail; wait and see whether it is needed.
- Occlusion: people walking behind a painted building are drawn over it (cut-outs of structures drawn at their
  depth would fix it).
