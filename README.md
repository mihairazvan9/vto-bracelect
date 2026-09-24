# MakeMeTryOn — Bracelet Fitting Engine

Real-time bracelet virtual try-on built as a **wrist digital twin + fit engine + jewellery
renderer**, not as "attach a GLB to a wrist landmark".

Vue 3 + three.js r186, JavaScript (no TypeScript). Everything runs locally in the browser;
no video leaves the device.

```sh
npm install
npm run dev      # open the URL, allow camera
npm run verify   # headless checks of the geometry, fit and physics maths
npm run bench    # replay REAL recorded clips (fixtures/) through the wrist pipeline
npm run bench:jewelry  # the same clips through tracker + physics: what the USER sees
npm run scorecard      # every quality goal on every clip; --save / --compare runs
npm run build
```

### Recording test clips (dev only)

`npm run dev`, start the camera, then **Record test clips** in the header. A guided script
(hold still, slow turn, wrist bend, forearm swing, closer/further, shake-then-hold, side-on,
sleeve, free try-on) coaches the framing with arrows, counts down, and keeps a take only once
it contains the movement asked for; a take that loses the hand or the framing is retried.
Each take is written by the dev server to `fixtures/<scenario>-<MMDD-HHMMSS>/`:

| file | |
|---|---|
| `recording.v1.bin` | the usual VTO1 clip: raw frame (JPEG), image + world landmarks, handedness |
| `armmask.bin` | the live pipeline's own soft arm mask per frame; the bench replays it exactly |
| `capture.json` | scenario, lens, capture timestamps, per-frame framing flags, camera fps and timings |

`npm run bench -- <clip>` / `npm run bench:jewelry -- <clip>` pick them up like any other clip.
A **fps** chip flags takes the machine or the camera could not deliver at full rate (webcams
drop to 15 fps in dim light). Clips are video of a real person: they stay out of git.

## Premium pass: measured, then changed

`npm run scorecard` replays every clip in `fixtures/` through the live pipeline (observer,
tracker, fit, physics) on a steady render clock and reports each quality goal in one table;
`--save` / `--compare` keep and diff runs, `--hz` changes the render rate. Numbers below are
all clips pooled, old code vs. this pass, p95 unless noted.

| goal | before | after | what did it |
|---|---|---|---|
| roll twitch (bracelet turning round the arm), deg/frame | 7.5 | **4.9** | roll filtered on its own (below) |
| forearm-direction shake, deg/frame | 2.5 | 2.2 | the axis filter no longer sees roll noise as motion |
| tennis / charm rim shake on screen, px | 40 / 41 | **20 / 20** | physics rewrite |
| tennis / charm jumps along the arm, per min | 53 / 83 | **10 / 8** | sleeve filter, physics rewrite |
| chains, 30 vs 60 vs 120 Hz display, mm apart | 16 | 7-8 | fixed-step physics |
| hand detections per second, live, 30 fps camera | 18 | **~30** | hand first in the frame budget |
| one hand's wrist over 9 sessions, mm | 119-180 | **138-162** | palm-size prior (below) |
| screen shake, size pumping, lag | 17 px, 3.9 %, 11 px | 17 px, **3.6 %**, 11 px | arm ruler spike gate (below) |

**Roll is the noisiest thing we track, and is now filtered as such.** The orientation is
split into the forearm's direction and its roll about it (`wrist/OrientationFilter.js`): the
direction keeps its 1€ filter; the roll gets a constant-velocity Kalman filter
(`core/KalmanCV.js`) tuned on the recordings against a roll-lag measure. Roll lag p90 went
3.5° → 5.2°: the price of the calmer roll, and roll is the least visible degree of freedom of
a round piece.

**Physics is real now** (`physics/`). Both solvers step at a fixed rate (480 / 600 Hz) and
interpolate for display, in a `JewelleryFrame`: the arm's frame with its twist followed
through a soft spring, so a real pronation reaches the piece and a tracker twitch does not.

- *Bangle / cuff* (`RigidSolver`): an XPBD rigid body (Müller et al. 2020) - mass, contact
  of 24 points round its inner edge with the tapered arm tube, positional static and kinetic
  skin friction, a soft bounce, the wall planes, a tasteful tilt limit, sleep when it and the
  arm are at rest. A loose bangle really rests on the top of the wrist, slides when the arm
  tilts past what friction holds, cocks on a slope and jams on the widening arm. A cuff
  springs onto the wrist.
- *Chains* (`XPBDChainSolver`): small steps, one constraint pass each; inextensible links;
  bending about the loop's own rest curve (a tennis band stays flat along the arm, a rope
  drapes); charms are two-way pendulums that pull on their link.
- *Skin gives*: where a piece is smaller than the arm there (a wrist over-measured, or a
  piece genuinely too tight) the arm is squeezed to fit rather than fought - fighting it once
  launched a bangle off the arm at 178 rad/s.
- One **liveliness** knob (Engine panel, calm ↔ lively, `physics/tuning.js`) replaces the
  stable/realistic switch: how much of the arm's motion reaches the piece and how fast it
  dies away. Calm (0.4) is the default; charms still swing ~0.8 s after the arm stops.

**Things that jumped, and why they no longer do.** The arm profiler's sleeve flickered frame
to frame on a still arm (none, 41, 32, none, 25 mm), and the fit moved the bracelet's resting
station with it - a chain was yanked 45 mm in one frame. A sleeve is now believed only once
it persists (`SleeveFilter`), the station glides, and the wrist shape the tube and physics
see glides too while it is still being measured (at most 10 mm/s).

**Segment once, then only track? Measured.** Replayed on the in-app recordings, against
where the per-frame segmentation says the arm is (arm direction error, how far the model sits
off the arm's centre in % of its width, width error; p50 / p90):

| after the wrist is measured | direction | off centre | width |
|---|---|---|---|
| network as recorded (~every frame, refined per frame) | 0.5° / 3.2° | 1 / 6 % | 2 / 6 % |
| network every ~150 ms, refinement tracking in between | 0.7° / 3.4° | 1 / 6 % | 3 / 7 % |
| network every ~300 ms | 0.8° / 4.5° | 2 / 7 % | 3 / 9 % |
| network every ~1 s | 1.2° / 9.4° | 2 / 11 % | 4 / 15 % |
| network once, then colour-and-edge tracking only | 2.1° / 22° | 4 / 47 % | 6 / 23 % |
| network once, then hand landmarks only | 8° / 26° | 9 / 64 % | 8 / 19 % |

The network is the anchor: tracked by colour alone the arm drifts (a slightly wrong prediction
teaches the colour model wrong labels), and from landmarks alone a bent wrist cannot be told
from a moving forearm. But it need not run every frame, so it now runs at 12 Hz while the
wrist is being measured and 6 Hz while a measured wrist is tracked, back to 12 Hz while the
arm moves fast or its silhouette is weak. The cheap per-frame refinement (~3 ms) always runs.

**A shake reaches the bracelet.** During the most vigorous second of each recording the
physics used to feel 0-13 % of the tracked arm's acceleration (p90), and nothing at all half
the time: the filter, dead zones and gain that keep tracking noise off a still piece kept a
real shake off it too. `ArmInertia` is now motion-adaptive - while the arm clearly moves
(> 150-500 mm/s, where noise never goes) it opens up (6-9 Hz, a sixth of the dead zones, full
gain) - and felt 30-40 % on the same seconds; charms travel 4x further in a shake, a loose
bangle rattles and slides. On a still arm nothing changed (rest speeds identical). What it
cannot fix: in dim light the camera runs at 12-15 fps and MediaPipe loses the hand on about
a third of the frames of a fast shake - no tracking reproduces a shake it cannot see.

**Tried and dropped, because the recordings said no:**

- *Narrowing the per-frame arm search once the shape locks* (expecting the locked width,
  skipping its fan of alternative directions): on the still clip the arm's size pumped
  1.4 % → 8.8 %. The locked width can be off, and the fan is what rescues weak frames.
- *A Kalman filter fusing palm and arm distance*: less lag, but twice the size pumping of the
  1€ filter at rest. Pumping is what shows.

**The bracelet is its real size on the arm.** The arm tube always matches the arm on screen
(the arm ruler sees to that), but its millimetres - and so how big a real 180 mm bangle looks
on it - come from MediaPipe's palm scale. That scale is a learned guess: one hand, one camera,
one day read a wrist-to-knuckle span of 68-104 mm over nine recorded sessions, the wrist came
out 119-180 mm, and in the 119 mm session the bangle was drawn 1.6x as wide as the arm. The
wrist's shape *relative to the palm* was steady (width ~0.62 palm); only the scale wandered.

- The palm is now MediaPipe's reading combined with what adult palms are (`palmFromScale`:
  82 mm; one session's reading varies twice as much as adult palms do, so it carries ~18 % of
  the weight). Same hand, nine sessions: 138-162 mm.
- This was tried once before and dropped for costing shake. The shake was one broken arm
  outline (68 px wide against the arm's 144 px) that the new scale happened to let through:
  the arm ruler took it as the arm stepping 40 % further away. Ruler readings that jump more
  than 15 % in one outline now wait for the next outline to agree (`RULER_GATE`); with that
  the still recording is calmer than before (shake 2.5 → 2.2 px, size pumping 1.7 → 1.0 %).
- The device **remembers** the wrist (`localStorage`, `mmto.wrist.v2`): MediaPipe's raw palm
  reading averaged over up to 5 sessions, and the wrist's shape as a ratio of the palm. Each
  session adds its reading, so the prior's weight falls as sessions average out MediaPipe's
  noise. v1 memories (millimetres at MediaPipe's scale) are not carried over. *Re-measure*
  forgets it.
- A tape-measured wrist (Fit panel) overrides all of it and is exact. It could not freeze
  before - the freeze test compared the taped width with the camera's readings - and now does.
- **No default wrist in production.** Until this session has measured the wrist (or the user
  typed a size, which is not kept between sessions) no size is shown, no fit verdict is
  given and nothing is worn: the solver's placeholder shape is nobody's wrist. Pieces are
  seated fresh on the first real size - seated on the placeholder, a cuff smaller than the
  real wrist was thrown off the arm when the arm grew 20 % around it. (Seating now also
  squeezes the arm to fit a piece smaller than it, as the running physics always did.)
- The bangle's metal was drawn centred on its inner edge, so half of it sank into the skin
  wherever it touched the arm; it now starts at the inner edge the physics holds on the arm.

A rigid bangle has to pass over the hand, so on the wrist it is always visibly larger than
the arm - a 180 mm bangle on a 150 mm wrist hangs about 1.3x the arm's width. Chains hug it.

**Live-app fixes the benches cannot see:** frames are detected with
`requestVideoFrameCallback` and stamped with the camera's capture time (~4 % of frames used
to be read under the previous frame's timestamp); weak tracking keeps the piece solid instead
of fading it to 65 % (a translucent jewel reads as a glitch); a hint asks for more light when
the camera drops below 20 fps (webcams halve their frame rate in dim light).

---

## The idea

MediaPipe is the **fast tracking/input layer only**. It supplies an ROI, an initial pose and
a metric anchor. It does **not** decide where the bracelet goes. Everything after it works
against our own metric model of the wrist.

```
CAMERA
  ├── hand landmarks          (MediaPipe, ~30 Hz)
  └── arm segmentation: selfie model on a WRIST CROP (skin only, ~10 Hz)
      + per-frame refinement (colour + guided filter) in the region of interest
             │
      WRIST OBSERVER            metric scale, anatomical frame, silhouette profile
             │
      TEMPORAL WRIST SOLVER     filtering, prediction, multi-view geometry, shape lock
             │
      WRIST DIGITAL TWIN        8 metric cross-sections, centreline, confidences
             │
   ┌─────────┼──────────┐
 FIT      PHYSICS     OCCLUSION
   │         │            │
   └─────────┼────────────┘
         RENDER           PBR + occlusion + camera-estimated lighting
```

## What the twin actually is

Not `{position, quaternion, scale}` — a metric description of the wrist and lower forearm:

| | |
|---|---|
| `crossSections[8]` | elliptical sections at 0–88 mm from the wrist crease, each with its own centre and semi-axes |
| `radialAxis / forearmAxis / dorsalAxis` | orthonormal anatomical frame |
| `wristWidthMm / wristDepthMm / circumferenceMm` | the numbers the fit engine sells against |
| `sleeveLimitMm` | where the arm's skin stops inside the frame, so we stop measuring there |
| four separate confidences | pose, geometry, sizing, occlusion |

### Width vs. depth is solved from multiple views

A single front-on frame cannot separate a wide flat wrist from a narrow deep one — both
project the same silhouette. Rotating the wrist changes which axis is visible, and
`GeometrySolver` least-squares fits the ellipse from the silhouette half-width at each roll
angle:

```
r(θ)² = a²cos²θ + b²sin²θ      (linear in a², b²)
```

Roll samples are **binned**, so holding still at one angle cannot dominate the fit, and the
solver **returns null** rather than inventing a depth when the system is ill-conditioned.
That is why the opening interaction asks for a slow wrist turn.

### 2D landmarks carry position, 3D landmarks carry rotation

These are different measurements and they come from different places:

- **Position** is solved from the **2D image landmarks**. Those are what actually
  align with the pixels the user sees. The world landmarks are a learned metric prior
  whose absolute translation is not trustworthy.
- **Rotation** comes entirely from the **3D world landmarks**. They are metric and free of
  perspective foreshortening, so the orientation stays stable as the hand moves toward or
  away from the camera.
- Landmark `z` from the 2D set is never used at all.

Position is **not** read off the wrist landmark. Landmark 0 is the least stable point
MediaPipe emits, and taking position from it puts all of its jitter on the bracelet.
Instead the world landmarks give a rigid 3D point set already in camera-aligned axes, so
only translation is unknown — 3 unknowns against 7 palm landmarks, or 14 residuals. That is
solved by Gauss-Newton against the true perspective projection, with Huber weighting so a
single bad landmark is outvoted rather than obeyed.

`npm run verify` projects a synthetic hand at a known pose and checks the round trip:
position recovers exactly, the anatomical axes to within 0.4°, and a deliberate 32 px fault
injected into the wrist landmark moves the result by 6 mm instead of 20 mm.

### The wrist is a joint: the bracelet follows the forearm, not the palm

Every landmark is on the hand, and the wrist is a two-axis joint. Reading the bracelet's
frame straight off the hand makes it tilt whenever the palm flexes or deviates, although
the forearm has not moved. `ForearmEstimator` models the joint:

- **Bracelet frame = hand frame with the joint's swing removed.** The hand frame is rotated
  by the smallest rotation that takes the hand axis onto the forearm axis. Twist
  (pronation/supination) survives that untouched, which is correct: the distal forearm
  rolls with the hand. So only the forearm *direction* has to be estimated.
- **Silhouette → in-image direction.** The arm's line in the image fixes a plane through the
  camera; the direction is projected onto it (exact under perspective). The line is fitted
  about the skin centres' own centroid, not pinned to landmark 0, which sits off the
  centreline. The search is seeded from the previous forearm estimate, not the palm.
- **Wrist motion → arm or joint?** If a hand rotation came from the elbow, the wrist moved by
  `ω × (wrist − elbow)`. The measured wrist velocity is projected onto that prediction over a
  ~130 ms baseline: agreement carries the rotation onto the forearm, no agreement means the
  wrist bent and the forearm holds still.
- **Range of motion + slow relaxation** toward the hand axis (τ = 4 s) keep the estimate
  inside what the anatomy can reach.

`npm run verify` drives observer + tracker with a hand hinged on a synthetic forearm: a 45°
palm flex moves the bracelet 1.5° (it used to move it 45°), deviation 0.6°, a 40° elbow
swing is followed to within 2°, a 70° pronation is followed to within 0.3°, all with and
without detector-grade landmark noise.

Rotation is smoothed in two parts (`OrientationFilter`: 1€ on the forearm axis, a Kalman
filter on the roll about it), and the pose is predicted to
the capture time of the **video frame on screen**, not to wall-clock time. Predicting to
`now` put the bracelet ahead of an arm still showing the previous camera frame.

### Measured on real recordings, not just synthetic hands

`fixtures/<clip>/recording.v1.bin` are real webcam clips (JPEG frames, MediaPipe image +
world landmarks, selfie-multiclass masks) recorded with the **vto-bracelets** recorder;
`npm run bench` replays them headlessly. The clips are gitignored — they are video of a
real person. Several things only showed up there:

- **The bracelet anchor sat 14–40 px (p50) beside the wrist.** MediaPipe's 3D cloud and
  its 2D landmarks disagree in shape by ~10 px, so a rigid fit's wrist is not where the
  wrist is on screen. The anchor now follows the 2D wrist landmark at the solved depth,
  with the fit-to-landmark offset low-passed so a one-frame glitch is damped: 1–2 px p50.
- **A shirt behind the arm read as a sleeve on 100 % of frames**, and an arm touching the
  neck was unmeasurable, because widths came from sideways ray marches. `ArmProfiler`
  (the vto-bracelets forearm approach, in plain JS — no OpenCV) resamples the mask into an
  arm-aligned corridor, keeps only the skin connected to the wrist, follows the ridge row
  by row, flags rows that merge with neighbouring skin, and calls it a sleeve only when
  fabric continues ALONG the arm. Front-clip axis jitter p95 dropped 4.1° → ~1°.
- **An edge-on palm seeds the search into the neck.** When the seeded corridor is weak, a
  fan of directions is tried and the one that finds a long straight arm wins.
- **Segmentation lags fast motion.** A mask with no skin under this frame's hand is
  refused as stale instead of placing the forearm where the hand used to be.
- **Hand scale**: the vto-bracelets seven-edge robust estimator (per-edge foreshortening,
  per-session anatomy ratios, robust band, trimmed mean) is used when confident, the plain
  wrist-to-knuckle mean otherwise; filtered scale varies 10–30 % less across the clips.
- **Lens**: 72° diagonal default (was 60° vertical ≈ 98° diagonal — wider than any webcam);
  the browser-reported FOV or a per-device cached value wins when present.

Tried and rejected on the same data: a PnP rotation correction (with rotation free the
residual still floors at ~10 px — it is shape mismatch, and the fitted "corrections" swing
8–18°), and focal self-calibration from landmarks (the residual keeps falling toward
narrower lenses because of that same mismatch, so it is not observable here).

### Arm segmentation: measured against Segment Anything

The arm mask decides the forearm axis, the wrist width and the occluder, so it was rebuilt
and chosen by measurement (`tools/eval`, see its README): SAM reference masks on the
recorded clips, candidate pipelines run in real Chrome, scored on axis angle and arm width.

| pipeline (front + side + rotation, 135 frames) | arm found | axis error | width error |
|---|---|---|---|
| full-frame selfie model + old profiler | 82 % | 4.2° | 8.0 % |
| wrist crop + refinement + edge-line profiler (now) | 100 % | 2.0° | 3.1 % |

- **Wrist crop** (`ArmSegmenter`): the network sees a square 4.4 palm lengths around the
  wrist instead of the whole frame — several times more pixels on the arm. Edge-on it took
  width error from 43–62 % to ~3 %. Skin confidence only; clothing is not segmented.
- **Per-frame refinement** (`MaskRefiner`, ~3–5 ms at 160 px): the network's last output
  is shifted with the wrist, fused with a per-frame colour model of this person's skin vs
  this background, and snapped to image edges with a guided filter.
- **Robust edge lines** (`ArmProfiler`): the forearm's left and right outlines are fitted
  as separate robust lines, so a stretch where the arm fuses with neck skin — the main
  width error on the recordings — is outvoted instead of measured as a fat arm. Candidates
  are ranked on anatomical width and on agreement with the tracked direction.
- **Scale lock**: the hand's metric size is learned from well-measured frames and held;
  per-frame depth follows from it. Mid-roll, the raw solve had swung 0.33 → 0.60 mm/px;
  rotation-clip axis jitter p95 went 3.0° → 0.5°.
- Tracking state reflects the pose only; wrist-shape confidence no longer reads as
  "tracking is weak".
- **Bracelet on the arm's centreline, side-on too.** Palm edge-on, MediaPipe's wrist
  landmark sits on the arm's edge; the measured centreline correction (~half the arm's
  width) was being applied mirrored, hanging the bracelet off the arm in 30 % of side-on
  frames. Fixed, and the two outlines are now fitted jointly (shared lean, bounded taper)
  so one edge cannot wander onto the neck. The segmentation overlay shows the measured arm
  in green and ignored skin in grey.
- **The wrist ring was pinned to the arm's edge.** It sits on the heel of the palm and is
  never measured, so its centreline correction stayed zero and tilted the rendered forearm
  by ~15° side-on. Unmeasured rings now take the nearest measured correction; rendered
  direction error is 0.7-2.6° (p50).
- **The arm is the ruler.** Depth - and so the bracelet's size on screen - comes mainly
  from the arm's width in pixels between the two fitted outlines, not from the palm's
  landmarks re-measured every frame. Rendered-vs-real arm width went from 1.21x with
  +-20 % breathing to 1.00x (front 0.98-1.03).
- **Tilt in depth from perspective: built, measured, switched off.** The outlines' apparent
  taper can measure the arm's lean toward/away from the camera (an arm leaning away
  narrows faster than its ~0.06 %/mm anatomical taper). It straightened the rendered
  arm's width toward the elbow, but raised axis jitter 3-8x at every gain tried, so it is
  off (`PITCH_GAIN`) until a steadier input exists.
- **Measure once, then freeze** - once the readings have settled (>= 30 width readings
  with an interquartile spread within 10 %, the estimate converged onto them). After ~1.5 s of good frames (a measured wrist section, a
  confident pose, the metric scale locked - or ~3 s without the scale lock) the wrist's
  3D shape - cross-section and taper along the arm - is frozen; only the pose moves after
  that. A wrist turn still helps (it measures depth); without one, depth is read from the
  measured width with a typical 1.3 width:depth. "Re-measure" unfreezes it.
- **A procedural arm, not a per-frame shape.** The 3D arm is a straight elliptical tube of
  fixed length with the measured anatomical taper; its only shape parameters are the
  wrist's width and depth (measured once, then frozen), plus ONE sideways centreline
  offset (1€-smoothed) - not eight per-ring offsets and a measured taper that let it flex
  and wobble every frame. Only its pose moves.
- **The arm model's length never flickers.** The tube's length is fixed; the fitted
  outline and the occluder span all of it, whatever length of forearm this frame's mask
  happened to show (it swung ~5-20 cm). Before, the occluder was cut back to the mask's
  reach - to nothing on some side-on frames - and the bracelet ended up past its end.
- **Bracelet physics** is real rigid-body and XPBD physics with one *liveliness* setting
  (see *Premium pass* above); it replaced a stable mode that capped sag at 1.5 mm and tilt
  at 3 deg.
- **Invisible walls: two planes at the ends of the arm tube** (`physics/walls.js`, 6 mm
  and 84 mm up the forearm). The bracelet moves freely between them - it slides along the
  arm in both physics modes - and can never pass either, so it cannot leave the tube.
  Physics only: never drawn or occluding (debug: *Show invisible walls* draws the planes).
  The tube itself now ends just past the start plane instead of reaching 2 cm into the
  palm.
- **Loose-ring tilt fixed.** Gravity tilt was largest with the forearm vertical, exactly
  where its axis (forearm x gravity) is undefined, so the ring tipped to an arbitrary
  side. With contact physics a ring round a vertical arm lands on the widening arm and
  hangs level to within a few degrees; tilt is capped by liveliness (4-10 deg).
- **Everything on the arm lives in arm space** (`WristDigitalTwin.frameMatrix`). The
  occluder tube is built once in the arm's own frame and only its matrix follows the pose;
  chain physics runs in that frame too, and the links are drawn under the same matrix. Pose
  jitter used to teleport the tube through a world-space chain and unthread it (off the arm
  in ~95 % of frames under live-like jitter); now arm and bracelet can only move together.
  The arm's real motion reaches the chain as filtered fictitious forces (`ArmInertia`).
- **Chains no longer creep round the wrist.** The bend constraint's weights pushed every
  loop along itself (a tennis bracelet spun ~190°/s round a still arm); it now conserves
  momentum, Gauss-Seidel sweeps alternate direction, and links on skin get Coulomb
  friction, so a resting bracelet rests.
- **The detector's palm flips are gated** (`wrist/PoseGates.js`). In fast or blurred
  frames MediaPipe reports the hand turned over - 2D and 3D landmarks flip together, 100-140°
  of roll in 33 ms, several times a second. A twist faster than a wrist can turn is dropped
  (the forearm direction is still followed) unless it persists 300 ms, and is then turned
  into at 360°/s. The centreline offset gets a one-frame outlier gate and a 90 mm/s slew.
- **Warm-up before showing anything.** A new track stays invisible until 4 consecutive
  steady observations (confident, same hand, palm depth not lurching), then the pose
  filters restart from there - no more bracelet flying in while MediaPipe locks on.
- **The fitted arm outline beats the raw mask for occlusion.** On a hairy, shadowed
  forearm the mask gives out partway down the arm; inside the fitted outline the occluder
  now treats the arm as arm regardless.

### Seeing the rotation solve

Turn on **Show wrist frame (rotation)** in the Engine panel. It draws every piece of
evidence the rotation solve uses:

| | |
|---|---|
| thick axes | the filtered, predicted frame that drives the jewellery |
| thin axes | the raw per-frame observation, before smoothing |
| palm plane | the wrist-index-pinky triangle: the hand's frame, which is evidence, not the answer |
| thumb vector | the anatomical evidence that fixes the dorsal sign |
| roll ring + arc | the dorsal axis against the camera axis - the angle the wrist-depth fit samples |

Three more overlays sit alongside it: **hand landmarks**, **wrist occluder** and
**segmentation mask** (the refined arm probability over its blue region of interest,
amber = uncertain, green = arm). The segmentation view
matters most: the mask decides where the wrist is measured, where measurement stops at a
sleeve, and where the occluder is trimmed, and until you can see it you are guessing.

The gap between the thick and thin axes is the smoothing and prediction working, so it is
meant to be visible rather than zero. Numeric roll, dorsal agreement and angular speed are
shown alongside.

### Shape is locked, pose is not

Wrist shape does not change during a session. Once the fit is confident and well-covered,
the shape is **frozen** and only pose updates. This removes most of the scale breathing that
makes AR jewellery look fake. Pose is filtered with a 1€ filter and extrapolated with linear
and angular velocity, so the render loop runs at display rate regardless of detector rate.

### The dorsal axis comes from anatomy, not a label

The back of the hand is identified from the thumb's out-of-plane component, not from
MediaPipe's handedness string. This stays correct through mirroring, handedness mislabels
and left/right swaps — the usual cause of a bracelet flipping 180°.

## Fit is a product question, not a rendering question

The bracelet **keeps its manufactured size**. A 180 mm bangle on a 146 mm wrist has 34 mm of
real slack, and you see that slack. `FitSolver` reports:

- where the piece comes to rest (a loose ring slides up until the forearm is wide enough)
- slack, air gap and a plain-language verdict
- whether a rigid bangle can even **pass over the hand**
- a recommended size in mm

And it reports **two different confidences**, because they are genuinely different things:

```
Visual fit confidence      — the bracelet sits on the arm correctly
Physical size confidence   — the millimetres are right
```

Monocular scale rests on MediaPipe's world landmarks, which are a learned prior, not an
instrument. Physical size confidence is therefore **capped at 0.8** and only reaches 0.97
when the user enters a tape measurement. The UI shows both.

## Different bracelets need different physics

| Category | Solver | Behaviour |
|---|---|---|
| `rigid_bangle` | `RigidSolver` | XPBD rigid body: rests on the wrist, knocks, slides, cocks, settles |
| `open_cuff` | `RigidSolver` | the same body, sprung onto the wrist, opening at its bearing |
| `tennis_bracelet` | `XPBDChainSolver` | inextensible links, holds its arc, band stays flat along the arm |
| `chain` | `XPBDChainSolver` | inextensible links that drape both ways, sags and slides |
| `charm_bracelet` | `XPBDChainSolver` | loose links plus charms as pendulums that pull on their link |

Both step at a fixed rate in the `JewelleryFrame` and collide with the tapered arm tube;
skin friction holds a piece where it comes to rest (see *Premium pass*).

**Stacking is native.** Each piece gets its own band of forearm and chains collide with
their neighbours, so three bracelets sit side by side instead of intersecting.

## Assets are data, not code

`src/vto/assets/schema.js` defines the format. A product is real millimetres plus a
behaviour class — no bespoke code per SKU. Set `model` to a GLB and fit and physics are
unchanged, because both read the same numbers the procedural mesh does.

```js
{
  category: 'tennis_bracelet',
  units: 'mm',
  innerCircumferenceMm: 178,
  stockRadiusMm: 1.5,
  links: { count: 38, lengthMm: 4.7, widthMm: 3.8, bendStiffness: 0.72 },
  fit: { clearanceMm: 0.8, stiffness: 0.72, slide: true, preferredOffsetMm: 18 },
  stones: { sizeMm: 3.1, perLink: 1 },
}
```

## Photoreal integration

- **Occlusion** — a lofted mesh of the actual twin writes depth, then is trimmed per-pixel
  to the segmentation silhouette. A chain passing behind the arm is hidden by real geometry,
  not by an invisible cylinder. Outside the mask's region of interest the twin geometry alone decides.
- **Lighting** — key direction, key intensity, ambient level and colour temperature are
  estimated from the camera frame, plus a low-resolution local environment that includes a
  blurred crop of the wearer's own wrist, so the metal picks up warm skin bounce.
- **Confidence-aware rendering** — `EXCELLENT / GOOD / DEGRADED / LOST` with hysteresis.
  The piece fades in and out, but is never drawn see-through while tracked: weak tracking
  shows a hint, not a ghost.

## Temporal quality is a first-class metric

Most AR looks fine in a screenshot and falls apart in motion, so the engine measures itself
while the hand is still and the diagnostics panel shows it against internal targets:

| | target |
|---|---|
| positional jitter | ≤ 2 px |
| rotation jitter | ≤ 1° |
| scale breathing | ≤ 1 % |

These are engineering targets for this product, not an external standard.

## Layout

```
src/vto/
  core/          1€ and Kalman filters, ellipse fit, tracking state machine
  camera/        capture + a single pinhole model shared by perception and renderer
  perception/    hand landmarks; wrist-crop arm segmentation + per-frame refinement
  wrist/         observer, multi-view geometry solver, temporal twin
  fit/           product mm vs. measured wrist
  physics/       XPBD rigid + chain solvers, jewellery frame, arm tube, inertia, liveliness
  capture/       guided recorder of test clips (dev only)
  render/        materials, procedural jewellery, occluder, lighting
  assets/        asset schema + demo catalogue
  VTOEngine.js   the per-frame pipeline
```

## Known limits

- **Sizing accuracy** is bounded by monocular scale. Relative geometry is good; absolute
  millimetres rest on MediaPipe's palm scale (±14 % between sessions of the same hand on the
  recordings) pulled toward an average adult palm, so an individual's wrist is still an
  estimate - about ±6-8 %, more for hands far from average. This is surfaced as a separate
  confidence rather than hidden; the device remembers a measured wrist, and the manual wrist
  input overrides it.
- **Occlusion** is twin geometry trimmed by a segmentation mask, not per-pixel metric depth.
  Fingers crossing in front of the wrist are handled only as far as the mask allows. A
  learned depth model (e.g. Depth Anything V2 Small, Apache-2.0) or ARCore/ARKit hardware
  depth would slot in behind the same interface.
- **Perception runs on the main thread** behind a frame budget. The scheduler is isolated in
  `PerceptionSystem` so moving it to a worker is a contained change.
- Lens angle is a 72° diagonal default unless the browser reports one or a per-device
  value was stored (`CameraModel.rememberLens`). Focal length cancels out of the metric
  wrist measurement but affects 3D depth and perspective.
- Chains show up to ~10 % worst-case link stretch while pressed against the arm under heavy
  synthetic jitter (`npm run verify`); at rest they hold their length.
- **Perception runs at the camera's frame rate**, and a webcam in dim light delivers 10-15 fps
  (seen on real sessions): no tracking looks smooth then. The app says so.
- **A palm tilt held perfectly still** is genuinely ambiguous from one camera without the
  arm silhouette: nothing distinguishes "wrist bent" from "arm tilted toward the camera".
  The estimate relaxes toward the hand over ~4 s (a 45° flex held for 2 s shows ~18°).
  Metric depth along the forearm (see below) removes this ambiguity outright.
- **Pose landmarking was tried and removed.** The elbow is in principle a much better
  forearm axis than the palm proxy, but for bracelet try-on the wrist is held close to the
  camera, so the elbow and shoulder are routinely out of frame or badly estimated. It made
  the axis worse and cost a whole extra model in the frame budget.
- No custom trained wrist model. The multi-view ellipse fit plus anthropometric priors is
  what replaces it; a dedicated wrist-geometry network trained on consented data is the
  natural next step and would raise both geometry and sizing confidence.
