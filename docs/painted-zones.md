# Painted zones (prototype)

A new way to make a place: no tile grid at all. The whole zone is painted as one large illustration, built up
chunk by chunk with outpainting, and the game reads the painting back to find where people can walk. This
document records what was tried and why the current settings won. The prototype lives in
`packages/server/src/worldgen/outpaint.ts` (painting), `zonepaint.ts` (reading back), `comfy.ts` (ComfyUI calls)
and the lab CLI `packages/server/src/cli/zonelab.ts`.

It replaces the tile-and-atlas backdrop method (`backdrops.ts`), which gets no more work: layouts built on a
grid never looked natural, and painting enough individual props would take too many GPU hours.

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
- Gameplay integration: collision from the walkable mask, exits, entrances and placement.

## Lab commands

```
tsx src/cli/zonelab.ts outpaint <worldId> <zoneId> <outdir> <cols> <rows> <seed> --edges none
tsx src/cli/zonelab.ts sheet <image> <out.jpg> "<label>" "x,y;x,y;x,y" --native
tsx src/cli/zonelab.ts upscale <in> <out> 2
```

The Krea settings above are selected with `ZP_ENGINE=krea ZP_METHOD=anypaint ZP_FILL=1 ZP_W=1728 ZP_H=864
ZP_ORDER=centre ZP_FLAT=0 ZP_MATCH=0 ZP_MARGIN=360 ZP_BAND=32` (reference 768 and the 48 px cut are the
defaults). The many `ZP_*` switches are experiment toggles, to be removed when this becomes a pipeline stage.
