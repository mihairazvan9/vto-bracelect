/**
 * The premium scorecard: every quality goal, measured on the recorded clips,
 * in one table. Replays each clip through the live pipeline - observer,
 * tracker, fit, physics - exactly as VTOEngine runs it (camera frames at their
 * recorded timing, render frames at `--hz` in between, the pose held on the
 * frame being shown).
 *
 *   npm run scorecard                          all clips
 *   npm run scorecard -- still-0923-155621     some clips
 *   npm run scorecard -- --save base.json      keep the numbers
 *   npm run scorecard -- --compare base.json   show the change against them
 *   npm run scorecard -- --realistic           realistic physics mode
 *
 * TRACKING (per camera frame, while the jewellery is visible)
 *   roll     second difference of the roll about the forearm, deg: the twitch
 *            of the bracelet turning round the arm
 *   axis     second difference of the forearm direction, deg
 *   shake    second difference of a point 20 mm up the arm on screen, px
 *   pump     second difference of distance, % of it: size breathing
 *   lag      screen distance from the rendered wrist to this frame's measured
 *            wrist, px: how far smoothing trails the picture
 * PHYSICS (per piece, render frames)
 *   rim      second difference of a rim point on screen per camera frame, px
 *   jumps    render frames where the piece moves > 2 mm relative to the arm
 *            (after the first second), per minute
 *   rest     the piece's speed over the arm once the arm has been still for
 *            a second, mm/s p95: restlessness, not settling
 *   settle   after the arm stops moving, seconds until the piece is at rest
 *            (and stays so for 0.3 s), p50
 *   rate     the same clip rendered at 30 and 120 Hz instead of 60: largest
 *            difference in where the piece sits on the arm, mm (0 = the
 *            physics does not depend on the display's refresh rate)
 *   ms       physics cost per render frame
 * SIZE
 *   circ     the wrist circumference the clip ended on, and whether locked;
 *            across clips of the same person this should agree
 *
 * Numbers are p50/p95 unless noted.
 */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
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

const PIECES = ['bangle-classic-18k', 'cuff-wide-silver', 'tennis-brilliant', 'charm-heirloom']
const SHORT = { 'bangle-classic-18k': 'bangle', 'cuff-wide-silver': 'cuff', 'tennis-brilliant': 'tennis', 'charm-heirloom': 'charm' }
const JUMP_MM = 2
const WARM_S = 1
const STILL_MM_S = 50
const STILL_RAD_S = 0.45
const MOVING_MM_S = 250
const REST_MM_S = 3

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const realistic = flag('--realistic')
const savePath = option('--save')
const comparePath = option('--compare')
const hz = Number(option('--hz')) || 60
const optionValues = new Set([savePath, comparePath, option('--hz')].filter(Boolean))
const only = args.filter((a) => !a.startsWith('--') && !optionValues.has(a))

// ------------------------------------------------------------------ helpers

export const pct = (values, p) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]
}
export const p50 = (v) => pct(v, 0.5)
export const p95 = (v) => pct(v, 0.95)
const DEG = 180 / Math.PI

function vec2nd(a, b, c) {
  const pred = b.clone().multiplyScalar(2).sub(a)
  if (pred.lengthSq() < 1e-12) return 0
  return pred.normalize().angleTo(c) * DEG
}
function px2nd(a, b, c) {
  return Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y)
}
/** Roll reference: the dorsal axis with its component along `axis` removed. */
function flat(v, axis) {
  return v.clone().addScaledVector(axis, -v.dot(axis)).normalize()
}

// --------------------------------------------------------------- simulation

/**
 * Run one clip the way the live engine runs it: render ticks on a steady
 * clock (`renderHz`), each camera frame shown from the first tick after it
 * arrives, the pose held on the frame being shown, physics stepped by the
 * tick interval. Physics runs whenever the arm is tracked (as VTOEngine does),
 * not only once the jewellery has faded in.
 *
 * Returns, per CAMERA FRAME, the arm (`arm`) and each piece (`frames`) as
 * shown at that frame's first tick (null where nothing was shown) - these
 * line up across render rates - and each piece's per-TICK samples
 * (`samples`), for motion relative to the arm.
 */
export function simulate(fixture, { renderHz = 60, pieces = PIECES, real = realistic, configure } = {}) {
  const cam = new CameraModel({ fovYDeg: fixture.meta?.fovYDeg })
  cam.setResolution(fixture.videoWidth, fixture.videoHeight, false)
  const observer = new WristObserver(cam)
  const tracker = new WristTracker(cam)
  const sources = new LandmarkSourceBuilder()
  const fitSolver = new FitSolver()
  configure?.({ cam, observer, tracker })
  const instances = pieces.map((id) => {
    const asset = getBracelet(id)
    const rigid = asset.category === BraceletCategory.RIGID_BANGLE || asset.category === BraceletCategory.OPEN_CUFF
    return { id, asset, rigid: rigid ? new RigidSolver() : null, chain: rigid ? null : new XPBDChainSolver(), samples: [], frames: [], costMs: 0, solves: 0 }
  })
  const arm = []
  const renderDtMs = 1000 / renderHz
  const frameInv = new THREE.Matrix4()
  const frames = fixture.frames
  let t = 1000
  let tick = null
  let firstShown = null

  for (let n = 0; n < frames.length; n++) {
    t += frames[n].dtMs || 33
    if (tick === null) tick = t
    const next = t + (frames[n + 1]?.dtMs || frames[n].dtMs || 33)
    const result = handResult(frames[n])
    const source = result ? sources.build(result, cam) : null
    const obs = source ? observer.observe(source, maskPerception(fixture, frames[n]), t) : null
    if (obs) tracker.ingest(obs)
    const obsPx = obs ? { x: obs.creasePx.x, y: obs.creasePx.y } : null
    const rawAxis = obs ? obs.basis.y.clone() : null
    const rawDorsal = obs ? obs.basis.z.clone() : null

    // The ticks that show this frame: from the first at or after it arrives,
    // until the next one does.
    let armSample = null
    const firstOf = instances.map(() => null)
    for (let first = true; tick < next; tick += renderDtMs, first = false) {
      const twin = tracker.update(tick, renderDtMs / 1000, t)
      if (!twin.valid) {
        for (const inst of instances) inst.samples.push(null)
        continue
      }
      // Every frame the user sees the piece on - including weak-tracking ones,
      // which older builds drew at 65 % opacity - but not the fade-in.
      const shown = tracker.presence >= 0.6
      if (shown && firstShown === null) firstShown = tick
      if (first && shown) {
        armSample = {
          t: tick,
          axis: twin.forearmAxis.clone(),
          dorsal: twin.dorsalAxis.clone(),
          depth: -twin.center.z,
          px20: cam.project(twin.pointAt(20), { x: 0, y: 0 }),
          centrePx: cam.project(twin.center, { x: 0, y: 0 }),
          obsPx,
          rawAxis,
          rawDorsal,
          speed: tracker.velocity.length(),
          spin: tracker.omega.length(),
          circ: tracker.geometry.circumferenceMm,
          rawDepth: tracker.depthMeasurementMm,
        }
      }
      frameInv.copy(twin.frameMatrix()).invert()
      instances.forEach((inst, i) => {
        const fit = fitSolver.evaluate(inst.asset, twin, 0)
        const t0 = performance.now()
        if (inst.rigid) inst.rigid.solve(inst.asset, fit, twin, renderDtMs / 1000, { realistic: real })
        else inst.chain.solve(inst.asset, fit, twin, renderDtMs / 1000, [], { realistic: real })
        inst.costMs += performance.now() - t0
        inst.solves++
        const s = shown ? { t: tick, speed: tracker.velocity.length(), spin: tracker.omega.length(), ...samplePiece(inst, fit, frameInv, cam) } : null
        inst.samples.push(s)
        if (first) firstOf[i] = s
      })
    }
    arm.push(armSample)
    instances.forEach((inst, i) => inst.frames.push(firstOf[i]))
  }
  return {
    arm,
    pieces: instances,
    geometry: { circ: tracker.geometry.circumferenceMm, width: tracker.geometry.widthMm, depth: tracker.geometry.depthMm, locked: tracker.geometry.locked },
    firstShown,
  }
}

/**
 * Where the piece is on screen, and where it is ON THE ARM: in the frame its
 * solver simulates in, when it has one (the arm frame with the arm's twist
 * followed smoothly - closer to the real arm in the video than the tracked
 * frame, whose roll noise the jewellery deliberately does not copy), else in
 * the tracked arm frame.
 */
function samplePiece(inst, fit, frameInv, cam) {
  let centre
  let rim
  let onArm = null
  let onArmRim = null
  if (inst.rigid) {
    const r = inst.rigid
    centre = r.position.clone()
    rim = new THREE.Vector3(fit.ringA, 0, 0).applyQuaternion(r.quaternion).add(r.position)
    if (r.x && r.q) {
      onArm = r.x.clone()
      onArmRim = new THREE.Vector3(fit.ringA, 0, 0).applyQuaternion(r.q).add(r.x)
    }
  } else {
    const c = inst.chain
    centre = c.particles.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / c.particles.length)
    rim = c.particles[0].clone()
    if (c.sim?.length) {
      onArm = c.sim.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / c.sim.length)
      onArmRim = c.sim[0].clone()
    }
  }
  return {
    onArm: onArm ?? centre.clone().applyMatrix4(frameInv),
    onArmRim: onArmRim ?? rim.clone().applyMatrix4(frameInv),
    rimPx: cam.project(rim, { x: 0, y: 0 }),
  }
}

// ------------------------------------------------------------------ metrics

export function trackingMetrics(arm) {
  const roll = []
  const axis = []
  const shake = []
  const pump = []
  const lag = []
  const rollErr = []
  /** Signed roll of this frame's raw measurement relative to the output, deg. */
  const signed = new Array(arm.length).fill(NaN)
  /** Output distance relative to this frame's raw distance reading, %. */
  const signedDepth = new Array(arm.length).fill(NaN)
  const depthLag = []
  for (let i = 0; i < arm.length; i++) {
    const c = arm[i]
    if (!c) continue
    if (c.obsPx) lag.push(Math.hypot(c.centrePx.x - c.obsPx.x, c.centrePx.y - c.obsPx.y))
    if (c.rawDepth > 0) signedDepth[i] = Math.log(c.depth / c.rawDepth) * 100
    if (c.rawDorsal) {
      const a = flat(c.dorsal, c.axis)
      const b = flat(c.rawDorsal, c.axis)
      signed[i] = Math.atan2(c.axis.dot(a.clone().cross(b)), a.dot(b)) * DEG
    }
    const a = arm[i - 2]
    const b = arm[i - 1]
    if (!a || !b) continue
    axis.push(vec2nd(a.axis, b.axis, c.axis))
    roll.push(vec2nd(flat(a.dorsal, c.axis), flat(b.dorsal, c.axis), flat(c.dorsal, c.axis)))
    shake.push(px2nd(a.px20, b.px20, c.px20))
    pump.push((Math.abs(c.depth - 2 * b.depth + a.depth) / c.depth) * 100)
  }
  // Roll lag: the raw-minus-output difference averaged over a window centred
  // on each frame. Measurement noise averages out; a filter trailing a real
  // turn does not. Detector flips (> 60 deg off) are left out of the average.
  const K = 3
  for (let i = K; i < signed.length - K; i++) {
    let sum = 0
    let n = 0
    for (let j = i - K; j <= i + K; j++) {
      if (Number.isFinite(signed[j]) && Math.abs(signed[j]) < 60) {
        sum += signed[j]
        n++
      }
    }
    if (n >= K + 1 && Number.isFinite(signed[i])) rollErr.push(Math.abs(sum / n))
  }
  // Distance lag: the same windowed mean for the distance - noise averages
  // out, a filter trailing a real move toward or away from the camera does not.
  for (let i = K; i < signedDepth.length - K; i++) {
    let sum = 0
    let n = 0
    for (let j = i - K; j <= i + K; j++) {
      if (Number.isFinite(signedDepth[j])) {
        sum += signedDepth[j]
        n++
      }
    }
    if (n >= K + 1 && Number.isFinite(signedDepth[i])) depthLag.push(Math.abs(sum / n))
  }
  return { roll, axis, shake, pump, lag, rollErr, depthLag }
}

export function pieceMetrics(inst, firstShown) {
  const s = inst.samples
  const rim = []
  const firsts = inst.frames
  for (let i = 2; i < firsts.length; i++) {
    const [a, b, c] = [firsts[i - 2], firsts[i - 1], firsts[i]]
    if (a && b && c) rim.push(px2nd(a.rimPx, b.rimPx, c.rimPx))
  }
  let jumps = 0
  let shownS = 0
  const rest = []
  const settles = []
  let stillFor = 0
  let movingRecently = false
  let settleFrom = null
  let calmFor = 0
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]
    const b = s[i]
    if (!a || !b) {
      stillFor = 0
      settleFrom = null
      continue
    }
    const dt = (b.t - a.t) / 1000
    if (!(dt > 0)) continue
    const move = Math.max(b.onArm.distanceTo(a.onArm), b.onArmRim.distanceTo(a.onArmRim))
    const speed = move / dt
    if (b.t - firstShown > WARM_S * 1000) {
      shownS += dt
      if (move > JUMP_MM) jumps++
    }
    const still = b.speed < STILL_MM_S && b.spin < STILL_RAD_S
    if (b.speed > MOVING_MM_S || b.spin > 3) movingRecently = true
    stillFor = still ? stillFor + dt : 0
    // Restlessness: motion on a still arm once any settling has had a second.
    if (stillFor > 1) rest.push(speed)
    // Settling: from the arm coming to rest after real motion until the piece
    // has stayed at rest (< REST_MM_S) for 0.3 s.
    if (still && movingRecently && settleFrom === null) {
      settleFrom = b.t
      calmFor = 0
    }
    if (!still) settleFrom = null
    if (settleFrom !== null) {
      calmFor = speed < REST_MM_S ? calmFor + dt : 0
      if (calmFor >= 0.3) {
        settles.push((b.t - settleFrom) / 1000 - 0.3)
        settleFrom = null
        movingRecently = false
      }
    }
  }
  return {
    rim,
    jumpsPerMin: shownS > 0 ? (jumps / shownS) * 60 : 0,
    rest,
    settle: settles,
    ms: inst.solves ? inst.costMs / inst.solves : 0,
  }
}

/** How far the piece's arm-space position differs between two render rates, at camera frames. */
export function rateDeviation(a, b) {
  const fa = a.frames
  const fb = b.frames
  const n = Math.min(fa.length, fb.length)
  let worst = 0
  for (let i = 0; i < n; i++) {
    if (!fa[i] || !fb[i]) continue
    worst = Math.max(worst, fa[i].onArm.distanceTo(fb[i].onArm), fa[i].onArmRim.distanceTo(fb[i].onArmRim))
  }
  return worst
}

// --------------------------------------------------------------------- run

export function main() {

  const clips = loadClips(only)
  if (!clips.length) {
    console.log('No clips in fixtures/.')
    return
  }

  const report = { clips: {}, pooled: {} }
  const pool = { roll: [], axis: [], shake: [], pump: [], lag: [], rollErr: [], pieces: {} }
  for (const id of PIECES) pool.pieces[id] = { rim: [], rest: [], settle: [], jumps: [], rate: [], ms: [] }

  for (const { id, fixture } of clips) {
    const main = simulate(fixture, { renderHz: hz })
    const slow = simulate(fixture, { renderHz: 30 })
    const fast = simulate(fixture, { renderHz: 120 })
    const tm = trackingMetrics(main.arm)
    const clip = {
      scenario: fixture.meta?.scenario ?? id,
      fps: fixture.meta?.performance?.recordedFps ?? +(1000 / p50(fixture.frames.map((f) => f.dtMs))).toFixed(1),
      roll: [p50(tm.roll), p95(tm.roll)],
      axis: [p50(tm.axis), p95(tm.axis)],
      shake: [p50(tm.shake), p95(tm.shake)],
      pump: [p50(tm.pump), p95(tm.pump)],
      lag: [p50(tm.lag), p95(tm.lag)],
      rollErr: [p50(tm.rollErr), pct(tm.rollErr, 0.9)],
      circ: main.geometry.circ,
      locked: main.geometry.locked,
      pieces: {},
    }
    for (const k of ['roll', 'axis', 'shake', 'pump', 'lag', 'rollErr']) pool[k].push(...tm[k])
    main.pieces.forEach((inst, i) => {
      const pm = pieceMetrics(inst, main.firstShown ?? 0)
      const rate = Math.max(rateDeviation(inst, slow.pieces[i]), rateDeviation(inst, fast.pieces[i]))
      clip.pieces[inst.id] = {
        rim: [p50(pm.rim), p95(pm.rim)],
        jumpsPerMin: pm.jumpsPerMin,
        rest: p95(pm.rest),
        settle: p50(pm.settle),
        rate,
        ms: pm.ms,
      }
      const P = pool.pieces[inst.id]
      P.rim.push(...pm.rim)
      P.rest.push(...pm.rest)
      P.settle.push(...pm.settle)
      P.jumps.push(pm.jumpsPerMin)
      P.rate.push(rate)
      P.ms.push(pm.ms)
    })
    report.clips[id] = clip
  }

  const circs = Object.values(report.clips).map((c) => c.circ)
  const lockedCircs = Object.values(report.clips).filter((c) => c.locked).map((c) => c.circ)
  report.pooled = {
    roll: [p50(pool.roll), p95(pool.roll)],
    axis: [p50(pool.axis), p95(pool.axis)],
    shake: [p50(pool.shake), p95(pool.shake)],
    pump: [p50(pool.pump), p95(pool.pump)],
    lag: [p50(pool.lag), p95(pool.lag)],
    rollErr: [p50(pool.rollErr), pct(pool.rollErr, 0.9)],
    circ: { min: Math.min(...circs), max: Math.max(...circs), lockedMin: Math.min(...lockedCircs), lockedMax: Math.max(...lockedCircs) },
    pieces: Object.fromEntries(PIECES.map((id) => {
      const P = pool.pieces[id]
      return [id, {
        rim: [p50(P.rim), p95(P.rim)],
        jumpsPerMin: P.jumps.reduce((a, b) => a + b, 0) / Math.max(1, P.jumps.length),
        rest: p95(P.rest),
        settle: p50(P.settle),
        rate: Math.max(...P.rate),
        ms: P.ms.reduce((a, b) => a + b, 0) / Math.max(1, P.ms.length),
      }]
    })),
  }

  // ------------------------------------------------------------------ output

  const baseline = comparePath && fs.existsSync(comparePath) ? JSON.parse(fs.readFileSync(comparePath, 'utf8')) : null
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-')
  const pair = (v, d = 2) => `${f(v[0], d)}/${f(v[1], d)}`
  /** "now (was)" with an arrow when a baseline is given; lower is better for every metric here. */
  const cmp = (now, was, d = 2) => {
    const text = Array.isArray(now) ? pair(now, d) : f(now, d)
    if (was === undefined || was === null) return text
    const a = Array.isArray(now) ? now[1] : now
    const b = Array.isArray(was) ? was[1] : was
    if (!Number.isFinite(a) || !Number.isFinite(b)) return text
    const mark = Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.03) ? '=' : a < b ? 'v' : '^'
    return `${text} ${mark}${Array.isArray(was) ? f(was[1], d) : f(was, d)}`
  }

  console.log(`physics: ${realistic ? 'realistic' : 'stable'}, render ${hz} Hz${baseline ? `   (compared with ${comparePath}: v better, ^ worse, = same; p95 compared)` : ''}\n`)
  const W = baseline ? 20 : 14
  const cols = (c, b) => ['roll', 'axis', 'shake', 'pump'].map((k) => cmp(c[k], b?.[k]).padEnd(W)).join('') +
    cmp(c.lag, b?.lag, 1).padEnd(W) + cmp(c.rollErr, b?.rollErr, 1).padEnd(W)
  console.log('TRACKING'.padEnd(22) + 'fps   ' + ['roll deg', 'axis deg', 'shake px', 'pump %', 'lag px', 'roll lag (p90)'].map((h) => h.padEnd(W)).join('') + 'circ mm')
  for (const [id, c] of Object.entries(report.clips)) {
    const b = baseline?.clips?.[id]
    console.log(id.slice(0, 21).padEnd(22) + String(c.fps).padEnd(6) + cols(c, b) + `${f(c.circ, 0)}${c.locked ? ' L' : ''}`)
  }
  const P = report.pooled
  const B = baseline?.pooled
  console.log('ALL CLIPS'.padEnd(28) + cols(P, B) + `${f(P.circ.lockedMin, 0)}-${f(P.circ.lockedMax, 0)} locked`)

  console.log('\nPHYSICS (all clips)'.padEnd(23) + 'rim px            jumps/min     rest mm/s     settle s      rate mm       ms')
  for (const id of PIECES) {
    const p = P.pieces[id]
    const b = B?.pieces?.[id]
    console.log(
      ('  ' + SHORT[id]).padEnd(22) + cmp(p.rim, b?.rim).padEnd(18) + cmp(p.jumpsPerMin, b?.jumpsPerMin, 1).padEnd(14) +
      cmp(p.rest, b?.rest, 1).padEnd(14) + cmp(p.settle, b?.settle).padEnd(14) + cmp(p.rate, b?.rate).padEnd(14) + cmp(p.ms, b?.ms, 3),
    )
  }
  console.log('\nPHYSICS jumps/min per clip'.padEnd(23) + PIECES.map((id) => SHORT[id].padEnd(9)).join(''))
  for (const [id, c] of Object.entries(report.clips)) {
    console.log(id.slice(0, 21).padEnd(22) + PIECES.map((p) => f(c.pieces[p].jumpsPerMin, 1).padEnd(9)).join(''))
  }

  if (savePath) {
    fs.writeFileSync(savePath, JSON.stringify(report, null, 2))
    console.log(`\nsaved ${savePath}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
