/**
 * Replays REAL recorded clips through the wrist pipeline and reports how it
 * behaves. `npm run verify` proves the maths on synthetic hands; this is the
 * check against what MediaPipe actually emits on a real arm.
 *
 *   npm run bench                 all clips in fixtures/
 *   npm run bench -- rotation     one clip
 *   npm run bench -- --json       machine-readable
 *
 * There is no ground-truth pose in a real recording, so the metrics are the
 * ones that do not need it: how often each evidence source is usable, and how
 * much the output shakes beyond what smooth motion explains (second
 * differences, which cancel constant velocity).
 */
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { decodeFixture } from '../src/vto/replay/fixtureFormat.js'
import { decodeArmMasks, sampleArmMask } from '../src/vto/replay/armMaskFormat.js'
import { CameraModel } from '../src/vto/camera/CameraModel.js'
import { WristObserver } from '../src/vto/wrist/WristObserver.js'
import { WristTracker } from '../src/vto/wrist/WristTracker.js'
import { LandmarkSourceBuilder } from '../src/vto/wrist/LandmarkSources.js'
import { SEG_CLASS } from '../src/vto/perception/models.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
const FIXTURES = path.join(ROOT, 'fixtures')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const masksIdx = args.indexOf('--masks')
/**
 * --masks <method>: use soft masks produced by the eval harness
 * (tools/eval/out/<method>/<clip>/<i>.bin, e.g. app_3 = the app's own
 * ArmSegmenter) instead of the clip's recorded full-frame category mask.
 */
const maskMethod = masksIdx >= 0 ? args[masksIdx + 1] : null
const only = args.filter((a, i) => !a.startsWith('--') && (masksIdx < 0 || i !== masksIdx + 1))

/** Perception stand-in fed from an eval-harness soft mask at frame resolution. */
function softPerception(clipId, fixture, frame) {
  const file = path.join(ROOT, 'tools/eval/out', maskMethod, clipId, `${frame.index}.bin`)
  if (!fs.existsSync(file)) return { armMask: null, sampleMask: () => -1 }
  const data = fs.readFileSync(file)
  const w = fixture.analysisWidth
  const h = fixture.analysisHeight
  return {
    armMask: { data, width: w, height: h, version: frame.index + 1 },
    sampleMask(u, v) {
      const fx = u * w - 0.5
      const fy = v * h - 0.5
      if (fx < -0.5 || fy < -0.5 || fx > w - 0.5 || fy > h - 0.5) return -1
      const x0 = Math.max(0, Math.floor(fx))
      const y0 = Math.max(0, Math.floor(fy))
      const x1 = Math.min(w - 1, x0 + 1)
      const y1 = Math.min(h - 1, y0 + 1)
      const ax = Math.min(1, Math.max(0, fx - x0))
      const ay = Math.min(1, Math.max(0, fy - y0))
      return data[y0 * w + x0] * (1 - ax) * (1 - ay) + data[y0 * w + x1] * ax * (1 - ay) +
        data[y1 * w + x0] * (1 - ax) * ay + data[y1 * w + x1] * ax * ay
    },
  }
}

/**
 * Perception stand-in for one frame. Clips recorded in the app (src/vto/capture)
 * carry the live pipeline's own soft arm mask per frame (armmask.bin), which
 * is replayed exactly - region of interest, bilinear lookup, "unknown" outside
 * it - so the replay sees what the app saw. Older clips fall back to their
 * hard full-frame category mask.
 */
export function maskPerception(fixture, frame) {
  if (fixture.armMasks) {
    const mask = fixture.armMasks[frame.index] ?? null
    return {
      armMask: mask ? { ...mask, version: frame.index + 1 } : null,
      sampleMask: (u, v) => sampleArmMask(mask, u, v),
    }
  }
  const w = fixture.categoryMaskWidth
  const h = fixture.categoryMaskHeight
  const data = new Uint8Array(w * h)
  const cat = frame.categoryMask
  for (let i = 0; i < data.length; i++) {
    const c = cat[i]
    data[i] = c === SEG_CLASS.BODY_SKIN ? 255 : 0
  }
  const armMask = { data, width: w, height: h, version: frame.index + 1 }
  return {
    armMask,
    sampleMask(u, v) {
      const x = Math.round(u * (w - 1))
      const y = Math.round(v * (h - 1))
      if (x < 0 || y < 0 || x >= w || y >= h) return -1
      return data[y * w + x]
    },
  }
}

export function handResult(frame) {
  const ok = frame.landmarks.some((p) => p.x !== 0 || p.y !== 0)
  if (!ok) return null
  return {
    landmarks: [frame.landmarks],
    worldLandmarks: [frame.worldLandmarks],
    handedness: [[{ categoryName: frame.handedness.label, score: frame.handedness.score }]],
  }
}

const stats = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return { mean: NaN, p50: NaN, p95: NaN }
  const at = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, p50: at(0.5), p95: at(0.95) }
}

/** Angle between a unit vector and its constant-velocity prediction. */
function secondDiffDeg(series) {
  const out = []
  for (let i = 2; i < series.length; i++) {
    const [a, b, c] = [series[i - 2], series[i - 1], series[i]]
    if (!a || !b || !c) continue
    const predicted = b.clone().multiplyScalar(2).sub(a).normalize()
    out.push(THREE.MathUtils.radToDeg(predicted.angleTo(c)))
  }
  return out
}

function secondDiffPx(series) {
  const out = []
  for (let i = 2; i < series.length; i++) {
    const [a, b, c] = [series[i - 2], series[i - 1], series[i]]
    if (!a || !b || !c) continue
    out.push(Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y))
  }
  return out
}

export function runClip(fixture, { fovYDeg = fixture.meta?.fovYDeg, configure, clipId } = {}) {
  const cam = new CameraModel({ fovYDeg })
  cam.setResolution(fixture.videoWidth, fixture.videoHeight, false)
  const observer = new WristObserver(cam)
  const tracker = new WristTracker(cam)
  configure?.({ cam, observer, tracker })
  const sources = new LandmarkSourceBuilder()

  let t = 1000
  let observations = 0
  let silhouette = 0
  const silConf = []
  const sections = []
  const reproj = []
  const joint = []
  const rawAxis = []
  const twinAxis = []
  const twinDorsal = []
  const twinPx = []
  const widths = []
  let sleeve = 0

  for (const frame of fixture.frames) {
    t += frame.dtMs || 33
    const result = handResult(frame)
    const source = result ? sources.build(result, cam) : null
    const perception = maskMethod ? softPerception(clipId, fixture, frame) : maskPerception(fixture, frame)
    const obs = source ? observer.observe(source, perception, t) : null
    if (obs) {
      observations++
      if (obs.forearmFromSilhouette) silhouette++
      silConf.push(obs.silhouetteConfidence)
      sections.push(obs.measuredSections)
      reproj.push(obs.reprojectionPx)
      joint.push(obs.forearmCorrectionDeg)
      if (obs.sleeveLimitMm !== Infinity) sleeve++
      tracker.ingest(obs)
      rawAxis.push(obs.basis.y.clone())
    } else {
      rawAxis.push(null)
    }
    const twin = tracker.update(t, (frame.dtMs || 33) / 1000, t)
    if (twin.valid) {
      twinAxis.push(twin.forearmAxis.clone())
      twinDorsal.push(twin.dorsalAxis.clone())
      twinPx.push(cam.project(twin.center, { x: 0, y: 0 }))
      widths.push(twin.wristWidthMm)
    } else {
      twinAxis.push(null)
      twinDorsal.push(null)
      twinPx.push(null)
    }
  }

  const n = fixture.frames.length
  return {
    frames: n,
    observedPct: (100 * observations) / n,
    silhouettePct: (100 * silhouette) / Math.max(1, observations),
    silhouetteConf: stats(silConf).mean,
    sectionsMeasured: stats(sections).mean,
    sleevePct: (100 * sleeve) / Math.max(1, observations),
    reprojectionPx: stats(reproj).p50,
    jointDegP50: stats(joint).p50,
    rawAxisJitterDeg: stats(secondDiffDeg(rawAxis)),
    axisJitterDeg: stats(secondDiffDeg(twinAxis)),
    dorsalJitterDeg: stats(secondDiffDeg(twinDorsal)),
    positionJitterPx: stats(secondDiffPx(twinPx)),
    wristWidthMm: widths.at(-1),
    geometry: {
      widthMm: tracker.geometry.widthMm,
      depthMm: tracker.geometry.depthMm,
      circumferenceMm: tracker.geometry.circumferenceMm,
      locked: tracker.geometry.locked,
      coverage: tracker.geometry.coverage,
    },
  }
}

export function loadClips(filter = []) {
  if (!fs.existsSync(FIXTURES)) return []
  return fs
    .readdirSync(FIXTURES)
    .filter((id) => !filter.length || filter.includes(id))
    .map((id) => ({ id, file: path.join(FIXTURES, id, 'recording.v1.bin') }))
    .filter((c) => fs.existsSync(c.file))
    .map((c) => ({ id: c.id, fixture: withSidecars(decodeFixture(fs.readFileSync(c.file)), path.dirname(c.file)) }))
}

/**
 * Attach what the in-app recorder writes next to a clip: capture.json
 * (scenario, lens, timing) as `meta`, armmask.bin as `armMasks` (one entry per
 * frame, null where the app had no mask).
 */
function withSidecars(fixture, dir) {
  const metaFile = path.join(dir, 'capture.json')
  if (fs.existsSync(metaFile)) fixture.meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  const maskFile = path.join(dir, 'armmask.bin')
  if (fs.existsSync(maskFile)) {
    const { frames } = decodeArmMasks(fs.readFileSync(maskFile))
    if (frames.length === fixture.frames.length) fixture.armMasks = frames
    else console.warn(`${dir}: armmask.bin has ${frames.length} frames, clip has ${fixture.frames.length} - ignored`)
  }
  return fixture
}

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '  - ')
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '  - ')

if (process.argv[1]?.endsWith('bench.mjs')) {
  const clips = loadClips(only)
  if (!clips.length) {
    console.log('No recordings in fixtures/<clip>/recording.v1.bin - record some with the vto-bracelets recorder.')
    process.exit(0)
  }
  const report = {}
  for (const { id, fixture } of clips) report[id] = runClip(fixture, { clipId: id })

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('clip              obs%  sil%  silConf  sect/8  sleeve%  reproj  joint50 | axis jit p50/p95 (raw p50) | roll jit p50 | pos jit p50 px | width  depth  circ  lock')
    for (const [id, r] of Object.entries(report)) {
      console.log(
        `${id.padEnd(17)} ${f1(r.observedPct).padStart(5)} ${f1(r.silhouettePct).padStart(5)}  ${f2(r.silhouetteConf).padStart(6)}  ${f1(r.sectionsMeasured).padStart(5)}  ${f1(r.sleevePct).padStart(6)}  ${f1(r.reprojectionPx).padStart(5)}  ${f1(r.jointDegP50).padStart(6)}  | ` +
        `${f2(r.axisJitterDeg.p50)} / ${f2(r.axisJitterDeg.p95)} (${f2(r.rawAxisJitterDeg.p50)})`.padEnd(27) +
        `| ${f2(r.dorsalJitterDeg.p50).padStart(11)} | ${f2(r.positionJitterPx.p50).padStart(14)} | ` +
        `${f1(r.geometry.widthMm)}  ${f1(r.geometry.depthMm)}  ${f1(r.geometry.circumferenceMm)}  ${r.geometry.locked ? 'yes' : 'no'}`,
      )
    }
  }
}
