import * as THREE from 'three'
import { WristDigitalTwin } from './WristDigitalTwin.js'
import { GeometrySolver } from './GeometrySolver.js'
import { OneEuroFilter } from '../core/OneEuroFilter.js'
import { ScreenPointFilter } from '../core/ScreenPointFilter.js'
import { Deadzone1D } from '../core/Deadzone.js'
import { OrientationFilter } from './OrientationFilter.js'
import {
  angularVelocity,
  clamp,
  ellipseCircumference,
  integrateAngularVelocity,
  RunningStat,
} from '../core/mathUtils.js'
import { TrackingState, TrackingStateMachine } from '../core/TrackingState.js'
import { SleeveFilter, SpikeGate, TwistGate } from './PoseGates.js'

const _v = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _perp = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _prev = new THREE.Quaternion()
const VIEW_DIR = new THREE.Vector3(0, 0, -1)

/**
 * Extrapolation saturates rather than running linearly out to the budget: the
 * hand decelerates, and a straight-line guess 200 ms out overshoots visibly
 * every time it stops.
 */
const PREDICTION_TAU_S = 0.06

/** Forearm widening per mm up the arm (measured; see WristObserver). */
const FOREARM_TAPER_PER_MM = 0.0006

/** Twin section whose shape the arm ruler uses (s = 18 mm, next to the 20 mm station). */
const ARM_RULER_SECTION = 2
/** Outline confidence -> ruler weight, and the most the ruler is ever trusted. */
const ARM_RULER_GAIN = 2.2
const ARM_RULER_MAX = 0.95
/**
 * The arm ruler's reading (log of arm-width distance over palm distance) is
 * held back when it jumps further than this in one outline, until the next
 * outline confirms it. The two distances move together when the arm really
 * moves; their ratio jumping means a broken outline - on a still recording a
 * mask that lost half the arm read 68 px against 144 px, and the arm and
 * every bracelet on it shrank by a fifth for a quarter of a second. Frame to
 * frame the ratio moves by ~3 %.
 */
const RULER_GATE = 0.15

/** Arm stretch the centreline offset is read over: where bracelets sit, mm. */
const CENTRE_FROM_MM = 9
const CENTRE_TO_MM = 40
/** The station the wrist's width and depth are measured at (GeometrySolver). */
const REFERENCE_S_MM = 18

/**
 * A centreline offset jumping further than this in one frame is held back
 * until the next frame confirms it. Turning the hand side-on moves it a few
 * mm per frame; a bad mask row moved it 18 mm and straight back.
 */
const CENTRE_GATE_MM = 7
/**
 * Deadzone on the centreline offset, mm: still / moving band. Taken raw from
 * each frame's mask it shook a still arm sideways; with this the shake of a
 * point 20 mm up the arm on a still arm went 1.48 -> 0.96 px (p50), with no
 * extra lag while moving.
 */
const CENTRE_DEADZONE_MM = { rest: 3, move: 0.5 }

/**
 * The arm ruler's weight at which its depth is trusted enough to jump to
 * when a track starts, instead of gliding there from the palm's estimate.
 */
const RULER_SNAP_WEIGHT = 0.5

/**
 * Fastest the wrist's shape - as the arm tube, the physics and the arm ruler
 * see it - may change, mm/s. Until the shape is frozen the measurement keeps
 * refining (on an unlocked recording it moved by 10+ mm), and a tube that
 * resized under a bracelet frame by frame threw it about; it glides instead.
 * While the jewellery is hidden it simply takes the measurement.
 */
const SHAPE_GLIDE_MM_S = 10

/**
 * Warm-up: a new track is shown only after this many consecutive steady
 * observations - confident, the same hand, and a palm depth that is not
 * still lurching (per-frame change in log depth) - and only once the wrist's
 * size is known (measured, remembered or typed in): jewellery is never worn
 * on a placeholder wrist. While MediaPipe locks on it
 * flips the hand's label, jumps the wrist 190 px across the image and
 * reports a depth 3x too far (the side-on recording); a bracelet shown on
 * that flies across the screen before it settles.
 */
const WARMUP_FRAMES = 4
const WARMUP_MIN_CONFIDENCE = 0.45
const WARMUP_MAX_DEPTH_STEP = 0.1

/**
 * The temporal wrist solver.
 *
 * Geometry is reconstructed across time, not predicted independently per frame.
 * Pose is filtered and extrapolated so the renderer never runs at the detector
 * rate; shape is accumulated and then frozen.
 */
export class WristTracker {
  constructor(cameraModel) {
    this.camera = cameraModel
    this.twin = new WristDigitalTwin(8)
    this.geometry = new GeometrySolver()
    this.tracking = new TrackingStateMachine()

    // Screen direction (x/depth, y/depth): predicted along the motion, so a
    // moving wrist is not trailed, and held while still (see ScreenPointFilter:
    // the 1€ filter here trailed every movement by 5-10 px).
    this.positionFilter = new ScreenPointFilter()
    // log(depth): ~0.5 Hz when steady; moving toward the camera at 200 mm/s
    // (0.5 /s in log units) lifts it to ~1.5 Hz.
    this.depthFilter = new OneEuroFilter({ minCutoff: 0.5, beta: 2, dCutoff: 1.0 })
    // Direction and roll filtered apart (see OrientationFilter): the axis by a
    // 1 deg deadzone, the roll - the noisiest part of the pose - by a
    // Kalman filter.
    this.rotationFilter = new OrientationFilter()
    /**
     * Diagnostic: take each observation as it is - no smoothing, gating or
     * slew limit on position, distance, orientation or the arm's centreline.
     * The filters keep running, so switching back does not start them cold.
     */
    this.raw = false
    /** Drops the detector's mirror flips of the palm (see PoseGates). */
    this.twistGate = new TwistGate()
    this.centreGate = new SpikeGate(CENTRE_GATE_MM)
    /** Holds the centreline still on a still arm (see CENTRE_DEADZONE_MM). */
    this.centreDeadzone = new Deadzone1D(CENTRE_DEADZONE_MM)
    this.rulerGate = new SpikeGate(RULER_GATE)
    /** A sleeve is believed only once it persists (see SleeveFilter). */
    this.sleeveFilter = new SleeveFilter()
    /**
     * This frame's distance reading before filtering, mm (the arm ruler's
     * blend): for the scorecard's depth-lag measure.
     */
    this.depthMeasurementMm = NaN
    /** False until the arm ruler has set the depth of this track once. */
    this._depthSettled = false
    this._snapDepth = false
    /** Warm-up state of the current track (see WARMUP_FRAMES). */
    this._warm = false
    this._steadyCount = 0
    this._lastHandedness = null
    this._lastPalmDepth = 0
    this.position = new THREE.Vector3()
    this.velocity = new THREE.Vector3()
    this.quaternion = new THREE.Quaternion()
    this.omega = new THREE.Vector3()

    this.basis = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, -1, 0), z: new THREE.Vector3(0, 0, 1) }
    /** Arm centreline, sideways from the wrist landmark, mm (see ingest). */
    this.centreOffset = 0
    this.sleeveLimitMm = Infinity

    this.lastObservationTime = 0
    this.hasPose = false
    this._tmpPos = [0, 0]
    this._rulerPoint = new THREE.Vector3()
    /** Last log(depth correction) the arm ruler applied; held between outlines. */
    this._rulerLog = 0
    this._lastFiltered = new THREE.Vector3()

    /** Temporal-quality metrics — the thing screenshots never show. */
    this.metrics = {
      positionJitterPx: new RunningStat(90),
      rotationJitterDeg: new RunningStat(90),
      scaleBreathingPct: new RunningStat(90),
    }
    this._lastProjected = null
    this._lastQuatForJitter = new THREE.Quaternion()
    this._lastWidth = 0
  }

  reset() {
    this.positionFilter.reset()
    this.depthFilter.reset()
    this.rotationFilter.reset()
    this.centreOffset = 0
    this.twistGate.reset()
    this.centreGate.reset()
    this.centreDeadzone.reset()
    this.rulerGate.reset()
    this.sleeveFilter.reset()
    this._depthSettled = false
    this._snapDepth = false
    this._warm = false
    this._steadyCount = 0
    this._lastHandedness = null
    this._lastPalmDepth = 0
    this.tracking.hold = false
    this._rulerLog = 0
    this.omega.set(0, 0, 0)
    this.velocity.set(0, 0, 0)
    this.geometry.reset()
    this.tracking.reset()
    this.hasPose = false
    this.twin.valid = false
    this.twin.shapeLocked = false
    Object.values(this.metrics).forEach((m) => m.clear())
  }

  /** Feed a new observation from the perception layer. */
  ingest(observation) {
    if (!observation) return

    const t = observation.timestamp
    const dt = this.hasPose ? Math.max(1e-3, (t - this.lastObservationTime) / 1000) : 0

    // --- Orientation -------------------------------------------------------
    // Axis and roll filtered apart (OrientationFilter). A long gap means a new
    // hand, not a continuation, so do not smooth across it.
    if (!this.hasPose || dt > 0.4) {
      this.rotationFilter.reset()
      this.twistGate.reset()
      this.centreGate.reset()
      this.centreDeadzone.reset()
      this.rulerGate.reset()
      this._depthSettled = false
      this._warm = false
      this._steadyCount = 0
    }
    // The size became unknown mid-track (Re-measure): hide the jewellery
    // again until the wrist is measured afresh, as for a new track.
    if (this._warm && !this.geometry.sizeKnown) {
      this._warm = false
      this._steadyCount = 0
    }
    this._warmUp(observation, t)
    _prev.copy(this.quaternion)
    const smoothed = this.rotationFilter.filter(this.twistGate.filter(observation.quaternion, t), t, observation.poseConfidence)
    this.quaternion.copy(this.raw ? observation.quaternion : smoothed)
    if (this.hasPose && dt > 0 && dt <= 0.4) {
      angularVelocity(_prev, this.quaternion, dt, this.omega)
      if (this.omega.length() > 25) this.omega.setLength(25)
    } else {
      this.omega.set(0, 0, 0)
    }
    const m = _mat.makeRotationFromQuaternion(this.quaternion)
    this.basis.x.setFromMatrixColumn(m, 0)
    this.basis.y.setFromMatrixColumn(m, 1)
    this.basis.z.setFromMatrixColumn(m, 2)

    // --- Position ----------------------------------------------------------
    // Where the wrist is ON SCREEN and how FAR away it is are filtered apart.
    // The screen position comes from 2D landmarks and is precise, so it stays
    // responsive. The distance only sets the arm's scale, and is by far the
    // noisier estimate - filtered together with x and y it passed its noise
    // straight into the tube's size, which jumped. It is filtered in log
    // space (a 5 % change is a 5 % change at any distance), and harder.
    const p = this._armRulerDepth(observation)
    const depth = Math.max(50, -p.z)
    this.depthMeasurementMm = depth
    this._tmpPos[0] = p.x / depth
    this._tmpPos[1] = p.y / depth
    const smoothScreen = this.positionFilter.filter(this._tmpPos, t, this.camera.focalPx)
    const onScreen = this.raw ? this._tmpPos : smoothScreen
    // A new track starts on the palm's depth, which can be badly off (3x on
    // the side-on recording); the arm ruler corrects it, but through a
    // 0.5 Hz filter that took a quarter of a second, and the arm and every
    // bracelet on it zoomed across the screen meanwhile. The first time the
    // ruler is trusted, the depth jumps straight to it - once per track,
    // while the jewellery is still fading in.
    if (this._snapDepth && this.tracking.presence < 0.05) {
      this.depthFilter.reset()
      this._snapDepth = false
    }
    const smoothDepth = Math.exp(this.depthFilter.filter(Math.log(depth), t))
    const d = this.raw ? depth : smoothDepth
    _v.set(onScreen[0] * d, onScreen[1] * d, -d)

    if (this.hasPose && dt > 0) {
      this.velocity.subVectors(_v, this._lastFiltered).multiplyScalar(1 / dt)
      // Clamp to physically plausible hand speeds so one bad frame cannot
      // launch the prediction across the screen.
      if (this.velocity.length() > 2500) this.velocity.setLength(2500)
    } else {
      this.velocity.set(0, 0, 0)
    }
    this._lastFiltered.copy(_v)
    this.position.copy(_v)

    // --- Geometry ----------------------------------------------------------
    this.geometry.ingest(observation)
    {
      const g = this.geometry
      if (!(this._shapeW > 0) || this.tracking.presence < 0.05 || g.remembered) {
        this._shapeW = g.widthMm
        this._shapeD = g.depthMm
      } else {
        const step = SHAPE_GLIDE_MM_S * (dt > 0 ? Math.min(dt, 0.1) : 1 / 30)
        this._shapeW += clamp(g.widthMm - this._shapeW, -step, step)
        this._shapeD += clamp(g.depthMm - this._shapeD, -step, step)
      }
    }

    // The arm's centreline: ONE sideways offset from the wrist landmark to the
    // arm's measured centre, not one per ring. The arm is modelled as a
    // straight tube, so its centre is a single line; per-ring offsets let the
    // tube bend and wiggle frame to frame, and the bracelet rode the wiggle.
    // With the palm side-on MediaPipe puts the landmark on the arm's EDGE, so
    // this is ~half the arm's width - it keeps the bracelet on the arm. It is
    // taken from this frame's mask as it is (a spike that the next frame does
    // not confirm is held back), and held when a frame has no measurement. A
    // 1€ filter and a 90 mm/s glide used to follow it: sideways off the mask's
    // centreline while the arm moved, p95, 17.7 px with them, 8.3 without.
    {
      const measured = []
      // Read where the bracelet sits: if the tracked axis leans a little off
      // the arm, the offset differs along it, and the bracelet's stretch is
      // the one that has to be right.
      for (const entry of observation.profile) {
        if (entry.measured && entry.s >= CENTRE_FROM_MM && entry.s <= CENTRE_TO_MM) measured.push(entry.offsetMm)
      }
      if (!measured.length) for (const entry of observation.profile) if (entry.measured) measured.push(entry.offsetMm)
      if (measured.length) {
        measured.sort((x, y) => x - y)
        const middle = measured[measured.length >> 1]
        const target = this.centreGate.filter(middle)
        if (target !== null) this.centreOffset = this.centreDeadzone.filter(target)
        if (this.raw) this.centreOffset = middle
      }
    }
    this.sleeveLimitMm = this.sleeveFilter.filter(observation.sleeveLimitMm, t)

    this.twin.handedness = observation.handedness
    // Needed by the fit solver to decide whether a rigid bangle can pass the hand.
    this.twin.handBreadthMm += (observation.handBreadthMm - this.twin.handBreadthMm) * 0.1

    // Tracking quality is about the POSE. Shape confidence used to be folded
    // in here, which pinned every session at DEGRADED ("tracking is weak")
    // until the wrist had been measured from several angles - a sizing
    // question reported as a tracking problem. It has its own confidence.
    this.tracking.observe(clamp(observation.poseConfidence, 0, 1), t)
    this._recordMetrics(observation)

    this.lastObservationTime = t
    this.hasPose = true
  }

  /**
   * Called every render frame. Extrapolates the pose and rebuilds the twin, so
   * the jewellery is never stuck to the detector's frame rate.
   *
   * @param {number} now wall clock, ms - drives the tracking state machine
   * @param {number} dt seconds
   * @param {number} [displayTime] capture time of the video frame on screen, ms.
   *        The pose must match THE PICTURE, not the wall clock: predicting to
   *        `now` puts the bracelet ahead of an arm that is still showing the
   *        previous camera frame, which reads as the jewellery swimming.
   */
  update(now, dt, displayTime = now) {
    const state = this.tracking.update(now, dt)
    if (!this.hasPose || state === TrackingState.LOST) {
      this.twin.valid = false
      this.twin.poseConfidence = 0
      return this.twin
    }
    // No arm to wear anything on until its size is known: the solver's
    // placeholder shape is nobody's wrist. Physics seated on it was thrown
    // off the arm when the first real reading grew the arm 20 % around it.
    if (!this.geometry.sizeKnown) {
      this.twin.valid = false
      return this.twin
    }

    const ageMs = clamp(displayTime - this.lastObservationTime, 0, this.tracking.predictionBudgetMs)
    const ahead = PREDICTION_TAU_S * (1 - Math.exp(-ageMs / 1000 / PREDICTION_TAU_S))

    const twin = this.twin
    twin.center.copy(this.position).addScaledVector(this.velocity, ahead)
    integrateAngularVelocity(this.quaternion, this.omega, ahead, _q)

    const m = _mat.makeRotationFromQuaternion(_q)
    twin.quaternion.copy(_q)
    twin.radialAxis.setFromMatrixColumn(m, 0)
    twin.forearmAxis.setFromMatrixColumn(m, 1)
    twin.dorsalAxis.setFromMatrixColumn(m, 2)
    twin.creasePoint.copy(twin.center)

    // --- Shape -------------------------------------------------------------
    const g = this.geometry
    const shapeW = this._shapeW > 0 ? this._shapeW : g.widthMm
    const shapeD = this._shapeD > 0 ? this._shapeD : g.depthMm
    twin.wristWidthMm = shapeW
    twin.wristDepthMm = shapeD
    twin.circumferenceMm = g.manualCircumferenceMm || Math.abs(shapeW - g.widthMm) + Math.abs(shapeD - g.depthMm) < 0.05
      ? g.circumferenceMm
      : ellipseCircumference(shapeW / 2, shapeD / 2)
    twin.shapeLocked = g.locked
    twin.sleeveLimitMm = this.sleeveLimitMm

    // Image-plane perpendicular reconstructed in 3D: this is the direction the
    // silhouette offsets were measured along, i.e. image (-dy, dx) for an arm
    // running along image (dx, dy). World y is image -y, which makes that
    // VIEW x axis, not axis x VIEW: the reverse order applied every centreline
    // correction mirrored, pushing a side-on bracelet off the arm's edge.
    _perp.crossVectors(VIEW_DIR, twin.forearmAxis)
    if (_perp.lengthSq() < 1e-8) _perp.copy(twin.radialAxis)
    else _perp.normalize()

    // The procedural arm: a straight elliptical tube of fixed length whose
    // only shape parameters are the wrist's width and depth (measured, then
    // frozen), widening up the arm at the measured anatomical rate. Nothing
    // else about its shape is taken from any single frame, so the tube can
    // only move rigidly with the arm - it cannot flex, bulge or wobble.
    const aRef = shapeW / 2
    const bRef = shapeD / 2
    const refTaper = 1 + REFERENCE_S_MM * FOREARM_TAPER_PER_MM
    for (let i = 0; i < twin.crossSections.length; i++) {
      const sec = twin.crossSections[i]
      const s = SECTION_S[i]
      const ratio = (1 + s * FOREARM_TAPER_PER_MM) / refTaper
      sec.s = s
      sec.a = aRef * ratio
      sec.b = bRef * ratio
      sec.confidence = g.geometryConfidence
      sec.center
        .copy(twin.creasePoint)
        .addScaledVector(twin.forearmAxis, s)
        .addScaledVector(_perp, this.centreOffset)
    }

    twin.poseConfidence = this.tracking.confidence
    twin.geometryConfidence = g.geometryConfidence
    twin.sizingConfidence = g.sizingConfidence
    twin.occlusionConfidence = clamp(
      (this.sleeveLimitMm === Infinity ? 1 : 0.6) * (g.geometryConfidence * 0.5 + 0.5),
      0,
      1,
    )
    twin.valid = true
    return twin
  }

  /**
   * The wrist point, with its depth steadied by the arm itself.
   *
   * The observer's depth comes from the palm's size in pixels, re-measured
   * every frame from landmarks - and every wobble in that re-measurement made
   * the rendered arm and the bracelet breathe (+-20 % on the recordings,
   * 1.2x too big on average). The arm's fitted outlines give its width in
   * pixels, measured over dozens of rows and far steadier. With the wrist's
   * cross-section known in mm, that pixel width fixes the depth:
   *
   *   depth = f * apparentWidthMm / widthPx
   *
   * where the apparent width is the ellipse's extent across the image at the
   * current roll. The two depths are blended in log space by the outline fit's
   * confidence. Moving the point along its own camera ray keeps it on the same
   * pixel, so only scale changes. Sizing is untouched: the wrist's millimetres
   * are still measured on the palm's scale, so the two stay independent.
   */
  _armRulerDepth(observation) {
    const p = observation.creasePoint
    const depthPalm = -p.z
    if (!(depthPalm > 50)) return p
    const widthPx = observation.armWidthPx
    // No outline this frame: keep applying the correction the ruler last
    // established, rather than snapping back to the palm's depth - switching
    // between the two was itself a visible pulse.
    if (!(widthPx > 0) || !this.hasPose) {
      if (!this._rulerLog) return p
      return this._rulerPoint.copy(p).multiplyScalar(Math.exp(this._rulerLog))
    }
    const g = this.geometry
    const station = observation.armWidthStationMm ?? 20
    const ratio = (1 + station * FOREARM_TAPER_PER_MM) / (1 + REFERENCE_S_MM * FOREARM_TAPER_PER_MM)
    // The shape the tube is drawn with (glided), so the drawn arm keeps the
    // measured pixel width while the shape estimate refines.
    const a = ((this._shapeW > 0 ? this._shapeW : g.widthMm) / 2) * ratio
    const b = ((this._shapeD > 0 ? this._shapeD : g.depthMm) / 2) * ratio
    // The filtered frame, not this observation's: the apparent width depends
    // on the roll, and a jittery roll became a jittery depth.
    const basis = this.basis
    _perp.crossVectors(VIEW_DIR, basis.y)
    if (_perp.lengthSq() < 1e-6) return p
    _perp.normalize()
    const apparentMm = 2 * Math.hypot(a * basis.x.dot(_perp), b * basis.z.dot(_perp))
    const depthArm = (this.camera.focalPx * apparentMm) / widthPx
    if (!(depthArm > 50 && depthArm < 3000)) return p
    // A reading far from the last one waits for the next outline to agree;
    // meanwhile the correction already established stands, as between outlines.
    const reading = Math.log(depthArm / depthPalm)
    if (!this.raw && this.rulerGate.filter(reading) !== reading) {
      if (!this._rulerLog) return p
      return this._rulerPoint.copy(p).multiplyScalar(Math.exp(this._rulerLog))
    }
    // Trust the ruler by the outline fit's confidence only. An unfinished
    // wrist-shape estimate does not argue for the palm's depth instead: with
    // the ruler the rendered arm matches the arm on screen whatever the shape
    // estimate, and only the ring-to-arm proportion inherits its error - as
    // it would with the palm's depth too.
    const w = clamp(observation.armWidthConfidence * ARM_RULER_GAIN, 0, ARM_RULER_MAX)
    const correction = w * reading
    if (!this._depthSettled && w >= RULER_SNAP_WEIGHT) {
      this._depthSettled = true
      this._snapDepth = true
    }
    this._rulerLog = this._rulerLog && !this.raw ? this._rulerLog + (correction - this._rulerLog) * 0.6 : correction
    return this._rulerPoint.copy(p).multiplyScalar(Math.exp(correction))
  }

  /**
   * Hold a new track hidden until it is steady, then start the pose filters
   * afresh from that moment, so the jewellery appears where the arm IS
   * rather than gliding in from wherever the lock-on frames left it.
   */
  _warmUp(observation, t) {
    const palmDepth = -observation.creasePoint.z
    const steady =
      observation.poseConfidence >= WARMUP_MIN_CONFIDENCE &&
      observation.handedness === this._lastHandedness &&
      this._lastPalmDepth > 0 &&
      palmDepth > 0 &&
      Math.abs(Math.log(palmDepth / this._lastPalmDepth)) < WARMUP_MAX_DEPTH_STEP
    this._lastHandedness = observation.handedness
    this._lastPalmDepth = palmDepth
    if (this._warm) return
    this._steadyCount = steady ? this._steadyCount + 1 : 0
    this.tracking.hold = true
    if (this._steadyCount < WARMUP_FRAMES || !this.geometry.sizeKnown) return
    this._warm = true
    this.tracking.hold = false
    this.positionFilter.reset()
    this.depthFilter.reset()
    this.rotationFilter.reset()
    this.twistGate.reset()
    this.centreGate.reset()
    this.centreDeadzone.reset()
    this.rulerGate.reset()
    this.hasPose = false // no velocity or spin across the restart
  }

  get presence() {
    return this.tracking.presence
  }

  get state() {
    return this.tracking.state
  }

  _recordMetrics(observation) {
    // Only meaningful while the user is holding still: that is when jitter is
    // visible and when it is entirely our fault.
    const stationary = this.velocity.length() < 45 && this.omega.length() < 0.35
    if (!stationary) {
      this._lastProjected = null
      this._lastWidth = 0
      return
    }
    const proj = this.camera.project(this.position, { x: 0, y: 0 })
    if (this._lastProjected) {
      this.metrics.positionJitterPx.push(
        Math.hypot(proj.x - this._lastProjected.x, proj.y - this._lastProjected.y),
      )
      const dot = clamp(Math.abs(this.quaternion.dot(this._lastQuatForJitter)), 0, 1)
      this.metrics.rotationJitterDeg.push(THREE.MathUtils.radToDeg(2 * Math.acos(dot)))
      if (this._lastWidth > 0) {
        this.metrics.scaleBreathingPct.push(
          (Math.abs(this.geometry.widthMm - this._lastWidth) / this._lastWidth) * 100,
        )
      }
    }
    this._lastProjected = proj
    this._lastQuatForJitter.copy(this.quaternion)
    this._lastWidth = this.geometry.widthMm
  }
}

const SECTION_S = [0, 9, 18, 28, 40, 54, 70, 88]
