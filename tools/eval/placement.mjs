/**
 * Where does the BRACELET end up? Runs the full app pipeline (observer +
 * tracker) on a clip with a given mask source and measures, every frame, the
 * sideways distance between the twin's centre at the bracelet station and the
 * reference arm's centreline - as a fraction of the reference half-width.
 * 0 = centred on the arm, 1 = on its edge, >1 = off the arm.
 *
 *   node placement.mjs [maskMethod=app_3] [clip ...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadEvalClips, bilinear } from './score.mjs'
import { CameraModel } from '../../src/vto/camera/CameraModel.js'
import { WristObserver } from '../../src/vto/wrist/WristObserver.js'
import { WristTracker } from '../../src/vto/wrist/WristTracker.js'
import { LandmarkSourceBuilder } from '../../src/vto/wrist/LandmarkSources.js'
import { ArmProfiler } from '../../src/vto/wrist/ArmProfiler.js'
import { FitSolver } from '../../src/vto/fit/FitSolver.js'
import { RigidSolver } from '../../src/vto/physics/RigidSolver.js'
import { getBracelet } from '../../src/vto/assets/catalog.js'
import * as THREE from 'three'

const method = process.argv[2] || 'app_3'
const only = process.argv.slice(3)
const OUT = path.join(import.meta.dirname, 'out')
const STATION = 2 // twin cross-section index: 18 mm up the forearm

function perceptionFor(clipId, index, W, H) {
  const file = path.join(OUT, method, clipId, `${index}.bin`)
  if (!fs.existsSync(file)) return { armMask: null, sampleMask: () => -1 }
  const data = fs.readFileSync(file)
  return {
    armMask: { data, width: W, height: H, version: index + 1 },
    sampleMask: (u, v) => bilinear(data, W, H, u * W, v * H),
  }
}

const gtProfiler = new ArmProfiler()
/** Reference centreline at the frame's scale: point + unit direction, frame px. */
function gtMidline(frame) {
  const g = frame.geom
  const mmPerPx = 85 / g.palmLen
  const r = gtProfiler.measure((x, y) => bilinear(frame.gt, frame.W, frame.H, x, y), g.wrist, g.ax, g.ay, mmPerPx, 26, { reachMm: 100 })
  if (!r) return null
  const o = { halfWidthMm: 0, offsetMm: 0 }
  if (!gtProfiler.sectionAt(25, o)) return null
  // The profiler's rows run along its final grid; its centre offsets are
  // relative to the line through the anchor along the fitted direction.
  const px = -r.dy
  const py = r.dx
  const along = 25 / mmPerPx
  return {
    x: g.wrist.x + r.dx * along + px * (o.offsetMm / mmPerPx),
    y: g.wrist.y + r.dy * along + py * (o.offsetMm / mmPerPx),
    dx: r.dx,
    dy: r.dy,
    half: o.halfWidthMm / mmPerPx,
  }
}

const rows = []
for (const clip of loadEvalClips(only.length ? only : null)) {
  const cam = new CameraModel()
  cam.setResolution(clip.fx.videoWidth, clip.fx.videoHeight, false)
  const k = clip.fx.analysisWidth / clip.fx.videoWidth // video px -> frame px
  const k0 = k
  const observer = new WristObserver(cam)
  if (process.env.REACH) observer.armReachMm = Number(process.env.REACH)
  const tracker = new WristTracker(cam)
  const sources = new LandmarkSourceBuilder()
  const byIndex = new Map(clip.frames.map((f) => [f.index, f]))
  const errs = []
  const axisErrs = []
  // The default bangle, solved every frame exactly as the engine does.
  const bangle = getBracelet('bangle-classic-18k')
  const fitSolver = new FitSolver()
  const rigid = new RigidSolver()
  const ringMoves = []
  // How much of the tube (s = 0..88 mm) the occluder keeps, emulating its
  // shader: a point survives where the mask says skin or inside the fitted
  // arm outline up to its reach.
  const keptLengths = []
  const keptSteps = []
  let lastKept = null
  const ringTurns = []
  let lastRingPx = null
  let lastRingAxis = null
  let lastWrist = null
  const sizeRatios = []
  const sizeSteps = []
  let lastRatio = null
  const renderSteps = []
  let lastRendered = null
  let t = 1000
  for (const fr of clip.fx.frames) {
    t += fr.dtMs || 33
    if (!fr.landmarks.some((p) => p.x || p.y)) continue
    const src = sources.build({ landmarks: [fr.landmarks], worldLandmarks: [fr.worldLandmarks], handedness: [[{ categoryName: fr.handedness.label, score: fr.handedness.score }]] }, cam)
    const obs = observer.observe(src, perceptionFor(clip.id, fr.index, clip.fx.analysisWidth, clip.fx.analysisHeight), t)
    if (obs) tracker.ingest(obs)
    const twin = tracker.update(t, 1 / 30, t)
    if (twin.valid) {
      // Ring motion RELATIVE TO THE ARM: how far the ring moves on screen
      // beyond what the wrist itself moved, and how much it turns beyond the
      // forearm's own turn. That residual is the "moving all the time".
      const fit = fitSolver.evaluate(bangle, twin)
      rigid.solve(bangle, fit, twin, 1 / 30)
      const rp = cam.project(rigid.position)
      const wp = cam.project(twin.creasePoint)
      const ringAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(rigid.quaternion)
      if (lastRingPx) {
        const dRing = { x: rp.x - lastRingPx.x, y: rp.y - lastRingPx.y }
        const dWrist = { x: wp.x - lastWrist.x, y: wp.y - lastWrist.y }
        ringMoves.push(Math.hypot(dRing.x - dWrist.x, dRing.y - dWrist.y) * k)
        const armTurn = lastRingAxis.userData.arm.angleTo(twin.forearmAxis)
        ringTurns.push(Math.abs(ringAxis.angleTo(lastRingAxis) - armTurn) * 57.2958)
      }
      lastRingPx = rp
      lastWrist = wp
      lastRingAxis = ringAxis
      lastRingAxis.userData = { arm: twin.forearmAxis.clone() }
    }
    if (twin.valid && obs) {
      const per = perceptionFor(clip.id, fr.index, clip.fx.analysisWidth, clip.fx.analysisHeight)
      const ov = obs.armOverlay
      let kept = 0
      for (let sv = 0; sv <= 88; sv += 4) {
        const q = cam.project(twin.pointAt(sv, new THREE.Vector3()))
        const m = per.sampleMask(q.x / cam.width, q.y / cam.height)
        let inside = false
        if (ov) {
          const dx = q.x - ov.x
          const dy = q.y - ov.y
          const sa = dx * ov.dx + dy * ov.dy
          const va = -dx * ov.dy + dy * ov.dx
          inside = sa >= -(ov.back ?? 0) && sa <= ov.reach && va >= ov.la + ov.lb * sa + 1 && va <= ov.ra + ov.rb * sa - 1
        }
        if (!ov || m >= 0.4 * 255 || inside) kept += 4
      }
      keptLengths.push(kept)
      if (lastKept !== null) keptSteps.push(Math.abs(kept - lastKept))
      lastKept = kept
    }
    const frame = byIndex.get(fr.index)
    if (!twin.valid || !frame) continue
    const mid = gtMidline(frame)
    if (!mid) continue
    const p = cam.project(twin.crossSections[STATION].center)
    const x = p.x * k
    const y = p.y * k
    const lateral = Math.abs((x - mid.x) * -mid.dy + (y - mid.y) * mid.dx)
    errs.push(lateral / Math.max(1, mid.half))
    // Rendered arm width on screen vs the real arm width: the twin's ring at
    // the station, sampled round its ellipse, projected, measured across the
    // reference arm direction. Ratio 1 = the rendered arm is the real size;
    // its frame-to-frame change is the "pulsing".
    {
      const sec = twin.crossSections[STATION]
      let lo = Infinity
      let hi = -Infinity
      for (let k = 0; k < 32; k++) {
        const t = (k / 32) * Math.PI * 2
        const q = sec.center.clone()
          .addScaledVector(twin.radialAxis, Math.cos(t) * sec.a)
          .addScaledVector(twin.dorsalAxis, Math.sin(t) * sec.b)
        const pr = cam.project(q)
        const across = (pr.x * k0 - mid.x) * -mid.dy + (pr.y * k0 - mid.y) * mid.dx
        lo = Math.min(lo, across)
        hi = Math.max(hi, across)
      }
      const ratio = (hi - lo) / (2 * Math.max(1, mid.half))
      sizeRatios.push(ratio)
      if (process.env.PER_FRAME === 'size') console.log(clip.id, fr.index, 'ratio', ratio.toFixed(2), 'rulerPx', (obs.armWidthPx * k0).toFixed(1), 'realPx', (2 * mid.half).toFixed(1), 'conf', obs.armWidthConfidence.toFixed(2), 'geomW', tracker.geometry.widthMm.toFixed(1), 'geomD', tracker.geometry.depthMm.toFixed(1), 'roll', (obs.rollTheta * 57.3).toFixed(0))
      if (lastRatio !== null) sizeSteps.push(Math.abs(Math.log(ratio / lastRatio)) * 100)
      const rendered = hi - lo
      if (process.env.PER_FRAME === 'scale') {
        const g = tracker.geometry
        console.log(clip.id, fr.index, 'renderedPx', rendered.toFixed(1), 'depth', (-twin.center.z).toFixed(0), 'w', g.widthMm.toFixed(1), 'd', g.depthMm.toFixed(1), 'locked', g.locked, 'sec.a', sec.a.toFixed(1), 'sec.b', sec.b.toFixed(1), 'ruler', (obs.armWidthPx * k0).toFixed(1), 'conf', obs.armWidthConfidence.toFixed(2))
      }
      if (lastRendered !== null) renderSteps.push(Math.abs(Math.log(rendered / lastRendered)) * 100)
      lastRendered = rendered
      lastRatio = ratio
    }
    // Tracked forearm direction on screen vs the reference arm direction.
    const a0 = cam.project(twin.crossSections[0].center)
    const a1 = cam.project(twin.crossSections[5].center)
    const len = Math.hypot(a1.x - a0.x, a1.y - a0.y)
    if (len > 1) {
      const cos = Math.abs(((a1.x - a0.x) * mid.dx + (a1.y - a0.y) * mid.dy) / len)
      axisErrs.push((Math.acos(Math.min(1, cos)) * 180) / Math.PI)
    }
    if (process.env.PER_FRAME) {
      const ang = (dx, dy) => { const l = Math.hypot(dx, dy); return l > 1e-6 ? (Math.acos(Math.min(1, Math.abs((dx * mid.dx + dy * mid.dy) / l))) * 180) / Math.PI : NaN }
      const sil = observer.armProfile ? ang(observer.armProfile.dx, observer.armProfile.dy) : NaN
      const c0 = cam.project(obs.creasePoint)
      const c1 = cam.project(obs.creasePoint.clone().addScaledVector(obs.basis.y, 40))
      const raw = ang(c1.x - c0.x, c1.y - c0.y)
      const t0 = cam.project(twin.creasePoint)
      const t1 = cam.project(twin.creasePoint.clone().addScaledVector(twin.forearmAxis, 40))
      const tw = ang(t1.x - t0.x, t1.y - t0.y)
      if (process.env.PER_FRAME === 'offsets') console.log('   centre', tracker.centreOffset.toFixed(1), '| measured', obs.profile.map((e) => (e.measured ? e.offsetMm.toFixed(1) : '-')).join(' '), '| lateral', (lateral / Math.max(1, mid.half)).toFixed(2))
      console.log(clip.id, fr.index, 'sil', sil.toFixed(1), 'rawObs', raw.toFixed(1), 'twinAxis', tw.toFixed(1), 'silUsed', obs.forearmFromSilhouette, 'conf', obs.silhouetteConfidence.toFixed(2), 'carry', obs.armMotion.toFixed(2))
    }
  }
  errs.sort((a, b) => a - b)
  const at = (q) => errs[Math.min(errs.length - 1, Math.floor(q * errs.length))]
  const off = errs.filter((e) => e > 1).length
  keptLengths.sort((a, b) => a - b)
  keptSteps.sort((a, b) => a - b)
  const kl = (q) => keptLengths[Math.min(keptLengths.length - 1, Math.floor(q * keptLengths.length))]
  const ks = (q) => keptSteps[Math.min(keptSteps.length - 1, Math.floor(q * keptSteps.length))]
  ringMoves.sort((a, b) => a - b)
  ringTurns.sort((a, b) => a - b)
  const rm = (q) => ringMoves[Math.min(ringMoves.length - 1, Math.floor(q * ringMoves.length))]
  const rt = (q) => ringTurns[Math.min(ringTurns.length - 1, Math.floor(q * ringTurns.length))]
  axisErrs.sort((a, b) => a - b)
  sizeRatios.sort((a, b) => a - b)
  sizeSteps.sort((a, b) => a - b)
  const sr = (q) => sizeRatios[Math.min(sizeRatios.length - 1, Math.floor(q * sizeRatios.length))]
  const ss = (q) => sizeSteps[Math.min(sizeSteps.length - 1, Math.floor(q * sizeSteps.length))]
  renderSteps.sort((a, b) => a - b)
  const rs = (q) => renderSteps[Math.min(renderSteps.length - 1, Math.floor(q * renderSteps.length))]
  const ax = (q) => axisErrs[Math.min(axisErrs.length - 1, Math.floor(q * axisErrs.length))]
  rows.push(`${clip.id.padEnd(17)} n=${String(errs.length).padStart(3)}  lateral/halfwidth p50 ${at(0.5).toFixed(2)}  p90 ${at(0.9).toFixed(2)}  off-arm ${((100 * off) / errs.length).toFixed(0)}%   axis p50 ${ax(0.5).toFixed(1)}deg p90 ${ax(0.9).toFixed(1)}deg
${''.padEnd(22)}rendered/real width p10 ${sr(0.1).toFixed(2)} p50 ${sr(0.5).toFixed(2)} p90 ${sr(0.9).toFixed(2)}   size change per frame p50 ${ss(0.5).toFixed(1)}% p90 ${ss(0.9).toFixed(1)}%   rendered-only p50 ${rs(0.5).toFixed(1)}% p90 ${rs(0.9).toFixed(1)}%
${''.padEnd(22)}bangle vs arm per frame: moves p50 ${rm(0.5).toFixed(2)} px p90 ${rm(0.9).toFixed(2)} px   turns p50 ${rt(0.5).toFixed(2)}deg p90 ${rt(0.9).toFixed(2)}deg
${''.padEnd(22)}occluder length kept (of 88 mm): p10 ${kl(0.1)} p50 ${kl(0.5)} min ${keptLengths[0]}   change per frame p90 ${ks(0.9)} mm max ${keptSteps.at(-1)} mm`)
}
console.log(`bracelet placement vs reference arm centreline (${method})`)
rows.forEach((r) => console.log(r))
