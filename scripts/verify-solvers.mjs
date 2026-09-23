/**
 * Headless verification of the parts of the engine that do not need a camera:
 * the geometry fit, the sizing maths and the physics solvers.
 *
 * Run with `npm run verify`. These are the assertions that catch a regression
 * in the numbers, which is exactly where a VTO engine quietly goes wrong.
 */
import * as THREE from 'three'
import {
  fitEllipseFromSilhouettes,
  ellipseCircumference,
  ellipseFromCircumference,
  orthonormalBasis,
  slerpSafe,
  angularVelocity,
} from '../src/vto/core/mathUtils.js'
import { WristDigitalTwin } from '../src/vto/wrist/WristDigitalTwin.js'
import { WristTracker } from '../src/vto/wrist/WristTracker.js'
import { FitSolver, FitVerdict } from '../src/vto/fit/FitSolver.js'
import { RigidSolver } from '../src/vto/physics/RigidSolver.js'
import { WALL_NEAR_MM, WALL_FAR_MM } from '../src/vto/physics/walls.js'
import { GeometrySolver } from '../src/vto/wrist/GeometrySolver.js'
import { XPBDChainSolver } from '../src/vto/physics/XPBDChainSolver.js'
import { CATALOG, getBracelet } from '../src/vto/assets/catalog.js'
import { WristObserver } from '../src/vto/wrist/WristObserver.js'
import { CameraModel } from '../src/vto/camera/CameraModel.js'
import { LandmarkSourceBuilder } from '../src/vto/wrist/LandmarkSources.js'
import { PerceptionSystem } from '../src/vto/perception/PerceptionSystem.js'
import { MaskRefiner } from '../src/vto/perception/MaskRefiner.js'
import { OneEuroQuat } from '../src/vto/core/OneEuroFilter.js'
import { ArmProfiler } from '../src/vto/wrist/ArmProfiler.js'
import { WristOccluder } from '../src/vto/render/WristOccluder.js'
import { TwistGate, SpikeGate } from '../src/vto/wrist/PoseGates.js'
import { TrackingStateMachine } from '../src/vto/core/TrackingState.js'

let failures = 0
function check(name, condition, detail = '') {
  const ok = !!condition
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`)
}
function close(a, b, tol) {
  return Math.abs(a - b) <= tol
}

// --------------------------------------------------------------- ellipse fit
{
  const A = 27
  const B = 19
  const samples = []
  for (let i = 0; i < 12; i++) {
    const theta = (i / 11) * (Math.PI / 2)
    const r = Math.sqrt(A * A * Math.cos(theta) ** 2 + B * B * Math.sin(theta) ** 2)
    samples.push({ theta, radius: r, weight: 1 })
  }
  const fit = fitEllipseFromSilhouettes(samples)
  check('ellipse fit recovers width', close(fit.a, A, 0.05), `got ${fit.a.toFixed(2)} want ${A}`)
  check('ellipse fit recovers depth', close(fit.b, B, 0.05), `got ${fit.b.toFixed(2)} want ${B}`)
  check('ellipse fit residual is tiny', fit.residual < 1e-6, fit.residual.toExponential(1))

  // Front-on only: width and depth are genuinely not separable and the solver
  // must refuse rather than invent a depth.
  const single = Array.from({ length: 12 }, () => ({ theta: 0.02, radius: A, weight: 1 }))
  check('ellipse fit rejects single-view data', fitEllipseFromSilhouettes(single) === null)
}

// ------------------------------------------------------------ circumference
{
  const c = ellipseCircumference(27, 19)
  check('circumference is plausible', c > 140 && c < 155, `${c.toFixed(1)} mm`)
  const back = ellipseFromCircumference(c, 27 / 19)
  check('circumference round-trips to semi-axes', close(back.a, 27, 0.01) && close(back.b, 19, 0.01))
}

// ------------------------------------------------------------------- basis
{
  const basis = orthonormalBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0.3, 0))
  check('basis is orthonormal', close(basis.x.dot(basis.y), 0, 1e-6) && close(basis.x.length(), 1, 1e-6))
  check('basis is right-handed', close(basis.x.clone().cross(basis.y).dot(basis.z), 1, 1e-6))
}

// -------------------------------------------------- orientation interpolation
{
  const a = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0)
  const b = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2)

  // The whole point of a slerp is that it MOVES. Returning `from` unchanged
  // freezes the wrist at whatever the first frame produced.
  const mid = slerpSafe(a, b, 0.5, new THREE.Quaternion())
  check('slerp actually moves toward the target', mid.angleTo(a) > 0.1, `moved ${mid.angleTo(a).toFixed(3)} rad`)
  check('slerp lands between the endpoints', close(mid.angleTo(a), mid.angleTo(b), 1e-5))
  check('slerp at t=1 reaches the target', slerpSafe(a, b, 1, new THREE.Quaternion()).angleTo(b) < 1e-6)
  check('slerp at t=0 stays put', slerpSafe(a, b, 0, new THREE.Quaternion()).angleTo(a) < 1e-6)

  // Repeated small steps must converge, which is how the tracker is used.
  const running = a.clone()
  for (let i = 0; i < 40; i++) slerpSafe(running, b, 0.3, running)
  check('repeated slerp converges on the target', running.angleTo(b) < 1e-3, `${running.angleTo(b).toExponential(1)} rad left`)

  // Shortest arc: a target on the far hemisphere must not take the long way.
  const flipped = b.clone().set(-b.x, -b.y, -b.z, -b.w)
  const viaFlipped = slerpSafe(a, flipped, 0.5, new THREE.Quaternion())
  check('slerp takes the shortest arc', close(viaFlipped.angleTo(mid), 0, 1e-5))

  // Angular velocity must be non-zero for a real rotation, or prediction and
  // the adaptive smoothing both silently stop working.
  const omega = angularVelocity(a, b, 0.1, new THREE.Vector3())
  check('angular velocity is non-zero for a real rotation', omega.length() > 1, `${omega.length().toFixed(2)} rad/s`)
  check('angular velocity is zero for no rotation', angularVelocity(a, a.clone(), 0.1, new THREE.Vector3()).length() < 1e-6)
}

// ------------------------------------------------ tracker follows rotation
{
  // This is the end-to-end version of the slerp check: drive the tracker with a
  // wrist rolling about its own forearm axis and confirm the twin's axes
  // actually follow. A frozen orientation looks exactly like a bracelet that
  // never turns, which is not something the unit tests above would show.
  const cam = new CameraModel({ fovYDeg: 60 })
  cam.setResolution(1280, 720, true)

  const FOREARM_DIR = new THREE.Vector3(0, -1, 0)

  function rollBasis(theta) {
    const radial = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta))
    const dorsal = new THREE.Vector3().crossVectors(radial, FOREARM_DIR).normalize()
    return { x: radial, y: FOREARM_DIR.clone(), z: dorsal }
  }

  function makeObservation(theta, timestamp) {
    const basis = rollBasis(theta)
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(basis.x, basis.y, basis.z),
    )
    return {
      timestamp,
      origin: 'hand',
      handedness: 'Right',
      mmPerPx: 0.35,
      depthMm: 450,
      handBreadthMm: 82,
      creasePoint: new THREE.Vector3(0, 0, -450),
      creasePx: { x: 640, y: 360 },
      basis,
      quaternion,
      rollTheta: Math.abs(theta) % (Math.PI / 2),
      dorsalAgreement: 0.9,
      reprojectionPx: 1.2,
      profile: [0, 9, 18, 28, 40, 54, 70, 88].map((s) => ({
        s,
        halfWidthMm: 26 * (1 + s * 0.0022),
        offsetMm: 0,
        measured: true,
        confidence: 0.9,
      })),
      sleeveLimitMm: Infinity,
      maskAvailable: true,
      poseConfidence: 0.9,
      landmarks3D: [],
      landmarkCount: 0,
      key: { wrist: 0, index: 5, pinky: 17, thumb: 1 },
    }
  }

  const tracker = new WristTracker(cam)
  let t = 1000
  tracker.ingest(makeObservation(0, t))
  const twin0 = tracker.update(t, 1 / 30)
  const startDorsal = twin0.dorsalAxis.clone()

  // One step of real rotation must move the twin at all.
  t += 33
  tracker.ingest(makeObservation(0.3, t))
  const moved = tracker.update(t, 1 / 30).dorsalAxis.clone()
  const step = THREE.MathUtils.radToDeg(startDorsal.angleTo(moved))
  check('tracker orientation responds to a new observation', step > 1, `moved ${step.toFixed(1)}° in one step`)

  // And it must converge on a sustained rotation rather than lagging forever.
  const TARGET = Math.PI / 3 // 60 degrees of roll
  for (let i = 0; i < 60; i++) {
    t += 33
    tracker.ingest(makeObservation(TARGET, t))
    tracker.update(t, 1 / 30)
  }
  const twin = tracker.update(t, 1 / 30)
  const expected = rollBasis(TARGET)
  const dorsalErr = THREE.MathUtils.radToDeg(twin.dorsalAxis.angleTo(expected.z))
  const radialErr = THREE.MathUtils.radToDeg(twin.radialAxis.angleTo(expected.x))
  check('tracker converges on a rolled wrist (dorsal)', dorsalErr < 2, `${dorsalErr.toFixed(2)}°`)
  check('tracker converges on a rolled wrist (radial)', radialErr < 2, `${radialErr.toFixed(2)}°`)
  check(
    'the twin really did rotate from where it started',
    THREE.MathUtils.radToDeg(twin.dorsalAxis.angleTo(startDorsal)) > 50,
    `${THREE.MathUtils.radToDeg(twin.dorsalAxis.angleTo(startDorsal)).toFixed(1)}° total`,
  )

  // Angular velocity has to be live, or prediction between detections is dead.
  const spinning = new WristTracker(cam)
  let t2 = 1000
  for (let i = 0; i < 12; i++) {
    spinning.ingest(makeObservation(i * 0.12, t2))
    spinning.update(t2, 1 / 30)
    t2 += 33
  }
  check('tracker reports live angular velocity', spinning.omega.length() > 0.2, `${spinning.omega.length().toFixed(2)} rad/s`)
}

// ------------------------------------------------------ twin + fit + physics
// A realistically held arm: roughly horizontal, tilted slightly toward the
// camera. A straight-down forearm is a degenerate case for gravity (see the
// dedicated check below) and makes a poor default fixture.
const FOREARM = new THREE.Vector3(-0.94, -0.22, -0.26).normalize()

function makeTwin(widthMm = 52, depthMm = 38, forearm = FOREARM) {
  const twin = new WristDigitalTwin(8)
  twin.valid = true
  twin.shapeLocked = true
  twin.wristWidthMm = widthMm
  twin.wristDepthMm = depthMm
  twin.circumferenceMm = ellipseCircumference(widthMm / 2, depthMm / 2)
  twin.handBreadthMm = 82
  twin.center.set(0, 0, -450)
  twin.creasePoint.copy(twin.center)
  const basis = orthonormalBasis(forearm, new THREE.Vector3(0, 1, 0))
  twin.radialAxis.copy(basis.x)
  twin.forearmAxis.copy(basis.y)
  twin.dorsalAxis.copy(basis.z)
  twin.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(twin.radialAxis, twin.forearmAxis, twin.dorsalAxis),
  )
  const S = [0, 9, 18, 28, 40, 54, 70, 88]
  S.forEach((s, i) => {
    const sec = twin.crossSections[i]
    const taper = 1 + s * 0.0022
    sec.s = s
    sec.a = (widthMm / 2) * taper
    sec.b = (depthMm / 2) * taper
    sec.center.copy(twin.creasePoint).addScaledVector(twin.forearmAxis, s)
  })
  twin.poseConfidence = 0.9
  twin.geometryConfidence = 0.85
  twin.sizingConfidence = 0.68
  return twin
}

const solver = new FitSolver()

{
  const twin = makeTwin()
  const wrist = twin.circumferenceMm
  const bangle = getBracelet('bangle-classic-18k')
  const fit = solver.evaluate(bangle, twin)

  check(
    'bracelet keeps its manufactured size',
    fit.braceletCircumferenceMm === bangle.innerCircumferenceMm,
    `${fit.braceletCircumferenceMm} mm`,
  )
  check('slack equals piece minus wrist', close(fit.slackMm, bangle.innerCircumferenceMm - fit.wristCircumferenceMm, 0.01))
  check('wrist measurement is used, not the bracelet', fit.wristCircumferenceMm >= wrist - 0.01)
  check('loose bangle rests further up the forearm', fit.restingOffsetMm > bangle.fit.offsetRangeMm[0], `${fit.restingOffsetMm.toFixed(1)} mm`)

  // A small wrist with a large bangle must be reported loose, not auto-fitted.
  const small = makeTwin(44, 32)
  const looseFit = solver.evaluate(bangle, small)
  check(
    'oversized piece on a small wrist reads loose',
    [FitVerdict.LOOSE, FitVerdict.TOO_LOOSE].includes(looseFit.verdict),
    `${looseFit.verdict}, slack ${looseFit.slackMm.toFixed(0)} mm`,
  )

  // A rigid bangle that cannot clear the hand must say so.
  const tiny = getBracelet('bangle-slim-rose')
  const bigHand = makeTwin(50, 36)
  bigHand.handBreadthMm = 95
  const blocked = solver.evaluate(tiny, bigHand)
  check('rigid bangle that cannot pass the hand is flagged', blocked.verdict === FitVerdict.WILL_NOT_PASS_HAND, blocked.verdict)

  check('size recommendation exceeds the wrist', looseFit.recommendedCircumferenceMm > small.circumferenceMm)
}

// ------------------------------------------------------------- rigid solver
{
  const twin = makeTwin()
  const bangle = getBracelet('bangle-classic-18k')
  const fit = solver.evaluate(bangle, twin)
  const rigid = new RigidSolver()
  for (let i = 0; i < 90; i++) rigid.solve(bangle, fit, twin, 1 / 60, { realistic: true })

  check('rigid solver produces a finite pose', Number.isFinite(rigid.position.x) && Number.isFinite(rigid.position.z))
  // It now also slides a little up the (wider) arm, so it drops a little less.
  check('loose bangle drops under gravity', rigid.dropMm > 0.3, `${rigid.dropMm.toFixed(2)} mm`)
  const section = twin.sectionAt(fit.restingOffsetMm)
  check(
    'drop never exceeds the available slack',
    rigid.dropMm <= fit.ringA - section.a + 0.51,
    `drop ${rigid.dropMm.toFixed(2)} vs slack ${(fit.ringA - section.a).toFixed(2)}`,
  )

  // A snug piece should barely move at all.
  const snugTwin = makeTwin(56, 42)
  const snugFit = solver.evaluate(bangle, snugTwin)
  const snugSolver = new RigidSolver()
  for (let i = 0; i < 90; i++) snugSolver.solve(bangle, snugFit, snugTwin, 1 / 60, { realistic: true })
  check('snug bangle barely drops', snugSolver.dropMm < rigid.dropMm, `${snugSolver.dropMm.toFixed(2)} mm`)

  // Degenerate but physically correct: with the forearm hanging straight down,
  // gravity runs along the ring axis, so the piece slides rather than drops.
  const vertical = makeTwin(52, 38, new THREE.Vector3(0, -1, 0))
  const verticalFit = solver.evaluate(bangle, vertical)
  const verticalSolver = new RigidSolver()
  for (let i = 0; i < 90; i++) verticalSolver.solve(bangle, verticalFit, vertical, 1 / 60, { realistic: true })
  check('vertical forearm produces no sideways drop', verticalSolver.dropMm < 0.01, `${verticalSolver.dropMm.toFixed(3)} mm`)

  // The reported bug: hand raised, forearm pointing straight down, and the
  // loose ring tipped hard to an arbitrary side - the tilt axis
  // (forearm x gravity) has no direction there. A ring round a vertical arm
  // hangs level; on a sloped arm it tips, but subtly.
  const upright = makeTwin(52, 38, new THREE.Vector3(0.02, -1, 0.01))
  const uprightFit = solver.evaluate(bangle, upright)
  const uprightSolver = new RigidSolver()
  for (let i = 0; i < 90; i++) uprightSolver.solve(bangle, uprightFit, upright, 1 / 60, { realistic: true })
  const uprightTilt = THREE.MathUtils.radToDeg(Math.abs(uprightSolver.tiltRad))
  check('a loose ring on a vertical arm hangs level', uprightTilt < 1, `${uprightTilt.toFixed(2)} deg`)
  const sloped = makeTwin(52, 38, new THREE.Vector3(0.7, -0.7, 0.1))
  const slopedFit = solver.evaluate(bangle, sloped)
  const slopedSolver = new RigidSolver()
  for (let i = 0; i < 90; i++) slopedSolver.solve(bangle, slopedFit, sloped, 1 / 60, { realistic: true })
  const slopedTilt = THREE.MathUtils.radToDeg(Math.abs(slopedSolver.tiltRad))
  check('...and tips only subtly on a sloped arm', slopedTilt > 0.5 && slopedTilt <= 8.01, `${slopedTilt.toFixed(2)} deg`)
}

// -------------------------------------------------------------- XPBD solver
for (const id of ['tennis-brilliant', 'chain-rope-14k', 'charm-heirloom']) {
  const asset = getBracelet(id)
  const twin = makeTwin()
  const fit = solver.evaluate(asset, twin)
  const chain = new XPBDChainSolver()
  for (let i = 0; i < 180; i++) chain.solve(asset, fit, twin, 1 / 60)

  const finite = chain.particles.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
  check(`${id}: simulation stays finite`, finite)

  // Link spacing must hold: a chain that stretches is a chain that looks wrong.
  let maxErr = 0
  for (let i = 0; i < chain.particles.length; i++) {
    const d = chain.particles[i].distanceTo(chain.particles[(i + 1) % chain.particles.length])
    maxErr = Math.max(maxErr, Math.abs(d - chain.linkLength) / chain.linkLength)
  }
  check(`${id}: links keep their length`, maxErr < 0.2, `worst ${(maxErr * 100).toFixed(1)}%`)

  // Nothing may end up inside the arm.
  let deepest = 0
  const sec = { a: 0, b: 0 }
  for (const p of chain.particles) {
    const local = p.clone().sub(twin.creasePoint)
    const s = Math.max(0, Math.min(120, local.dot(twin.forearmAxis)))
    twin.sectionAt(s, sec)
    const c = twin.pointAt(s, new THREE.Vector3())
    const rel = p.clone().sub(c)
    const u = rel.dot(twin.radialAxis)
    const v = rel.dot(twin.dorsalAxis)
    const f = (u * u) / (sec.a * sec.a) + (v * v) / (sec.b * sec.b)
    deepest = Math.max(deepest, Math.max(0, 1 - f))
  }
  check(`${id}: no links penetrate the wrist`, deepest < 0.06, `worst penetration factor ${deepest.toFixed(3)}`)

  // Gravity must actually do something: the loop should hang below its centre.
  const centre = twin.pointAt(fit.restingOffsetMm, new THREE.Vector3())
  const meanY = chain.particles.reduce((a, p) => a + p.y, 0) / chain.particles.length
  check(`${id}: the loop hangs under gravity`, meanY < centre.y + 0.5, `mean y offset ${(meanY - centre.y).toFixed(2)} mm`)

  if (asset.charms.length) {
    const hangingBelowAnchor = chain.charms.every((c) => c.position.y < chain.particles[c.index].y + 1)
    check(`${id}: charms hang downward`, hangingBelowAnchor)
  }
}

// ------------------------------------------------- observer: 2D pos / 3D rot
{
  // A canonical right hand in its own frame, millimetres.
  // +Y toward the fingers, +X toward the pinky, +Z out the back of the hand.
  const CANONICAL = {
    0: [0, 0, 0],       // wrist
    1: [-18, 18, -8],   // thumb CMC: radial and palmar, which is what fixes the
    2: [-30, 40, -12],  //            dorsal direction without a handedness label
    5: [-25, 85, 0],    // index MCP
    9: [-8, 90, 0],     // middle MCP
    13: [9, 87, 0],     // ring MCP
    17: [26, 78, 0],    // pinky MCP
  }

  function syntheticHand(position, euler, mcpOverrides = null) {
    const canonical = mcpOverrides ? { ...CANONICAL, ...mcpOverrides } : CANONICAL
    return buildHand(position, euler, canonical)
  }

  function buildHand(position, euler, CANONICAL) {
    const rot = new THREE.Matrix4().makeRotationFromEuler(euler)
    const points = []
    for (let i = 0; i < 21; i++) {
      const base = CANONICAL[i] ?? CANONICAL[Math.min(17, 5 + (i % 4) * 4)]
      const p = new THREE.Vector3(...base)
      // Fingertips: extend past the metacarpal heads so all 21 exist.
      if (!CANONICAL[i]) p.y += 30
      points.push(p.applyMatrix4(rot).add(position))
    }
    const centroid = points
      .reduce((a, p) => a.add(p), new THREE.Vector3())
      .multiplyScalar(1 / points.length)

    const cam = new CameraModel({ fovYDeg: 60 })
    cam.setResolution(1280, 720, false)

    const landmarks = points.map((p) => {
      const px = cam.project(p, { x: 0, y: 0 })
      return { x: px.x / cam.width, y: px.y / cam.height, z: 0 }
    })
    // MediaPipe world-landmark convention: metres, hand-centred, +y down, +z away.
    const worldLandmarks = points.map((p) => ({
      x: (p.x - centroid.x) / 1000,
      y: -(p.y - centroid.y) / 1000,
      z: -(p.z - centroid.z) / 1000,
    }))

    return {
      cam,
      truth: points,
      rot,
      result: {
        landmarks: [landmarks],
        worldLandmarks: [worldLandmarks],
        handedness: [[{ categoryName: 'Right', score: 0.99 }]],
      },
    }
  }

  const noPerception = { armMask: null, sampleMask: () => -1 }
  const truePos = new THREE.Vector3(40, -25, -470)
  const euler = new THREE.Euler(0.42, -0.3, 0.18)
  const hand = syntheticHand(truePos, euler)
  const observer = new WristObserver(hand.cam)
  const sources = new LandmarkSourceBuilder()
  // A few frames, as in use: the metric scale is locked from well-measured
  // frames, not trusted from the first one.
  let obs = null
  for (let i = 0; i < 6; i++) obs = observer.observe(sources.build(hand.result, hand.cam), noPerception, 1000 + i * 33)

  check('observer produces an observation', obs !== null)

  // Position: the wrist landmark, recovered from the 2D image landmarks.
  const posErr = obs.creasePoint.distanceTo(hand.truth[0])
  check('position is recovered from the 2D landmarks', posErr < 1.5, `${posErr.toFixed(2)} mm error`)

  // Rotation: the anatomical frame, recovered from the 3D world landmarks.
  const expectX = new THREE.Vector3(-1, 0, 0).applyMatrix4(hand.rot) // radial = -X local
  const expectY = new THREE.Vector3(0, -1, 0).applyMatrix4(hand.rot) // forearm = -Y local
  const expectZ = new THREE.Vector3(0, 0, 1).applyMatrix4(hand.rot) // dorsal = +Z local
  const angle = (a, b) => THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(a.dot(b)))))
  check('forearm axis is recovered from the 3D landmarks', angle(obs.basis.y, expectY) < 12, `${angle(obs.basis.y, expectY).toFixed(1)}°`)
  check('dorsal axis points out the back of the hand', obs.basis.z.dot(expectZ) > 0.85, `dot ${obs.basis.z.dot(expectZ).toFixed(3)}`)
  check('radial axis points toward the thumb', obs.basis.x.dot(expectX) > 0.85, `dot ${obs.basis.x.dot(expectX).toFixed(3)}`)

  // The dorsal sign must come from anatomy, not from the handedness string.
  // Mislabelling the hand must not flip the bracelet.
  const mislabelled = syntheticHand(truePos, euler)
  mislabelled.result.handedness = [[{ categoryName: 'Left', score: 0.99 }]]
  const misObs = new WristObserver(mislabelled.cam).observe(new LandmarkSourceBuilder().build(mislabelled.result, mislabelled.cam), noPerception, 1000)
  check(
    'a mislabelled hand does not flip the dorsal axis',
    misObs.basis.z.dot(obs.basis.z) > 0.999,
    `dot ${misObs.basis.z.dot(obs.basis.z).toFixed(4)}`,
  )

  // Mirroring reverses the chirality of the landmark set, so the cross product
  // that builds the dorsal axis comes out backwards. The thumb test has to
  // catch that and flip it back, or every selfie-camera user sees the bracelet
  // inside out.
  const mirrored = syntheticHand(truePos, euler)
  mirrored.cam.setResolution(1280, 720, true)
  const mirObs = new WristObserver(mirrored.cam).observe(new LandmarkSourceBuilder().build(mirrored.result, mirrored.cam), noPerception, 1000)
  const mirroredExpectZ = new THREE.Vector3(-expectZ.x, expectZ.y, expectZ.z)
  check(
    'mirroring keeps the dorsal axis out the back of the hand',
    mirObs.basis.z.dot(mirroredExpectZ) > 0.85,
    `dot ${mirObs.basis.z.dot(mirroredExpectZ).toFixed(3)}`,
  )
  check(
    'mirroring keeps the basis right-handed',
    close(mirObs.basis.x.clone().cross(mirObs.basis.y).dot(mirObs.basis.z), 1, 1e-5),
  )

  // Scale must be recovered independently of the assumed focal length: this is
  // why sizing does not depend on knowing the camera's true field of view.
  const wide = syntheticHand(truePos, euler)
  wide.cam.fovYDeg = 45
  const wideObs = new WristObserver(wide.cam).observe(new LandmarkSourceBuilder().build(wide.result, wide.cam), noPerception, 1000)
  // Sizing is a pixel span times mm-per-pixel, so the focal length cancels to
  // first order. What is left is genuine perspective: the span runs between
  // points at different depths, and how much that distorts depends on the FOV.
  // A couple of percent across a 45-60 degree change is the honest bound.
  const fovDelta = Math.abs(wideObs.handBreadthMm - obs.handBreadthMm) / obs.handBreadthMm
  check(
    'hand breadth barely moves with assumed FOV',
    fovDelta < 0.03,
    `${(fovDelta * 100).toFixed(1)}% across 60deg -> 45deg`,
  )

  // THE regression test for sizing. Splaying the fingers fans the metacarpals,
  // so any size derived from the span ACROSS the knuckles balloons. Sizing from
  // the wrist-to-knuckle span, which runs along the hand, must not care.
  const SPLAYED = {
    5: [-34, 82, 0], // index MCP swings out
    9: [-11, 90, 0],
    13: [12, 86, 0],
    17: [35, 74, 0], // pinky MCP swings out
  }
  const together = syntheticHand(truePos, euler)
  const splayed = syntheticHand(truePos, euler, SPLAYED)
  const obsTogether = new WristObserver(together.cam).observe(
    new LandmarkSourceBuilder().build(together.result, together.cam), noPerception, 1000,
  )
  const obsSplayed = new WristObserver(splayed.cam).observe(
    new LandmarkSourceBuilder().build(splayed.result, splayed.cam), noPerception, 1000,
  )

  // How much the discarded measure would have moved, for the record.
  const across = (h) => {
    const w = h.result.worldLandmarks[0]
    return Math.hypot(w[5].x - w[17].x, w[5].y - w[17].y, w[5].z - w[17].z) * 1000
  }
  const acrossDelta = Math.abs(across(splayed) - across(together)) / across(together)
  check(
    'the across-the-knuckles span really does balloon when fingers splay',
    acrossDelta > 0.2,
    `${(acrossDelta * 100).toFixed(0)}% - which is why it is not used for sizing`,
  )

  const sizeDelta =
    Math.abs(obsSplayed.palmLengthMm - obsTogether.palmLengthMm) / obsTogether.palmLengthMm
  check(
    'wrist sizing is invariant to finger splay',
    sizeDelta < 0.04,
    `${(sizeDelta * 100).toFixed(1)}% vs ${(acrossDelta * 100).toFixed(0)}% for the old measure`,
  )

  // The anchor follows the 2D wrist landmark (that is what lines up with the
  // picture), but a one-frame glitch on that landmark must be damped, and the
  // anchor must come back when the glitch ends.
  const steady = new WristObserver(hand.cam)
  const steadySources = new LandmarkSourceBuilder()
  let steadyObs = null
  for (let i = 0; i < 8; i++) {
    steadyObs = steady.observe(steadySources.build(hand.result, hand.cam), noPerception, 1000 + i * 33)
  }
  const cleanErr = steadyObs.creasePoint.distanceTo(hand.truth[0])
  check('anchor sits on the true wrist', cleanErr < 1.5, `${cleanErr.toFixed(2)} mm`)

  const broken = syntheticHand(truePos, euler)
  broken.result.landmarks[0][0] = {
    ...broken.result.landmarks[0][0],
    x: broken.result.landmarks[0][0].x + 0.025, // ~32 px of error
  }
  const faultPx = 0.025 * hand.cam.width
  const glitchObs = steady.observe(steadySources.build(broken.result, broken.cam), noPerception, 1000 + 8 * 33)
  const glitchPx = Math.abs(glitchObs.creasePx.x - hand.cam.project(hand.truth[0]).x)
  check(
    'a one-frame wrist glitch is damped',
    glitchPx < faultPx * 0.75,
    `moved ${glitchPx.toFixed(1)} px of a ${faultPx.toFixed(0)} px fault`,
  )
  let recovered = null
  for (let i = 9; i < 15; i++) {
    recovered = steady.observe(steadySources.build(hand.result, hand.cam), noPerception, 1000 + i * 33)
  }
  const recoverErr = recovered.creasePoint.distanceTo(hand.truth[0])
  check('the anchor recovers once the glitch ends', recoverErr < 1.5, `${recoverErr.toFixed(2)} mm`)
}

// --------------------------------------- forearm axis comes from the forearm
{
  // The reported bug: rotate the palm without moving the elbow and the bracelet
  // turned with the palm, because the forearm axis was the HAND's axis and the
  // wrist is a joint. Here the silhouette says the arm runs straight down the
  // image while the hand is deviated 35 degrees away from it. The solved forearm
  // axis must follow the silhouette, not the hand.
  const cam = new CameraModel({ fovYDeg: 60 })
  cam.setResolution(1280, 720, false)

  const CANON = {
    0: [0, 0, 0], 1: [-18, 18, -8], 2: [-30, 40, -12],
    5: [-25, 85, 0], 9: [-8, 90, 0], 13: [9, 87, 0], 17: [26, 78, 0],
  }

  // Hand rotated about the view axis: wrist deviation with the forearm unmoved.
  function handDeviatedBy(deg) {
    const rot = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(deg))
    const origin = new THREE.Vector3(0, 40, -450)
    const points = []
    for (let i = 0; i < 21; i++) {
      const base = CANON[i] ?? CANON[Math.min(17, 5 + (i % 4) * 4)]
      const p = new THREE.Vector3(...base)
      if (!CANON[i]) p.y += 30
      points.push(p.applyMatrix4(rot).add(origin))
    }
    const centroid = points
      .reduce((a, p) => a.add(p), new THREE.Vector3())
      .multiplyScalar(1 / points.length)
    return {
      wrist: points[0],
      result: {
        landmarks: [points.map((p) => {
          const q = cam.project(p, { x: 0, y: 0 })
          return { x: q.x / cam.width, y: q.y / cam.height, z: 0 }
        })],
        worldLandmarks: [points.map((p) => ({
          x: (p.x - centroid.x) / 1000,
          y: -(p.y - centroid.y) / 1000,
          z: -(p.z - centroid.z) / 1000,
        }))],
        handedness: [[{ categoryName: 'Right', score: 0.99 }]],
      },
    }
  }

  // A straight forearm running DOWN the image from the wrist, plus the hand
  // itself (a real segmenter labels both as skin, and the observer refuses a
  // mask with no skin under the hand as stale).
  function armMaskFor(wristPx, halfWidthPx, handPx = []) {
    return {
      armMask: { width: 256, height: 144, version: 1, data: null },
      sampleMask(u, v) {
        const x = u * cam.width
        const y = v * cam.height
        if (handPx.some((p) => Math.hypot(p.x - x, p.y - y) < 14)) return 255
        const along = y - wristPx.y
        const across = x - wristPx.x
        if (along < -6 || along > 260) return 0
        return Math.abs(across) <= halfWidthPx ? 255 : 0
      },
    }
  }
  const handPxOf = (h) => h.result.landmarks[0].map((p) => ({ x: p.x * cam.width, y: p.y * cam.height }))

  const axisDeg = (obs) => THREE.MathUtils.radToDeg(Math.atan2(obs.basis.y.x, -obs.basis.y.y))

  const hand = handDeviatedBy(35)
  const source = new LandmarkSourceBuilder().build(hand.result, cam)

  // With no mask there is nothing but the hand to go on.
  const handOnly = new WristObserver(cam).observe(source, { armMask: null, sampleMask: () => -1 }, 1000)
  const handAxisDeg = axisDeg(handOnly)
  check(
    'hand-only axis leans with the deviated palm',
    Math.abs(handAxisDeg) > 20,
    `${handAxisDeg.toFixed(1)}deg off the arm`,
  )

  // With the silhouette it must swing back onto the arm.
  const wristPx = cam.project(hand.wrist, { x: 0, y: 0 })
  const corrected = new WristObserver(cam).observe(source, armMaskFor(wristPx, 34, handPxOf(hand)), 1000)
  const correctedDeg = axisDeg(corrected)
  check(
    'silhouette pulls the forearm axis back onto the arm',
    Math.abs(correctedDeg) < Math.abs(handAxisDeg) * 0.4,
    `${correctedDeg.toFixed(1)}deg vs ${handAxisDeg.toFixed(1)}deg hand-only`,
  )
  check('the correction is reported', corrected.forearmFromSilhouette === true)

  // A straight wrist must not be disturbed by the correction.
  const straight = handDeviatedBy(0)
  const straightObs = new WristObserver(cam).observe(
    new LandmarkSourceBuilder().build(straight.result, cam),
    armMaskFor(cam.project(straight.wrist, { x: 0, y: 0 }), 34, handPxOf(straight)),
    1000,
  )
  check('a straight wrist is left alone', Math.abs(axisDeg(straightObs)) < 6, `${axisDeg(straightObs).toFixed(1)}deg`)

  // Segmentation runs slower than the hand moves. A mask whose skin is where
  // the hand USED to be must not be measured as this frame's arm.
  const stale = new WristObserver(cam).observe(source, armMaskFor({ x: wristPx.x + 300, y: wristPx.y }, 34), 1000)
  check('a stale mask (no skin under the hand) is not used', stale.forearmFromSilhouette === false)

  // The reported problem: the model's LENGTH flickered with how far the mask
  // happened to reach (hair, shadow, a sleeve). A mask that shows only a short
  // stretch of forearm must still give an outline over the tube's full length.
  const shortObs = new WristObserver(cam).observe(source, {
    armMask: { width: 256, height: 144, version: 1, data: null },
    sampleMask(u, v) {
      const x = u * cam.width
      const y = v * cam.height
      if (handPxOf(hand).some((p) => Math.hypot(p.x - x, p.y - y) < 14)) return 255
      const along = y - wristPx.y
      return along >= -6 && along <= 60 && Math.abs(x - wristPx.x) <= 34 ? 255 : 0
    },
  }, 1000)
  const reachMm = shortObs.armOverlay ? shortObs.armOverlay.reach * shortObs.mmPerPx : 0
  check('a short mask still gives a full-length arm outline', reachMm > 85, `${reachMm.toFixed(0)} mm of outline from ~${(60 * shortObs.mmPerPx).toFixed(0)} mm of visible arm`)

  // Nonsense in the mask must be rejected rather than believed.
  const absurd = {
    armMask: { width: 256, height: 144, version: 1, data: null },
    sampleMask: (u, v) => (v * cam.height < wristPx.y - 40 ? 255 : 0), // "arm" above the hand
  }
  const rejected = new WristObserver(cam).observe(source, absurd, 1000)
  check('an implausible silhouette is rejected, not obeyed', rejected.forearmFromSilhouette === false)
}

// ------------------------------------ the wrist is a joint: palm vs. forearm
{
  // THE reported bug: tilt the palm in any direction with the forearm held
  // still, and the bracelet turned with the palm. These drive the whole
  // observer + tracker with a hand hinged at the wrist on a forearm whose pose
  // we control, frame by frame at 30 Hz, and with NO silhouette - the joint
  // model has to get this right on landmarks alone.
  const cam = new CameraModel({ fovYDeg: 60 })
  cam.setResolution(1280, 720, false)
  const CANON = {
    0: [0, 0, 0], 1: [-18, 18, -8], 2: [-30, 40, -12],
    5: [-25, 85, 0], 9: [-8, 90, 0], 13: [9, 87, 0], 17: [26, 78, 0],
  }
  const X = new THREE.Vector3(1, 0, 0)
  const Y = new THREE.Vector3(0, 1, 0)
  const Z = new THREE.Vector3(0, 0, 1)
  const noMask = { armMask: null, sampleMask: () => -1 }
  const deg = THREE.MathUtils.degToRad
  const toDeg = THREE.MathUtils.radToDeg

  /**
   * Forearm pose (rotation + wrist position) and wrist joint angles -> one
   * MediaPipe-shaped result. Hand local frame: +Y fingers, +X pinky, +Z back
   * of the hand; the forearm runs along local -Y.
   */
  let noiseSeed = 11
  const noise = () => (noiseSeed = (noiseSeed * 16807) % 2147483647) / 2147483647 - 0.5

  function frame(forearmQ, wrist, { flex = 0, dev = 0 } = {}, jitter = 0) {
    // Flexion bends the fingers toward the palm (-Z), about the X axis.
    const joint = new THREE.Quaternion()
      .setFromAxisAngle(Z, deg(dev))
      .multiply(new THREE.Quaternion().setFromAxisAngle(X, deg(-flex)))
    const handQ = forearmQ.clone().multiply(joint)
    const points = []
    for (let i = 0; i < 21; i++) {
      const base = CANON[i] ?? CANON[Math.min(17, 5 + (i % 4) * 4)]
      const p = new THREE.Vector3(...base)
      if (!CANON[i]) p.y += 30
      points.push(p.applyQuaternion(handQ).add(wrist))
    }
    const centroid = points.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / 21)
    return {
      landmarks: [points.map((p) => {
        const q = cam.project(p, { x: 0, y: 0 })
        return { x: (q.x + noise() * 3 * jitter) / cam.width, y: (q.y + noise() * 3 * jitter) / cam.height, z: 0 }
      })],
      worldLandmarks: [points.map((p) => ({
        x: (p.x - centroid.x + noise() * 6 * jitter) / 1000,
        y: -(p.y - centroid.y + noise() * 6 * jitter) / 1000,
        z: -(p.z - centroid.z + noise() * 6 * jitter) / 1000,
      }))],
      handedness: [[{ categoryName: 'Right', score: 0.99 }]],
    }
  }

  const forearmDirOf = (q) => new THREE.Vector3(0, -1, 0).applyQuaternion(q)
  const dorsalOf = (q) => Z.clone().applyQuaternion(q)

  /** Runs a scripted motion; returns the final observation and twin. */
  function run(script, frames, jitter = 0) {
    const observer = new WristObserver(cam)
    const tracker = new WristTracker(cam)
    const sources = new LandmarkSourceBuilder()
    let obs = null
    let twin = null
    for (let i = 0; i < frames; i++) {
      const t = 1000 + i * 33
      const { forearmQ, wrist, joint } = script(i)
      obs = observer.observe(sources.build(frame(forearmQ, wrist, joint, jitter), cam), noMask, t)
      tracker.ingest(obs)
      twin = tracker.update(t, 1 / 30, t)
    }
    return { obs, twin }
  }

  const ARM = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, 0.15, 0.35))
  const WRIST = new THREE.Vector3(30, 20, -450)
  const truth = forearmDirOf(ARM)
  const ramp = (i, start, len) => Math.min(1, Math.max(0, (i - start) / len))

  // Palm flexes 45 deg in 1/3 s, forearm unmoved.
  const flexed = run((i) => ({ forearmQ: ARM, wrist: WRIST, joint: { flex: 45 * ramp(i, 20, 10) } }), 32)
  const flexErr = toDeg(flexed.twin.forearmAxis.angleTo(truth))
  check('palm flexion does not tilt the bracelet', flexErr < 8, `${flexErr.toFixed(1)}deg off the forearm after a 45deg palm flex`)
  check('the joint angle is reported as flexion', Math.abs(flexed.obs.wristFlexDeg - 45) < 10, `${flexed.obs.wristFlexDeg.toFixed(1)}deg flex`)

  // Palm deviates 30 deg sideways, forearm unmoved.
  const deviated = run((i) => ({ forearmQ: ARM, wrist: WRIST, joint: { dev: 30 * ramp(i, 20, 10) } }), 32)
  const devErr = toDeg(deviated.twin.forearmAxis.angleTo(truth))
  check('palm deviation does not swing the bracelet', devErr < 8, `${devErr.toFixed(1)}deg off the forearm after a 30deg deviation`)

  // Extension (palm tilts back), combined with deviation.
  const both = run((i) => ({ forearmQ: ARM, wrist: WRIST, joint: { flex: -40 * ramp(i, 20, 12), dev: -20 * ramp(i, 20, 12) } }), 34)
  const bothErr = toDeg(both.twin.forearmAxis.angleTo(truth))
  check('combined extension + deviation leaves the bracelet on the arm', bothErr < 9, `${bothErr.toFixed(1)}deg`)

  // Pronation IS the forearm rolling, so the bracelet must roll with it.
  const pronate = (i) => ARM.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Y, deg(70) * ramp(i, 20, 15)))
  const rolled = run((i) => ({ forearmQ: pronate(i), wrist: WRIST }), 50)
  const rollErr = toDeg(rolled.twin.dorsalAxis.angleTo(dorsalOf(pronate(49))))
  check('forearm roll (pronation) is still followed', rollErr < 6, `${rollErr.toFixed(1)}deg dorsal error after a 70deg roll`)
  const rollAxisErr = toDeg(rolled.twin.forearmAxis.angleTo(truth))
  check('...and roll does not move the forearm axis', rollAxisErr < 4, `${rollAxisErr.toFixed(1)}deg`)

  // The whole arm swinging about the elbow must be followed, not held back.
  const ELBOW = WRIST.clone().addScaledVector(truth, 250)
  const swing = (i) => new THREE.Quaternion().setFromAxisAngle(X, deg(-40) * ramp(i, 20, 15))
  const swung = run((i) => {
    const q = swing(i)
    return {
      forearmQ: q.clone().multiply(ARM),
      wrist: WRIST.clone().sub(ELBOW).applyQuaternion(q).add(ELBOW),
    }
  }, 50)
  const swingTruth = forearmDirOf(swing(49).multiply(ARM))
  const swingErr = toDeg(swung.twin.forearmAxis.angleTo(swingTruth))
  check('an arm swinging from the elbow is followed', swingErr < 8, `${swingErr.toFixed(1)}deg after a 40deg swing`)

  // The same with detector-grade noise (~1.5 px 2D, ~3 mm 3D per landmark):
  // jitter must not be mistaken for the arm moving.
  const noisyFlex = run((i) => ({ forearmQ: ARM, wrist: WRIST, joint: { flex: 45 * ramp(i, 20, 10) } }), 32, 1)
  const noisyFlexErr = toDeg(noisyFlex.twin.forearmAxis.angleTo(truth))
  check('palm flexion under landmark noise still leaves the bracelet', noisyFlexErr < 10, `${noisyFlexErr.toFixed(1)}deg`)
  const noisySwing = run((i) => {
    const q = swing(i)
    return { forearmQ: q.clone().multiply(ARM), wrist: WRIST.clone().sub(ELBOW).applyQuaternion(q).add(ELBOW) }
  }, 50, 1)
  const noisySwingErr = toDeg(noisySwing.twin.forearmAxis.angleTo(swingTruth))
  check('an elbow swing under landmark noise is still followed', noisySwingErr < 10, `${noisySwingErr.toFixed(1)}deg`)

  // For the record: a palm tilt HELD motionless is ambiguous without depth or
  // an elbow, and the estimate slowly relaxes toward the hand. Bound it.
  const held = run((i) => ({ forearmQ: ARM, wrist: WRIST, joint: { flex: 45 * ramp(i, 20, 10) } }), 30 + 60)
  const heldErr = toDeg(held.twin.forearmAxis.angleTo(truth))
  check('a palm tilt held for 2 s drifts only partway', heldErr < 25, `${heldErr.toFixed(1)}deg of 45deg after 2 s`)
}

// ------------------------------------------ silhouette line is not pinned
{
  // Landmark 0 is rarely on the arm's centreline. A line forced through it
  // tilts badly; the fit must be about the centres' own centroid.
  const cam = new CameraModel({ fovYDeg: 60 })
  cam.setResolution(1280, 720, false)
  const crease = { x: 640, y: 300 }
  const OFFSET_PX = 9 // centreline sits 9 px to the side of the wrist landmark
  const armAt = (x, y) => {
    const along = y - crease.y
    const across = x - (crease.x + OFFSET_PX)
    if (along < -6 || along > 300) return 0
    return Math.abs(across) <= 40 ? 255 : 0
  }
  const profiler = new ArmProfiler()
  // Seeded 12 deg off, as a flexed palm would seed it.
  const seed = THREE.MathUtils.degToRad(12)
  const fit = profiler.measure(armAt, crease, Math.sin(seed), Math.cos(seed), 0.7, 28)
  const err = THREE.MathUtils.radToDeg(Math.atan2(fit.dx, fit.dy))
  check('silhouette fit ignores a wrist landmark off the centreline', Math.abs(err) < 1.5, `${err.toFixed(2)}deg from a 12deg-off seed`)
  const w = { halfWidthMm: 0, offsetMm: 0 }
  profiler.sectionAt(40, w)
  check('arm half-width is measured square-on', Math.abs(w.halfWidthMm - 40 * 0.7) < 2, `${w.halfWidthMm.toFixed(1)} mm, want 28`)
  check('an arm running out of view reports no end', fit.sleeveLimitMm === Infinity)

  // Skin stopping inside the frame (a sleeve, a watch strap, anything) is
  // where measurement stops - found from the skin alone.
  const covered = (x, y) => (y > crease.y + 60 / 0.7 ? 0 : armAt(x, y))
  const cuff = profiler.measure(covered, crease, 0, 1, 0.7, 28)
  check('skin ending inside the frame is found where it ends', cuff && Math.abs(cuff.sleeveLimitMm - 60) < 5, `${cuff?.sleeveLimitMm?.toFixed(1)} mm, want 60`)

  // THE regression from the recordings: the forearm crosses in front of the
  // neck, and on one side arm skin and neck skin fuse into one blob for a
  // long stretch. Width and axis must come from the arm, not the blob.
  const neck = (x, y) => (armAt(x, y) === 255 || (x < crease.x && x > crease.x - 110 && y > crease.y + 40 && y < crease.y + 200) ? 255 : 0)
  const fused = profiler.measure(neck, crease, 0, 1, 0.7, 28)
  const fusedErr = fused ? THREE.MathUtils.radToDeg(Math.atan2(fused.dx, fused.dy)) : NaN
  check('an arm fused with neck skin keeps its axis', Math.abs(fusedErr) < 2, `${fusedErr.toFixed(2)}deg`)
  const fw = { halfWidthMm: 0, offsetMm: 0 }
  profiler.sectionAt(60, fw)
  check('...and its width, where the blob is', Math.abs(fw.halfWidthMm - 28) < 2.5, `${fw.halfWidthMm.toFixed(1)} mm, want 28`)
}

// -------------------------------------------------- rotation 1€ filter
{
  // Still wrist + orientation noise: the output must be much steadier than the
  // input, yet a real turn must still be tracked promptly.
  const f = new OneEuroQuat({ minCutoff: 1.2, beta: 0.9, dCutoff: 1.0 })
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5
  const noisy = () => new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 0.05, rand() * 0.05, rand() * 0.05))
  let prevIn = null
  let prevOut = null
  let inJ = 0
  let outJ = 0
  for (let i = 0; i < 90; i++) {
    const q = noisy()
    const out = f.filter(q, i * 33).clone()
    if (prevIn) {
      inJ += q.angleTo(prevIn)
      outJ += out.angleTo(prevOut)
    }
    prevIn = q
    prevOut = out
  }
  check('rotation filter removes most jitter at rest', outJ < inJ * 0.35, `${((outJ / inJ) * 100).toFixed(0)}% of input jitter`)

  const target = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.0)
  for (let i = 90; i < 90 + 12; i++) f.filter(target, i * 33)
  const lag = THREE.MathUtils.radToDeg(f.value.angleTo(target))
  check('rotation filter catches up with a real turn in 0.4 s', lag < 6, `${lag.toFixed(1)}deg behind`)
}

// ------------------------------------------------------- invisible walls
{
  // Two planes across the arm at the ends of the tube. Between them the
  // bracelet moves freely; it never passes either one. Nothing about them is
  // drawn or occludes.
  const bangle = getBracelet('bangle-classic-18k')
  const alongOf = (twin, p) => p.clone().sub(twin.creasePoint).dot(twin.forearmAxis)

  // Hand raised, forearm straight down: gravity slides a loose bangle up the
  // arm, and it must stop at the far plane.
  for (const realistic of [true, false]) {
    const down = makeTwin(44, 32, new THREE.Vector3(0.05, -1, 0.02))
    const fit = solver.evaluate(bangle, down)
    const rigid = new RigidSolver()
    let at = 0
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < 300; i++) {
      rigid.solve(bangle, fit, down, 1 / 60, { realistic })
      at = alongOf(down, rigid.position)
      lo = Math.min(lo, at)
      hi = Math.max(hi, at)
    }
    const mode = realistic ? 'realistic' : 'stable'
    check(`${mode}: a sliding bangle stays between the wall planes`, lo >= WALL_NEAR_MM - 0.01 && hi <= WALL_FAR_MM + 0.01, `${lo.toFixed(1)}..${hi.toFixed(1)} mm, planes at ${WALL_NEAR_MM}/${WALL_FAR_MM}`)
    check(`${mode}: ...and is free to move between them`, hi - fit.restingOffsetMm > 3, `slid ${(hi - fit.restingOffsetMm).toFixed(1)} mm from rest`)
  }

  // Stable mode keeps sag and tilt small even with a lot of slack.
  const small = makeTwin(44, 32)
  const smallFit = solver.evaluate(bangle, small)
  const still = new RigidSolver()
  for (let i = 0; i < 120; i++) still.solve(bangle, smallFit, small, 1 / 60)
  check('stable mode: sag and tilt stay tiny', still.dropMm <= 1.5 + 1e-6 && Math.abs(still.tiltRad) <= (3 * Math.PI) / 180 + 1e-6, `sag ${still.dropMm.toFixed(2)} mm, tilt ${(still.tiltRad * 57.3).toFixed(2)} deg, slack ${smallFit.slackMm.toFixed(0)} mm`)

  for (const id of ['chain-rope-14k', 'charm-heirloom']) {
    const asset = getBracelet(id)
    const twin = makeTwin(44, 32, new THREE.Vector3(0.05, -1, 0.02))
    const chainFit = solver.evaluate(asset, twin)
    const chain = new XPBDChainSolver()
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < 240; i++) {
      // Shake the arm about, as a user does, to try to throw the chain off.
      twin.center.x = Math.sin(i * 0.3) * 25
      twin.creasePoint.copy(twin.center)
      twin.crossSections.forEach((sec) => sec.center.copy(twin.creasePoint).addScaledVector(twin.forearmAxis, sec.s))
      chain.solve(asset, chainFit, twin, 1 / 60)
      for (const p of chain.particles) {
        const along = alongOf(twin, p)
        lo = Math.min(lo, along)
        hi = Math.max(hi, along)
      }
    }
    check(`${id}: every link stays between the wall planes while shaken`, lo >= WALL_NEAR_MM - 0.5 && hi <= WALL_FAR_MM + 0.5, `${lo.toFixed(1)}..${hi.toFixed(1)} mm`)
  }
}

// ------------------------------------ arm space: tracking noise cannot unthread
{
  // Deterministic noise, so a failure reproduces.
  let seed = 0x9e3779b9
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const sym = () => rand() * 2 - 1

  // Put a twin at a world pose: every section moves rigidly with it.
  const baseTwin = makeTwin(44, 32, new THREE.Vector3(0.05, -1, 0.02))
  const baseQ = baseTwin.quaternion.clone()
  const baseC = baseTwin.center.clone()
  const baseS = baseTwin.crossSections.map((sec) => sec.s)
  const place = (twin, offset, rot) => {
    const q = rot.clone().multiply(baseQ)
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q)
    twin.quaternion.copy(q)
    twin.radialAxis.setFromMatrixColumn(m, 0)
    twin.forearmAxis.setFromMatrixColumn(m, 1)
    twin.dorsalAxis.setFromMatrixColumn(m, 2)
    twin.center.copy(baseC).add(offset)
    twin.creasePoint.copy(twin.center)
    twin.crossSections.forEach((sec, i) => sec.center.copy(twin.creasePoint).addScaledVector(twin.forearmAxis, baseS[i]))
  }
  const winding = (chain) => {
    let total = 0
    const pts = chain.local
    let prev = Math.atan2(pts[pts.length - 1].z, pts[pts.length - 1].x)
    for (const p of pts) {
      const a = Math.atan2(p.z, p.x)
      let d = a - prev
      if (d > Math.PI) d -= 2 * Math.PI
      else if (d < -Math.PI) d += 2 * Math.PI
      total += d
      prev = a
    }
    return Math.round(total / (2 * Math.PI))
  }
  const penetration = (chain, twin) => {
    let worst = 0
    const sec = { a: 0, b: 0 }
    for (const p of chain.local) {
      twin.sectionAt(Math.max(0, Math.min(120, p.y)), sec)
      const f = (p.x * p.x) / (sec.a * sec.a) + (p.z * p.z) / (sec.b * sec.b)
      worst = Math.max(worst, 1 - f)
    }
    return worst
  }

  // The live failure: a still arm whose tracked pose jumps every frame by
  // about the wrist's radius in depth, several mm across, and a few degrees.
  for (const realistic of [false, true]) {
    for (const id of ['tennis-brilliant', 'chain-rope-14k', 'charm-heirloom']) {
      const asset = getBracelet(id)
      const twin = makeTwin(44, 32, new THREE.Vector3(0.05, -1, 0.02))
      const fit = solver.evaluate(asset, twin)
      const chain = new XPBDChainSolver()
      const offset = new THREE.Vector3()
      const rot = new THREE.Quaternion()
      const axis = new THREE.Vector3()
      let off = 0
      let lo = Infinity
      let hi = -Infinity
      let deepest = 0
      let publishErr = 0
      for (let i = 0; i < 900; i++) {
        offset.set(sym() * 6, sym() * 6, sym() * 20)
        axis.set(sym(), sym(), sym()).normalize()
        rot.setFromAxisAngle(axis, THREE.MathUtils.degToRad(4) * sym())
        place(twin, offset, rot)
        chain.solve(asset, fit, twin, 1 / 60, [], { realistic })
        if (Math.abs(winding(chain)) !== 1) off++
        for (const p of chain.local) {
          lo = Math.min(lo, p.y)
          hi = Math.max(hi, p.y)
        }
        deepest = Math.max(deepest, penetration(chain, twin))
        const w = chain.local[0].clone().applyMatrix4(twin.frameMatrix())
        publishErr = Math.max(publishErr, w.distanceTo(chain.particles[0]))
      }
      const mode = realistic ? 'realistic' : 'stable'
      check(`${mode} ${id}: violent pose jitter never unthreads the loop`, off === 0 && chain.recoveries === 0, `${off} frames off the arm, ${chain.recoveries} re-seats`)
      check(`${mode} ${id}: ...every link stays between the walls`, lo >= WALL_NEAR_MM - 0.01 && hi <= WALL_FAR_MM + 0.01, `${lo.toFixed(1)}..${hi.toFixed(1)} mm`)
      check(`${mode} ${id}: ...and out of the arm`, deepest < 0.06, `worst penetration factor ${deepest.toFixed(3)}`)
      check(`${mode} ${id}: world output is exactly the arm-space state`, publishErr < 1e-3, `${publishErr.toExponential(1)} mm`)
    }
  }

  // Held still under tracking noise, a stable-mode chain must be calm ON THE
  // ARM: noise may move arm and bracelet together, never one against the other.
  {
    const asset = getBracelet('chain-rope-14k')
    const twin = makeTwin(44, 32, new THREE.Vector3(0.05, -1, 0.02))
    const fit = solver.evaluate(asset, twin)
    const chain = new XPBDChainSolver()
    const rot = new THREE.Quaternion()
    const axis = new THREE.Vector3()
    let last = null
    let motion = 0
    let frames = 0
    for (let i = 0; i < 600; i++) {
      axis.set(sym(), sym(), sym()).normalize()
      rot.setFromAxisAngle(axis, THREE.MathUtils.degToRad(1.5) * sym())
      place(twin, new THREE.Vector3(sym() * 2, sym() * 2, sym() * 8), rot)
      chain.solve(asset, fit, twin, 1 / 60)
      if (i >= 300) {
        let sum = 0
        chain.local.forEach((p, k) => {
          sum += p.distanceTo(last[k])
        })
        motion += sum / chain.local.length
        frames++
      }
      last = chain.local.map((p) => p.clone())
    }
    const mean = motion / frames
    check('stable: a held arm under tracking noise leaves the chain still on the arm', mean < 0.05, `${mean.toFixed(3)} mm/frame on the arm`)
  }

  // Real motion must still reach the chain: a brisk sideways swing makes a
  // loose chain move on the arm, and it settles again once the arm stops.
  {
    const asset = getBracelet('charm-heirloom')
    const twin = makeTwin(44, 32, new THREE.Vector3(0.05, -1, 0.02))
    const fit = solver.evaluate(asset, twin)
    const chain = new XPBDChainSolver()
    const still = new THREE.Quaternion()
    const centroid = () => chain.local.reduce((c, p) => c.add(p), new THREE.Vector3()).multiplyScalar(1 / chain.local.length)
    for (let i = 0; i < 120; i++) {
      place(twin, new THREE.Vector3(), still)
      chain.solve(asset, fit, twin, 1 / 60, [], { realistic: true })
    }
    const rest = centroid()
    let swing = 0
    for (let i = 0; i < 120; i++) {
      place(twin, new THREE.Vector3(Math.sin((i / 60) * 2 * Math.PI * 2) * 40, 0, 0), still)
      chain.solve(asset, fit, twin, 1 / 60, [], { realistic: true })
      swing = Math.max(swing, centroid().distanceTo(rest))
    }
    check('realistic: a real swing of the arm moves the chain on it', swing > 1.5, `${swing.toFixed(1)} mm from rest`)
    let settle = 0
    for (let i = 0; i < 240; i++) {
      place(twin, new THREE.Vector3(), still)
      chain.solve(asset, fit, twin, 1 / 60, [], { realistic: true })
      if (i >= 180) settle = Math.max(settle, centroid().distanceTo(rest))
    }
    check('...and settles back once the arm stops', settle < 0.5, `${settle.toFixed(2)} mm from rest`)
  }

  // The occluder tube is built once; after that the pose only moves it.
  {
    const occluder = new WristOccluder({ uniforms: {} })
    const twin = makeTwin(44, 32, new THREE.Vector3(0.05, -1, 0.02))
    const rot = new THREE.Quaternion()
    const axis = new THREE.Vector3()
    occluder.update(twin)
    const built = Float32Array.from(occluder.geometry.attributes.position.array)
    let worst = 0
    for (let i = 0; i < 200; i++) {
      axis.set(sym(), sym(), sym()).normalize()
      rot.setFromAxisAngle(axis, THREE.MathUtils.degToRad(10) * sym())
      place(twin, new THREE.Vector3(sym() * 30, sym() * 30, sym() * 60), rot)
      occluder.update(twin)
      // A ring vertex, placed by the matrix, sits exactly on the twin's section.
      const pos = occluder.geometry.attributes.position.array
      const r = 3
      const k = r * 28 * 3
      const v = new THREE.Vector3(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(occluder.depthMesh.matrix)
      const sec = twin.crossSections[r - 1]
      const want = sec.center.clone().addScaledVector(twin.radialAxis, sec.a)
      worst = Math.max(worst, v.distanceTo(want))
    }
    const same = occluder.geometry.attributes.position.array.every((x, i) => x === built[i])
    check('occluder: the tube is built once and only moved by the pose', occluder.rebuilds === 1 && same, `${occluder.rebuilds} builds`)
    check('occluder: ...and sits exactly on the arm', worst < 1e-3, `${worst.toExponential(1)} mm`)
    twin.crossSections.forEach((sec) => {
      sec.a += 1
    })
    occluder.update(twin)
    check('occluder: a change of measured shape rebuilds it', occluder.rebuilds === 2)
    occluder.dispose()
  }
}

// ------------------------------------------ a bracelet at rest stays at rest
{
  // A uniform loop round an arm is in neutral equilibrium at every rotation,
  // so any bias in the solver turns it round the wrist on its own. The old
  // bend weights did: a tennis bracelet spun ~190 deg/s round a still arm.
  const twin = makeTwin()
  for (const id of ['tennis-brilliant', 'chain-rope-14k', 'charm-heirloom']) {
    const asset = getBracelet(id)
    const fit = solver.evaluate(asset, twin)
    const chain = new XPBDChainSolver()
    for (let i = 0; i < 600; i++) chain.solve(asset, fit, twin, 1 / 60)
    const before = chain.local.map((p) => p.clone())
    for (let i = 0; i < 120; i++) chain.solve(asset, fit, twin, 1 / 60)
    const moved = Math.max(...chain.local.map((p, k) => p.distanceTo(before[k])))
    check(`${id}: at rest on a still arm it does not creep round the wrist`, moved < 0.2, `${moved.toFixed(2)} mm in 2 s`)
  }
}

// ----------------------------------------------------- twist and spike gates
{
  const deg = THREE.MathUtils.degToRad
  const Y = new THREE.Vector3(0, 1, 0)
  const X = new THREE.Vector3(1, 0, 0)
  const twistOf = (q, ref) => {
    const d = ref.clone().invert().multiply(q)
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w)
    return THREE.MathUtils.radToDeg(2 * Math.atan2(d.y, d.w))
  }
  const base = new THREE.Quaternion().setFromAxisAngle(X, deg(20))
  const rolled = (a) => base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Y, deg(a)))

  // The detector's mirror flip: 120 deg of roll in one frame, for 6 frames.
  const gate = new TwistGate()
  let t = 0
  gate.filter(rolled(0), t)
  let worst = 0
  for (let i = 0; i < 6; i++) worst = Math.max(worst, Math.abs(twistOf(gate.filter(rolled(120), (t += 33)), base)))
  check('twist gate: a short mirror flip of the palm never reaches the pose', worst < 1, `${worst.toFixed(1)} deg of it passed`)
  // ...while the swing of the forearm in those frames is kept.
  const swung = base.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), deg(8)))
  const out = gate.filter(swung.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Y, deg(120))), (t += 33))
  const axisErr = THREE.MathUtils.radToDeg(Y.clone().applyQuaternion(out).angleTo(Y.clone().applyQuaternion(swung)))
  check('...and the forearm direction in those frames is still followed', axisErr < 0.5, `${axisErr.toFixed(2)} deg off`)

  // A re-orientation that persists is believed, and turned into smoothly.
  const g2 = new TwistGate()
  t = 0
  g2.filter(rolled(0), t)
  let last = 0
  let maxStep = 0
  let final = 0
  for (let i = 0; i < 40; i++) {
    final = twistOf(g2.filter(rolled(110), (t += 33)), base)
    maxStep = Math.max(maxStep, Math.abs(final - last))
    last = final
  }
  check('twist gate: a lasting re-orientation is accepted', Math.abs(final - 110) < 1, `${final.toFixed(1)} deg of 110`)
  check('...turning at a hand\'s pace, never in one jump', maxStep <= 360 * 0.033 + 0.5, `${maxStep.toFixed(1)} deg per frame at most`)

  // Ordinary roll passes straight through, undelayed.
  const g3 = new TwistGate()
  t = 0
  let lag = 0
  for (let i = 0; i <= 30; i++) lag = Math.max(lag, Math.abs(twistOf(g3.filter(rolled(i * 6), (t += 33)), base) - i * 6))
  check('twist gate: a normal 180 deg/s roll passes untouched', lag < 0.01, `${lag.toFixed(3)} deg lag`)

  const spike = new SpikeGate(7)
  const first = spike.filter(18)
  const second = spike.filter(1.5)
  const third = spike.filter(2)
  check('spike gate: an unconfirmed first reading is not trusted', first === null && second === null && third === 2, `${first}, ${second}, ${third}`)
  const glitch = spike.filter(20)
  const back = spike.filter(2.5)
  check('spike gate: a one-frame glitch never reaches the output', glitch === 2 && back === 2.5)
  spike.filter(15)
  const real = spike.filter(16)
  check('spike gate: a real step is accepted one frame later', real === 16)
}

// ---------------------------------------------- warm-up hides lock-on frames
{
  const sm = new TrackingStateMachine()
  sm.observe(0.9, 0)
  sm.hold = true
  for (let i = 0; i < 30; i++) {
    sm.observe(0.9, i * 16)
    sm.update(i * 16, 1 / 60)
  }
  check('a held track stays invisible whatever its confidence', sm.presence === 0 && sm.state !== 'LOST', `presence ${sm.presence.toFixed(2)}, ${sm.state}`)
  sm.hold = false
  for (let i = 30; i < 60; i++) {
    sm.observe(0.9, i * 16)
    sm.update(i * 16, 1 / 60)
  }
  check('...and fades in once released', sm.presence > 0.99, `presence ${sm.presence.toFixed(2)}`)
}

// -------------------------------------------------- measure once, then freeze
{
  // The shape is measured once and then frozen; afterwards only the pose moves.
  const g = new GeometrySolver()
  const profile = (half) => [0, 9, 18, 28, 40, 54, 70, 88].map((sv) => ({ s: sv, halfWidthMm: half, offsetMm: 0, measured: true, confidence: 0.9 }))
  for (let i = 0; i < 60; i++) g.ingest({ poseConfidence: 0.9, rollTheta: 0.3, scaleLocked: true, profile: profile(27 + (i % 3) * 0.3) })
  check('the wrist shape freezes after ~1.5 s of good frames, without a wrist turn', g.locked, `${g.widthMm.toFixed(1)} x ${g.depthMm.toFixed(1)} mm`)
  const frozen = g.widthMm
  for (let i = 0; i < 30; i++) g.ingest({ poseConfidence: 0.9, rollTheta: 0.3, scaleLocked: true, profile: profile(35) })
  check('...and later measurements no longer change it', g.widthMm === frozen, `${g.widthMm.toFixed(2)} vs ${frozen.toFixed(2)}`)
  g.reset()
  check('re-measure unfreezes it', !g.locked)

  // Readings that have not settled must not be frozen in.
  const jumpy = new GeometrySolver()
  for (let i = 0; i < 90; i++) jumpy.ingest({ poseConfidence: 0.9, rollTheta: 0.3, scaleLocked: true, profile: profile(i % 2 ? 20 : 30) })
  check('unsettled measurements are not frozen', !jumpy.locked, `${jumpy.widthMm.toFixed(1)} mm, still measuring`)
}

// -------------------------------------- centreline offset goes the right way
{
  // THE reported bug: palm side-on, the wrist landmark sits on the arm's
  // edge, the silhouette measures the arm's centre 10 mm to the image-LEFT of
  // it (+v = image (-dy, dx) for an arm running down the image), and the
  // bracelet must move LEFT onto the arm - not 10 mm right, off it.
  const cam = new CameraModel()
  cam.setResolution(1280, 720, false)
  const tracker = new WristTracker(cam)
  const basis = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, -1, 0), z: new THREE.Vector3(0, 0, -1) }
  basis.z.crossVectors(basis.x, basis.y)
  const obs = (t) => ({
    timestamp: t, handedness: 'Right', mmPerPx: 0.7, depthMm: 450, handBreadthMm: 82,
    creasePoint: new THREE.Vector3(0, 0, -450), creasePx: { x: 640, y: 360 },
    basis, quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(basis.x, basis.y, basis.z)),
    rollTheta: 0.2, dorsalAgreement: 0.9, reprojectionPx: 1,
    profile: [0, 9, 18, 28, 40, 54, 70, 88].map((s) => ({ s, halfWidthMm: 26, offsetMm: 10, measured: true, confidence: 0.9 })),
    sleeveLimitMm: Infinity, poseConfidence: 0.9, landmarks3D: [], landmarkCount: 0,
  })
  let twin = null
  for (let i = 0; i < 12; i++) {
    tracker.ingest(obs(1000 + i * 33))
    twin = tracker.update(1000 + i * 33, 1 / 30, 1000 + i * 33)
  }
  const centre = cam.project(twin.crossSections[2].center)
  const crease = cam.project(twin.creasePoint)
  const shiftMm = (centre.x - crease.x) * cam.mmPerPxAt(450) // px -> mm at the wrist
  check('the bracelet moves onto the measured arm centre, not away from it', shiftMm < -8 && shiftMm > -12, `${shiftMm.toFixed(1)} mm, want -10`)
}

// ------------------------------------------------------------ mask refiner
{
  // A blurry, 6 px-misplaced network mask of a bright arm on a dark
  // background: the refiner must move the edge back onto the image edge.
  const W = 120
  const H = 60
  const EDGE = 60 // true arm edge column
  const rgb = new Uint8Array(W * H * 3)
  const prob = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const arm = x < EDGE
      rgb.set(arm ? [205, 150, 120] : [60, 62, 70], i * 3)
      // Network: soft ramp centred 6 px too far out.
      prob[i] = 1 / (1 + Math.exp((x - (EDGE + 6)) / 3))
    }
  }
  const crossing = (p) => {
    const row = 30 * W
    for (let x = 1; x < W; x++) if (p[row + x - 1] >= 0.5 && p[row + x] < 0.5) return x
    return NaN
  }
  const before = crossing(prob)
  const after = crossing(new MaskRefiner().refine(rgb, 3, prob, W, H))
  check('refiner moves a misplaced mask edge onto the image edge', Math.abs(after - EDGE) <= 1, `edge ${before} -> ${after}, true ${EDGE}`)

  // Colour evidence must not invent an arm where the image has none: a
  // background patch the network is unsure about stays background.
  const unsure = new Float32Array(W * H).fill(0.02)
  for (let y = 0; y < H; y++) for (let x = 0; x < EDGE; x++) unsure[y * W + x] = 0.98
  for (let y = 20; y < 40; y++) for (let x = 80; x < 100; x++) unsure[y * W + x] = 0.45
  const cleaned = new MaskRefiner().refine(rgb, 3, unsure, W, H)
  check('an uncertain background patch is resolved as background', cleaned[30 * W + 90] < 0.2, cleaned[30 * W + 90].toFixed(2))
}

// ----------------------------------------------------------------- catalogue
{
  check('every asset declares millimetres', CATALOG.every((a) => a.units === 'mm'))
  check('every asset has a real circumference', CATALOG.every((a) => a.innerCircumferenceMm > 120 && a.innerCircumferenceMm < 240))
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
