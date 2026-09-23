/**
 * What the USER sees: replays the recorded clips through the whole live
 * pipeline - observer, tracker, fit, physics - at the app's render rate, and
 * measures the jewellery on screen rather than the tracker's internals.
 *
 *   npm run bench:jewelry                 all clips, stable physics
 *   npm run bench:jewelry -- rotation     one clip
 *   npm run bench:jewelry -- --realistic  realistic physics
 *   npm run bench:jewelry -- --json
 *
 * Camera frames arrive at the clip's own timing; between them the render
 * loop runs at 60 Hz, exactly as VTOEngine does (the display time stays on
 * the frame that is showing). Only frames where the jewellery is visible
 * (presence above 5 %) are measured. Metrics are p50 / p95:
 *
 *   shake px   second difference of a projected point on the piece (its
 *              centre and a point on its rim) - motion that smooth movement
 *              does not explain, i.e. what reads as jitter. Per CAMERA frame:
 *              the picture itself only changes at the camera rate, and the
 *              piece has to step with it, not glide past it.
 *   turn deg   the same for the piece's orientation, per camera frame
 *   (picture)  the detector's raw wrist landmark, per camera frame: how much
 *              the arm in the VIDEO itself shakes. The jewellery should follow
 *              the picture, so its shake is judged against this row.
 *   on-arm mm  how far the piece moves relative to the arm per RENDER frame
 *              (in arm space): zero for a piece that sits still on a still arm
 */
import * as THREE from 'three'
import { CameraModel } from '../src/vto/camera/CameraModel.js'
import { WristObserver } from '../src/vto/wrist/WristObserver.js'
import { WristTracker } from '../src/vto/wrist/WristTracker.js'
import { LandmarkSourceBuilder } from '../src/vto/wrist/LandmarkSources.js'
import { FitSolver } from '../src/vto/fit/FitSolver.js'
import { RigidSolver } from '../src/vto/physics/RigidSolver.js'
import { XPBDChainSolver } from '../src/vto/physics/XPBDChainSolver.js'
import { getBracelet } from '../src/vto/assets/catalog.js'
import { BraceletCategory } from '../src/vto/assets/schema.js'
import { loadClips, maskPerception, handResult } from './bench.mjs'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const realistic = args.includes('--realistic')
const only = args.filter((a) => !a.startsWith('--'))

const RENDER_DT = 1 / 60
/**
 * Render frames left out of the on-arm metric while pieces settle from where
 * they were first placed onto where they rest: the clips are only 1-2 s long,
 * and that one-off slide would otherwise dominate a number about jitter.
 */
const SETTLE_FRAMES = 60
const PIECES = ['bangle-classic-18k', 'cuff-wide-silver', 'tennis-brilliant', 'charm-heirloom']

const stats = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return { p50: NaN, p95: NaN }
  const at = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]
  return { p50: at(0.5), p95: at(0.95) }
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

const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()
/** Orientation jitter: angle between q[i] and its constant-rate prediction. */
function secondDiffDeg(series) {
  const out = []
  for (let i = 2; i < series.length; i++) {
    const [a, b, c] = [series[i - 2], series[i - 1], series[i]]
    if (!a || !b || !c) continue
    // Constant rate: the step a -> b (world frame, b a^-1), taken again from b.
    _qa.copy(a).invert().premultiply(b)
    _qb.copy(_qa).multiply(b)
    out.push(THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(_qb.dot(c))))))
  }
  return out
}

/** Pose of a piece: centre, one rim point, orientation, and its arm-space centre. */
function samplePiece(inst, twin, frameInv) {
  if (inst.rigid) {
    const r = inst.rigid
    const rim = new THREE.Vector3(inst.fit.ringA, 0, 0).applyQuaternion(r.quaternion).add(r.position)
    return {
      centre: r.position.clone(),
      rim,
      quaternion: r.quaternion.clone(),
      onArm: r.position.clone().applyMatrix4(frameInv),
      onArmRim: rim.clone().applyMatrix4(frameInv),
    }
  }
  const c = inst.chain
  const n = c.particles.length
  const centre = c.particles.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / n)
  const local = c.local.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / n)
  // Orientation of the loop: its first link relative to the centre, and the arm axis.
  const x = c.particles[0].clone().sub(centre).normalize()
  const y = twin.forearmAxis.clone()
  const z = new THREE.Vector3().crossVectors(x, y).normalize()
  x.crossVectors(y, z)
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))
  return {
    centre,
    rim: c.particles[0].clone(),
    quaternion: q,
    onArm: local,
    onArmRim: c.local[0].clone(),
  }
}

export function runJewelry(fixture, { configure, realistic: real = realistic } = {}) {
  const cam = new CameraModel()
  cam.setResolution(fixture.videoWidth, fixture.videoHeight, false)
  const observer = new WristObserver(cam)
  const tracker = new WristTracker(cam)
  configure?.({ cam, observer, tracker })
  const sources = new LandmarkSourceBuilder()
  const fitSolver = new FitSolver()

  const instances = PIECES.map((id) => {
    const asset = getBracelet(id)
    const articulated = asset.category !== BraceletCategory.RIGID_BANGLE && asset.category !== BraceletCategory.OPEN_CUFF
    return { asset, fit: null, rigid: articulated ? null : new RigidSolver(), chain: articulated ? new XPBDChainSolver() : null, series: [], shown: [] }
  })
  const arm = { px: [], q: [], picture: [] }

  let t = 1000
  let now = 1000
  const frameInv = new THREE.Matrix4()
  for (const frame of fixture.frames) {
    const frameMs = frame.dtMs || 33
    t += frameMs
    const result = handResult(frame)
    const source = result ? sources.build(result, cam) : null
    const obs = source ? observer.observe(source, maskPerception(fixture, frame), t) : null
    if (obs) tracker.ingest(obs)
    arm.picture.push(source ? { x: source.px[0].x, y: source.px[0].y } : null)
    // Render frames until the next camera frame, the display time held on this one.
    const renders = Math.max(1, Math.round(frameMs / (RENDER_DT * 1000)))
    for (let r = 0; r < renders; r++) {
      now = t + r * RENDER_DT * 1000
      const twin = tracker.update(now, RENDER_DT, t)
      if (!twin.valid || tracker.presence < 0.05) {
        if (r === 0) {
          arm.px.push(null)
          arm.q.push(null)
        }
        for (const inst of instances) {
          inst.series.push(null)
          if (r === 0) inst.shown.push(null)
        }
        continue
      }
      const shown = r === 0 // the first render of a camera frame
      if (shown) {
        arm.px.push(cam.project(twin.pointAt(20), { x: 0, y: 0 }))
        arm.q.push(twin.quaternion.clone())
      }
      frameInv.copy(twin.frameMatrix()).invert()
      let cursor = 0
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i]
        const width = Math.max(inst.asset.stockRadiusMm * 2, inst.asset.links?.widthMm ?? 0)
        const bias = i === 0 ? 0 : cursor
        cursor += width + 1.6
        inst.fit = fitSolver.evaluate(inst.asset, twin, bias)
        if (inst.rigid) inst.rigid.solve(inst.asset, inst.fit, twin, RENDER_DT, { realistic: real })
        else inst.chain.solve(inst.asset, inst.fit, twin, RENDER_DT, [], { realistic: real })
        const s = samplePiece(inst, twin, frameInv)
        s.px = cam.project(s.centre, { x: 0, y: 0 })
        s.rimPx = cam.project(s.rim, { x: 0, y: 0 })
        inst.series.push(s)
        if (shown) inst.shown.push(s)
      }
    }
  }

  const report = {
    arm: { shakePx: stats(secondDiffPx(arm.px)), turnDeg: stats(secondDiffDeg(arm.q)) },
    picture: { shakePx: stats(secondDiffPx(arm.picture)) },
    pieces: {},
  }
  for (const inst of instances) {
    const s = inst.series
    const onArm = []
    for (let i = Math.max(1, SETTLE_FRAMES); i < s.length; i++) {
      if (!s[i] || !s[i - 1]) continue
      onArm.push(Math.max(s[i].onArm.distanceTo(s[i - 1].onArm), s[i].onArmRim.distanceTo(s[i - 1].onArmRim)))
    }
    report.pieces[inst.asset.id] = {
      shakePx: stats(secondDiffPx(inst.shown.map((x) => x?.px))),
      rimShakePx: stats(secondDiffPx(inst.shown.map((x) => x?.rimPx))),
      turnDeg: stats(secondDiffDeg(inst.shown.map((x) => x?.quaternion))),
      onArmMm: stats(onArm),
    }
  }
  return report
}

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '  -')
const pair = (s) => `${f2(s.p50)}/${f2(s.p95)}`.padStart(11)

if (process.argv[1]?.endsWith('bench-jewelry.mjs')) {
  const clips = loadClips(only)
  const all = {}
  for (const { id, fixture } of clips) all[id] = runJewelry(fixture)
  if (asJson) {
    console.log(JSON.stringify(all, null, 2))
  } else {
    console.log(`physics: ${realistic ? 'realistic' : 'stable'}     (p50/p95; shake + turn per camera frame, on-arm per 60 Hz render frame)`)
    console.log('clip              piece                 shake px   rim shake    turn deg   on-arm mm')
    for (const [id, r] of Object.entries(all)) {
      console.log(`${id.padEnd(17)} ${'(picture)'.padEnd(20)} ${pair(r.picture.shakePx)}`)
      console.log(`${''.padEnd(17)} ${'(arm)'.padEnd(20)} ${pair(r.arm.shakePx)}              ${pair(r.arm.turnDeg)}`)
      for (const [pid, p] of Object.entries(r.pieces)) {
        console.log(`${''.padEnd(17)} ${pid.padEnd(20)} ${pair(p.shakePx)} ${pair(p.rimShakePx)} ${pair(p.turnDeg)} ${pair(p.onArmMm)}`)
      }
    }
  }
}
