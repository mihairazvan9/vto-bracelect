# Segmentation evaluation

How the arm-segmentation pipeline was chosen, and how to re-check it. Nothing here ships
with the app; it has its own `package.json` so the app's dependencies stay small.

```sh
cd tools/eval && npm install
npm run gt                    # reference masks: Segment Anything on the recorded clips (~6 s/frame, CPU)
node infer.mjs                # run browser strategies in real Chrome (MediaPipe, GPU)
node score.mjs recorded full roi_4.4 app_3
node refine-eval.mjs roi_4.4  # MaskRefiner parameter sweep
node placement.mjs app_3      # where the BRACELET lands vs the reference arm centreline
node live-smoke.mjs rotation  # the REAL app, clip fed as a fake webcam; diagnostics + screenshot
                              # (NO_OCC=1 hides the occluder tint)
node sheet.mjs <clip> gt/<clip> out.png   # eyeball reference masks
node diff.mjs app_3 out.png rotation      # where a method disagrees with the reference
```

**Reference.** SAM (`Xenova/sam-vit-base`), prompted with points on the hand and just up
the forearm (positive) and on the face and nearest clothing (negative). Frames where the
reference leaks sideways off the arm are rejected automatically (`score.mjs` prints
which). The fast-translation clip is mostly motion blur, so its references are unreliable
and it is left out of the headline numbers.

**Scoring** is restricted to the bracelet zone (wrist + ~1 palm length of forearm) and
reports mask IoU, boundary F1 at 2 px, and what the tracker actually consumes: the forearm
axis angle and arm half-widths, both read with the app's own `ArmProfiler`.

**Results** (front + side + rotation, 135 frames):

| pipeline | arm found | axis error | width error |
|---|---|---|---|
| full-frame selfie model (old input) | 82 % | 4.2° | 8.0 % |
| wrist crop 4.4 palms | 100 % | 2.3° | 3.7 % |
| + MaskRefiner (colour + guided filter) | 100 % | 1.9° | 3.1 % |
| app `ArmSegmenter`, network every 3rd frame | 100 % | 2.0° | 3.1 % |

Edge-on (side clip) the full-frame model's width error was 43–62 %; the crop brings it to
~3 %. Crops tighter than ~4 palm lengths fail: the selfie model needs body context.

**Bracelet placement** (`placement.mjs`: sideways distance of the bracelet centre from the
reference arm centreline, in arm half-widths; 1 = on the arm's edge):

| clip | before the centreline fix | after |
|---|---|---|
| side (palm edge-on) | p50 0.83, off the arm in 30 % of frames | p50 0.07, p90 0.17, 0 % |
| rotation | p50 0.25 | p50 0.04 |
| front | p50 0.07 | p50 0.04 |

Cause: the silhouette's centreline correction was applied with its sideways direction
mirrored, which only matters side-on - there MediaPipe's wrist landmark sits on the arm's
edge and the correction is half the arm's width.

**Rendered forearm direction** (`placement.mjs`, the twin's ring centres projected on
screen vs the reference arm direction, p50 / p90):

| clip | before | after the wrist-ring fix |
|---|---|---|
| side | 14.5° / 20.0° | 2.6° / 7.6° |
| rotation (back of hand) | 5.5° / 19.0° | 1.5° / 4.0° |
| front | 1.4° / 2.5° | 0.7° / 1.4° |

Cause: the wrist ring (s = 0) sits on the heel of the palm and is never measured, so its
centreline offset stayed 0 - on the landmark, i.e. the arm's edge side-on - and tilted the
rings between it and the next one. Unmeasured rings now take the nearest measured offset.

Tried and measured, not adopted: a shorter measurement reach (40-70 mm) - direction got
worse (rotation 1.5° -> 2.0-2.9°), because the robust edge fit already ignores the
degraded far rows and a longer stretch is a longer baseline; grey-level closing of the
mask (radius 2-5 px) - neutral, the mask's failure is ending early down a hairy,
shadowed forearm, not small holes. That failure is covered instead by the fitted arm
outline, which the occluder now treats as arm.

**Bracelet size on screen** (`placement.mjs`: the rendered arm's width vs the real arm's,
10th/50th/90th percentile; "pulse" = rendered size change between frames, p90):

| clip | before the arm ruler | after |
|---|---|---|
| front | 1.04 / 1.21 / 1.48, pulse 6.9 % | 0.98 / 1.00 / 1.03, rendered pulse 1.1 % |
| rotation | 0.84 / 0.99 / 1.32, pulse 8.4 % | 0.87 / 1.00 / 1.08, rendered pulse 4.7 % |
| side | 1.06 / 1.16 / 1.37, pulse 3.8 % | 1.02 / 1.05 / 1.07, rendered pulse 3.4 % |

Depth used to come from the palm's size in pixels, re-measured from landmarks every frame,
so landmark wobble made the bracelet breathe. It now comes mainly from the arm's width in
pixels between the two fitted outlines (`WristTracker._armRulerDepth`), with the palm as
fallback; the correction is held on frames without an outline, and the palm-based depth is
1€-filtered.

**Rendered width along the arm** (`widths.mjs`, rendered/real at 9-88 mm below the wrist):
front 0.95-1.02, rotation 0.91-1.04, side 0.84-1.07. Measuring the arm's tilt in depth
from perspective taper evened this out (1.03-1.07, 0.98-1.06, 0.89-1.05) but raised axis
jitter 3-8x (bench: front p50 0.03 -> 0.26 deg), so it is switched off. The measured anatomical taper
(+3 % at 70 mm vs 18 mm) replaced the old +11 % guess.
