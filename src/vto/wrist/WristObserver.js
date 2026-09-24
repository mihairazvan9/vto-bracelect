import * as THREE from 'three'
import { clamp, orthonormalBasis, quaternionFromBasis, smoothstep } from '../core/mathUtils.js'
import { ForearmEstimator } from './ForearmEstimator.js'
import { ArmProfiler } from './ArmProfiler.js'
import { OneEuroFilter } from '../core/OneEuroFilter.js'

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _palm = new THREE.Vector3()
const _thumb = new THREE.Vector3()
const _fit = new THREE.Vector3()
const _swing = new THREE.Quaternion()
const _silDir = new THREE.Vector3()
const _silNormal = new THREE.Vector3()
const _silEnd = new THREE.Vector3()

/** Arc lengths (mm from the wrist crease) at which we measure the forearm. */
const SECTION_S = [0, 9, 18, 28, 40, 54, 70, 88]

/**
 * Sizing is driven by PALM LENGTH — the wrist-to-knuckle span — never by the
 * span across the knuckles.
 *
 * The across-the-knuckles span is transverse: splaying the fingers fans the
 * metacarpals and MediaPipe amplifies it, so a wrist sized from it visibly grows
 * when the hand opens and shrinks when the fingers close. Wrist-to-knuckle runs
 * along the hand and is nearly invariant to finger pose.
 */
/**
 * Wrist breadth over the mean wrist-to-knuckle span, measured on the SAM
 * reference masks of the recordings: 0.79 face-on, 0.75 through a roll, 0.65
 * edge-on (that view shows wrist depth). 0.6 was a guess, and it made the arm
 * profiler reject real side-on arms as implausibly wide.
 */
const WRIST_BREADTH_PER_PALM = 0.6
const HAND_BREADTH_PER_PALM = 0.88
/**
 * How fast the forearm widens going up the arm, per mm. Measured on the SAM
 * reference masks of the recordings: ~+3 % at 70 mm and ~+5 % at 88 mm
 * relative to 18 mm; the earlier 0.0022 (+11 % at 70 mm) was a guess.
 */
const FOREARM_TAPER_PER_MM = 0.0006

/**
 * Below this the bone is pointing at the camera and the foreshortening
 * correction would divide by almost nothing.
 */
const MIN_FORESHORTEN = 0.38

/** How many frames of palm length to hold for the median. */
const PALM_WINDOW = 15

/**
 * Beyond this the silhouette disagrees with the hand so violently that we are
 * almost certainly tracking something that is not the forearm: the wrist
 * cannot bend that far.
 */
const MAX_FOREARM_CORRECTION_RAD = (80 * Math.PI) / 180

/** Below this the forearm points at the camera and its image angle is noise. */
const IN_PLANE_FADE_START = 0.25
const IN_PLANE_FADE_END = 0.6

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

/**
 * Measure the forearm only this far below the wrist. The bracelet lives in the
 * first ~50 mm, the skin there is the cleanest, and further down the mask
 * degrades (hair, shadow, the torso behind) - on the back-of-hand recording it
 * gave out 1-1.5 palm lengths down. Chosen by sweep, see tools/eval.
 */
const ARM_REACH_MM = 100

/**
 * Anatomical forearm widening, d ln(width)/ds per mm, measured on the SAM
 * reference masks (~+3 % from 18 to 70 mm). Used to read the arm's tilt in
 * depth from its apparent taper.
 */
const ARM_TAPER_LOG_PER_MM = 0.0006
/** Stations the tilt is read between (mm below the wrist), and the least usable spread. */
const PITCH_S1_MM = 12
const PITCH_S2_MM = 75
const PITCH_MIN_BASELINE_MM = 35
/** A forearm leaning more than ~45 deg in depth is not measurable this way. */
const PITCH_MAX_SIN = 0.7
/** Averaging time of the tilt reading, seconds. */
const PITCH_TAU_S = 0.6

/**
 * The procedural arm tube's extent: from this far onto the hand (the
 * occluder's extra ring) to this far up the forearm (its last section).
 */
const ARM_TUBE_LENGTH_MM = 92
const ARM_TUBE_BACK_MM = 4 // the tube's hand-end lip (physics/walls.js TUBE_START_MM)

/** Where down the arm its apparent width is read as a depth ruler, mm. */
const ARM_WIDTH_STATION_MM = 20

/** Palm landmarks that must sit on skin for the mask to describe this frame. */
const MASK_CHECK_LANDMARKS = [0, 1, 5, 9, 13, 17]
const MASK_CHECK_OFFSETS = [0, 0, 4, 0, -4, 0, 0, 4, 0, -4]

/** Scale lock: palm normal within ~40 deg of the view axis, landmarks agreeing. */
const SCALE_FRONTAL_MIN = 0.75
const SCALE_MAX_REL_RESIDUAL = 0.12
const SCALE_MIN_SAMPLES = 5
const SCALE_WINDOW = 90
/** Wrist-to-knuckle span of adult hands, mm: the bounds before the lock. */
const PALM_MM_MIN = 60
const PALM_MM_MAX = 90
/** A locked scale ignores samples further than this from it (fraction). */
const SCALE_MAX_DEVIATION = 0.2

/**
 * The palm's size in millimetres, from MediaPipe's metric scale AND from what
 * adult palms are. MediaPipe's scale is a learned guess, not a measurement:
 * the same hand, camera and day read a wrist-to-knuckle span of 68-104 mm
 * over nine recorded sessions (log SD 0.14), and every millimetre of the arm
 * follows it - a 119 mm wrist in one session, 180 mm in another, and a real
 * 180 mm bangle drawn 1.6x as wide as the arm in the first. Adult palms vary
 * about half as much (log SD ~0.065), so the two are combined as independent
 * log-normal estimates: one session's reading gets ~18 % of the weight, more
 * as remembered sessions average its noise down. A tape-measured wrist
 * (GeometrySolver.setManualCircumference) overrides all of it.
 */
const PALM_PRIOR_MM = 82
const PALM_PRIOR_LOG_SD = 0.065
const PALM_SESSION_LOG_SD = 0.14

/** Palm length (mm) believed from MediaPipe's reading over `sessions` sessions. */
export function palmFromScale(rawMm, sessions = 1) {
  if (!(rawMm > 0)) return 0
  const vp = PALM_PRIOR_LOG_SD * PALM_PRIOR_LOG_SD
  const vm = (PALM_SESSION_LOG_SD * PALM_SESSION_LOG_SD) / Math.max(1, sessions)
  const w = vp / (vp + vm)
  return Math.exp(w * Math.log(rawMm) + (1 - w) * Math.log(PALM_PRIOR_MM))
}

/** How fast the wrist anchor follows the 2D landmark's offset from the fit. */
const ANCHOR_TAU_S = 0.035
/** Largest offset change believed per frame, as a fraction of palm length. */
const ANCHOR_MAX_STEP_PER_PALM = 0.25

/** Residual beyond which a landmark is treated as an outlier, in pixels. */
const HUBER_PX = 6

/** Rigid palm edges for the robust scale: along the hand and across it. */
const PALM_EDGES = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 13], [5, 17], [9, 17]]

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Median absolute deviation of a sorted-or-not array about `centre`. */
function madSorted(values, centre) {
  const dev = values.map((v) => Math.abs(v - centre)).sort((x, y) => x - y)
  return median(dev)
}

function median(sorted) {
  const n = sorted.length
  const mid = n >> 1
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5
}

/**
 * Turns one frame of detection into a metric observation of the wrist.
 *
 * It consumes a normalised landmark source rather than a detector directly, so
 * the input can be changed without touching this file. It produces measurements
 * with error bars, not a final pose; the temporal solver decides what to
 * believe.
 */
export class WristObserver {
  constructor(cameraModel) {
    this.camera = cameraModel
    /** The forearm frame: what the bracelet sits on. */
    this.basis = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() }
    this.quaternion = new THREE.Quaternion()
    /** The hand frame, straight from the landmarks. Evidence, not the answer. */
    this.handBasis = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() }
    this.handQuaternion = new THREE.Quaternion()
    this.forearm = new ForearmEstimator()
    this.armProfiler = new ArmProfiler()
    /** How far down the forearm the silhouette is measured, mm. */
    this.armReachMm = ARM_REACH_MM
    /** This frame's arm measurement, or null when the silhouette gave none. */
    this.armProfile = null
    this._hand = { axis: this.handBasis.y, quaternion: this.handQuaternion }
    this._sil = {
      normal: _silNormal, direction: _silDir, confidence: 0,
      /** Tilt away from the camera measured from perspective taper (sin), and its confidence. */
      pitchSin: 0, pitchConfidence: 0, ray: new THREE.Vector3(),
    }
    this.profile = SECTION_S.map((s) => ({
      s,
      halfWidthMm: 0,
      offsetMm: 0,
      measured: false,
      confidence: 0,
    }))
    this.imageAxis = { dx: 0, dy: 1, perpX: -1, perpY: 0 }
    /** Source landmarks placed in world space by the solved translation. */
    this.landmarks3D = []
    this._depthVotes = new Float64Array(256)
    this._translation = new THREE.Vector3()
    this._creasePoint = new THREE.Vector3()
    this._creasePx = { x: 0, y: 0 }
    this._palmSamples = []
    this._palmFilter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.004, dCutoff: 1.0 })
    /** Diagnostic: use each frame's palm size unsmoothed (see WristTracker.raw). */
    this.raw = false
    this._forearmPx = { x: 0, y: 0 }
    this._fittedPx = { x: 0, y: 0 }
    /** 2D wrist landmark minus rigid-fit wrist, low-passed. Pixels. */
    this._anchorOffset = { x: 0, y: 0, t: -Infinity, valid: false }
    /** Locked metric palm length (see _updateScaleLock). */
    this._scale = { samples: [], prior: [], value: 0, remembered: null }
  }

  /**
   * Palm length is held in pixels, so it is only valid for one camera and
   * resolution. Flipping cameras must flush it rather than blend across.
   */
  reset() {
    this._palmSamples.length = 0
    this._palmFilter.reset()
    this._scale.samples.length = 0
    this._scale.prior.length = 0
    this._scale.value = 0
    this._edgeRatios = null
    this._anchorOffset.valid = false
    this.forearm.reset()
  }

  /**
   * MediaPipe's palm reading averaged over this person's earlier sessions on
   * this device (raw mm, see palmFromScale), or null. The palm it implies
   * stands in for this session's own, so a returning person gets the same
   * wrist size every time (see _updateScaleLock). This session's reading is
   * still taken, to be folded into the memory.
   */
  setRememberedPalm(rawMm, sessions = 1) {
    this._scale.remembered = Number.isFinite(rawMm) && rawMm > 40 && rawMm < 160
      ? palmFromScale(rawMm, sessions)
      : null
  }

  /**
   * The palm: `mm` as used for sizing, `rawMm` this session's own MediaPipe
   * reading (what is remembered), and how many good frames support it.
   */
  get palmScale() {
    const lock = this._scale
    const locked = lock.samples.length >= SCALE_MIN_SAMPLES
    return {
      mm: lock.remembered ?? palmFromScale(lock.value),
      rawMm: locked ? lock.value : 0,
      samples: lock.samples.length,
      locked,
    }
  }

  /**
   * The person's palm length in mm: a robust median of well-measured frames,
   * combined with what adult palms are (palmFromScale). A palm remembered
   * from earlier sessions on this device (setRememberedPalm) stands instead:
   * MediaPipe's scale is steady within a session but not between sessions of
   * the same hand, so remembering is what makes a returning person the same
   * size. This session's frames are still read, for the memory.
   */
  _updateScaleLock(rawPalmMm, frontal, relResidual) {
    const lock = this._scale
    const good = rawPalmMm > 40 && rawPalmMm < 160 &&
      frontal > SCALE_FRONTAL_MIN && relResidual < SCALE_MAX_REL_RESIDUAL
    // Once the lock holds, a "good" frame far from it is not news about the
    // hand: mid-roll frames on the recordings read 108-115 mm against a
    // 70 mm lock while still passing the frontal test.
    const consistent = lock.samples.length < SCALE_MIN_SAMPLES ||
      Math.abs(rawPalmMm / lock.value - 1) < SCALE_MAX_DEVIATION
    if (good && consistent) {
      lock.samples.push(rawPalmMm)
      if (lock.samples.length > SCALE_WINDOW) lock.samples.shift()
      lock.value = median(Float64Array.from(lock.samples).sort())
    }
    if (lock.remembered) return lock.remembered
    if (lock.samples.length >= SCALE_MIN_SAMPLES) return palmFromScale(lock.value)

    // Not locked yet (the palm may never have faced the camera). Single
    // frames then swing 48-94 mm on a side-on clip, so hold a running median
    // of them, kept inside what an adult palm can be.
    if (rawPalmMm > 0) {
      lock.prior.push(Math.min(PALM_MM_MAX, Math.max(PALM_MM_MIN, rawPalmMm)))
      if (lock.prior.length > SCALE_WINDOW) lock.prior.shift()
    }
    return lock.prior.length ? palmFromScale(median(Float64Array.from(lock.prior).sort())) : 0
  }

  /**
   * Track the offset from the rigid-fit wrist to the 2D wrist landmark.
   *
   * The offset is shape bias, which changes with pose, i.e. smoothly; a
   * detector glitch on landmark 0 changes it in one frame. So it follows the
   * landmark with a short time constant, and a jump larger than a fraction of
   * the palm moves it only by a bounded step until the landmark proves it
   * meant it by staying there.
   */
  _updateAnchorOffset(wristPx, fittedPx, palmLengthPx, t) {
    const o = this._anchorOffset
    const dx = wristPx.x - fittedPx.x
    const dy = wristPx.y - fittedPx.y
    const dt = (t - o.t) / 1000
    o.t = t
    if (!o.valid || !(dt > 0) || dt > 0.4) {
      o.x = dx
      o.y = dy
      o.valid = true
      return
    }
    let ex = dx - o.x
    let ey = dy - o.y
    const jump = Math.hypot(ex, ey)
    const maxStep = Math.max(4, palmLengthPx * ANCHOR_MAX_STEP_PER_PALM)
    if (jump > maxStep) {
      ex *= maxStep / jump
      ey *= maxStep / jump
    }
    const k = 1 - Math.exp(-dt / ANCHOR_TAU_S)
    o.x += ex * k
    o.y += ey * k
  }

  /**
   * @param {object|null} source from LandmarkSourceBuilder
   * @returns {object|null} observation, or null when there is no usable input.
   */
  observe(source, perception, timestamp) {
    if (!source) return null
    this.source = source
    this._now = timestamp

    const cam = this.camera
    const world = source.world
    const px = source.px
    const key = source.key

    const W0 = world[key.wrist]
    const WI = world[key.index]
    const WP = world[key.pinky]
    if (!W0 || !WI || !WP) return null

    // --- Position, from the 2D landmarks -----------------------------------
    // Division of labour: the 2D image landmarks carry position, the 3D world
    // landmarks carry rotation. The image landmarks are what actually aligns
    // with the pixels the user sees; the world landmarks are a learned metric
    // prior whose absolute translation is not trustworthy.
    const solve = this._solveTranslation(source)
    if (!solve) return null

    // --- Size, from the 2D landmarks ---------------------------------------
    // Measured in pixels and converted with mmPerPx, so the rendered size is
    // depth-independent: the depth term cancels between the measurement and the
    // projection. Sizing from an absolute world-landmark length would not
    // cancel, and would inherit every wobble in that estimate.
    this._palmTime = timestamp
    const palmLengthPx = this._palmLengthPx(source)
    if (!(palmLengthPx > 0)) return null

    // --- Scale lock --------------------------------------------------------
    // A hand's size in millimetres is a constant of the person. The per-frame
    // depth solve is not: on a recorded wrist roll it swung 0.33 -> 0.60 mm/px
    // in 100 ms, i.e. the hand "doubled its distance" mid-turn, because
    // MediaPipe's 3D cloud is least accurate exactly while the hand rotates.
    // So the hand's metric size is learned from frames where it is measured
    // well (palm facing the camera, landmarks agreeing) and then HELD, and
    // each frame's depth follows from it and the measured pixel size.
    const rawPalmMm = palmLengthPx * solve.mmPerPx
    _c.crossVectors(_a.copy(WI).sub(W0), _b.copy(WP).sub(W0))
    const frontal = _c.lengthSq() > 1e-6 ? Math.abs(_c.normalize().z) : 0
    // Residual relative to the hand's size: MediaPipe's 3D and 2D landmarks
    // never agree to better than ~10 px, so an absolute gate would never pass.
    const relResidual = solve.residualPx / palmLengthPx
    const lockedPalmMm = this._updateScaleLock(rawPalmMm, frontal, relResidual)
    const mmPerPx = lockedPalmMm > 0 ? lockedPalmMm / palmLengthPx : solve.mmPerPx
    // Depth uses THIS frame's palm size, not the median-smoothed one the
    // sizing uses: real motion toward the camera must show up now (the joint
    // model reads wrist velocity), and the pose filter handles the jitter.
    const depthMm = lockedPalmMm > 0 && this._palmNowPx > 0
      ? (lockedPalmMm / this._palmNowPx) * cam.focalPx
      : mmPerPx * cam.focalPx
    const palmLengthMm = palmLengthPx * mmPerPx
    const handBreadthMm = palmLengthMm * HAND_BREADTH_PER_PALM

    // --- Wrist anchor ------------------------------------------------------
    // The rigid solve alone is NOT where the wrist is on screen. MediaPipe's 3D
    // cloud and its 2D landmarks disagree in shape by ~10 px across the palm,
    // and on recorded clips that put the fitted wrist 14-40 px (p50) off the
    // 2D wrist landmark - the bracelet visibly sat beside the arm. The 2D
    // landmark is what aligns with the picture, so the anchor follows it, at
    // the solved depth. The rigid fit still guards it: the offset between the
    // two is a slowly varying shape bias, so it is low-passed and a sudden
    // jump - one bad wrist detection - is let through only a little.
    const fitted = this._creasePoint.addVectors(W0, solve.translation)
    const fittedPx = cam.project(fitted, this._fittedPx)
    this._updateAnchorOffset(px[key.wrist], fittedPx, palmLengthPx, timestamp)
    const creasePx = this._creasePx
    creasePx.x = fittedPx.x + this._anchorOffset.x
    creasePx.y = fittedPx.y + this._anchorOffset.y
    // At the locked-scale depth. The fit's own depth (-fitted.z) is the one
    // that swings during a roll.
    const wristDepth = depthMm + (-fitted.z - solve.depthMm)
    const creasePoint = cam.unproject(creasePx.x, creasePx.y, wristDepth, this._creasePoint)

    // Whole source set in world space, for the debug overlay.
    while (this.landmarks3D.length < world.length) this.landmarks3D.push(new THREE.Vector3())
    for (let i = 0; i < world.length; i++) {
      this.landmarks3D[i].addVectors(world[i], solve.translation)
    }

    // --- Anatomical frame, from the 3D landmarks ---------------------------
    // Orientation comes entirely from world landmarks: they are metric and free
    // of perspective foreshortening, so the frame stays stable as the hand
    // moves toward or away from the camera.
    // Hand axis: palm centre -> wrist, i.e. the direction the forearm would
    // take if the wrist were straight. The mean of all four metacarpal heads
    // runs along the third metacarpal, which lines up with the radius.
    _palm.set(0, 0, 0)
    for (const i of source.palmCentre) _palm.add(world[i])
    _palm.multiplyScalar(1 / source.palmCentre.length)
    _a.copy(W0).sub(_palm)
    if (_a.lengthSq() < 1e-6) return null
    _a.normalize()

    // Radial axis: ulnar (pinky) -> radial (thumb) side. Anatomically stable
    // and identical for left and right hands.
    const hand = this.handBasis
    const radialHint = _b.copy(WI).sub(WP)
    orthonormalBasis(_a, radialHint, hand)

    // Dorsal sign from anatomy rather than from a handedness label: the thumb
    // sits on the palmar side, so its out-of-plane component tells us which way
    // the back of the hand faces. This stays correct through mirroring,
    // handedness mislabels and left/right swaps.
    _thumb.copy(world[key.thumb]).sub(W0)
    if (_thumb.dot(hand.z) > 0) {
      hand.z.negate()
      hand.x.negate() // keep the basis right-handed
    }
    // Cross-check against the palm-plane normal; disagreement means an
    // ambiguous, near-edge-on view and should lower confidence, not flip us.
    _c.crossVectors(_a.copy(WI).sub(W0), _b.copy(WP).sub(W0))
    const dorsalAgreement = _c.lengthSq() > 1e-6 ? Math.abs(_c.normalize().dot(hand.z)) : 0
    quaternionFromBasis(hand, this.handQuaternion)

    // --- Forearm direction -------------------------------------------------
    // The hand frame is evidence, not the answer: the wrist is a joint, and
    // the bracelet sits on the far side of it. The silhouette search is seeded
    // from where the forearm WAS rather than from the hand, so a bent wrist
    // does not send the search off the arm.
    const seed = this.forearm.valid ? this.forearm.direction : hand.y
    const silhouette = this._silhouetteConstraint(perception, creasePoint, creasePx, mmPerPx, palmLengthMm, depthMm, seed)
    const forearmDir = this.forearm.update(this._hand, silhouette, creasePoint, timestamp)

    // --- Forearm frame: the hand frame with the joint's swing removed ------
    // Twist about the arm survives the swing, which is right: the distal
    // forearm rolls with the hand. Flexion and deviation do not.
    _swing.setFromUnitVectors(hand.y, forearmDir)
    this.basis.x.copy(hand.x).applyQuaternion(_swing)
    this.basis.y.copy(forearmDir)
    // Re-orthogonalise against accumulated float error, then close the basis.
    this.basis.x.addScaledVector(this.basis.y, -this.basis.x.dot(this.basis.y)).normalize()
    this.basis.z.crossVectors(this.basis.x, this.basis.y).normalize()
    quaternionFromBasis(this.basis, this.quaternion)

    // Joint angles, hand relative to forearm, for diagnostics. Positive
    // flexion bends the palm toward its own palmar side.
    const along = forearmDir.dot(hand.y)
    const flexDeg = THREE.MathUtils.radToDeg(Math.atan2(-forearmDir.dot(hand.z), along))
    const deviationDeg = THREE.MathUtils.radToDeg(Math.atan2(forearmDir.dot(hand.x), along))
    const jointDeg = THREE.MathUtils.radToDeg(forearmDir.angleTo(hand.y))

    // Roll: angle between the view direction and the dorsal axis. 0 = looking at
    // the back of the hand (we see wrist width), 90 deg = edge-on (we see wrist
    // depth). This is the variable the multi-view solve needs to vary.
    const rollTheta = Math.acos(clamp(Math.abs(this.basis.z.z), 0, 1))

    // --- Silhouette profile ------------------------------------------------
    const maskInfo = this._measureProfile(perception, creasePx, creasePoint, mmPerPx, palmLengthMm)

    // --- Confidence --------------------------------------------------------
    const scaleSanity = clamp((palmLengthPx - 40) / 80, 0, 1)
    const depthSanity = depthMm > 120 && depthMm < 1500 ? 1 : 0.3
    // Mean reprojection error of the pose fit: a frame whose landmarks cannot
    // agree on one rigid pose is a frame we should not trust. Judged relative
    // to the hand's size: MediaPipe's 3D and 2D landmarks never agree better
    // than ~10 px on a real hand, so an absolute threshold condemned every
    // frame and pinned tracking at DEGRADED.
    const fitAgreement = 0.55 + 0.45 * clamp(1 - relResidual / 0.15, 0, 1)
    const poseConfidence = clamp(
      source.handednessScore *
        source.quality *
        (0.55 + 0.45 * dorsalAgreement) *
        (0.5 + 0.5 * scaleSanity) *
        depthSanity *
        fitAgreement,
      0,
      1,
    )

    return {
      timestamp,
      origin: source.origin,
      handedness: source.handedness,
      mmPerPx,
      depthMm,
      handBreadthMm,
      palmLengthMm,
      creasePoint,
      creasePx,
      basis: this.basis,
      quaternion: this.quaternion,
      rollTheta,
      dorsalAgreement,
      handBasis: this.handBasis,
      handQuaternion: this.handQuaternion,
      forearmCorrectionDeg: jointDeg,
      forearmFromSilhouette: this.forearm.fromSilhouette,
      silhouetteConfidence: silhouette ? silhouette.confidence : 0,
      wristFlexDeg: flexDeg,
      wristDeviationDeg: deviationDeg,
      /** 0 = hand motion read as the wrist bending, 1 = as the arm moving. */
      armMotion: this.forearm.carry,
      reprojectionPx: solve.residualPx,
      profile: this.profile,
      imageAxis: this.imageAxis,
      measuredSections: maskInfo.measuredCount,
      sleeveLimitMm: maskInfo.sleeveLimitMm,
      maskAvailable: maskInfo.available,
      poseConfidence,
      /** Whether the hand's metric size is locked (see _updateScaleLock). */
      scaleLocked: this._scale.samples.length >= SCALE_MIN_SAMPLES,
      /**
       * The arm's apparent width in pixels at ARM_WIDTH_STATION_MM, from the
       * fitted outlines (0 when both outlines were not measured). A pixel
       * measurement, independent of any metric scale: the tracker uses it as a
       * ruler for depth.
       */
      ...this._armWidth(),
      /** The measured arm corridor in display pixels, or null. */
      armOverlay: this._armOverlay(creasePx),
      /** The factors poseConfidence is the product of, for diagnostics. */
      confidenceParts: {
        handedness: source.handednessScore,
        dorsal: 0.55 + 0.45 * dorsalAgreement,
        scale: 0.5 + 0.5 * scaleSanity,
        depth: depthSanity,
        fit: fitAgreement,
      },
      landmarksPx: px,
      landmarks3D: this.landmarks3D,
      landmarkCount: world.length,
      key,
    }
  }

  /**
   * What the arm silhouette says about the forearm direction, as a constraint
   * the forearm estimator can apply.
   *
   * A silhouette carries no depth, so it cannot say whether the forearm tilts
   * toward or away from the camera. What it does fix is the arm's line in the
   * image, and every 3D direction that projects onto that line lies in one
   * plane through the camera centre. That plane is the constraint. It is exact
   * under perspective, unlike rotating about the optical axis, which is only
   * right for an arm in the middle of the frame.
   *
   * @param {THREE.Vector3} seed 3D direction to start the search along
   * @returns {{normal:THREE.Vector3, direction:THREE.Vector3, confidence:number}|null}
   */
  _silhouetteConstraint(perception, creasePoint, creasePx, mmPerPx, palmLengthMm, depthMm, seed) {
    const cam = this.camera
    const halfWidth = (palmLengthMm * WRIST_BREADTH_PER_PALM) / 2
    this.armProfile = null

    const seedPx = this._imageDirection(creasePoint, creasePx, seed)
    if (!seedPx || !perception.armMask) return null
    // A mask that does not have skin under the hand describes some other
    // moment - segmentation runs slower than the hand moves. Measuring the
    // arm from it would place the forearm where the hand used to be.
    if (!this._maskCoversHand(perception)) return null

    const fit = this.armProfiler.measure(
      this._sampler(perception), creasePx, seedPx.dx, seedPx.dy, mmPerPx, halfWidth,
      { reachMm: this.armReachMm },
    )
    this.armProfile = fit
    if (!fit || fit.confidence < 0.15) return null

    // The wrist can only bend so far. A silhouette further than that from the
    // hand is some other skin - a face, the other arm - not this forearm.
    const handPx = this._imageDirection(creasePoint, creasePx, this.handBasis.y)
    if (handPx) {
      const delta = wrapAngle(Math.atan2(fit.dy, fit.dx) - Math.atan2(handPx.dy, handPx.dx))
      if (Math.abs(delta) > MAX_FOREARM_CORRECTION_RAD) return null
    }

    // Fade out as the forearm turns toward the camera, where its image angle
    // stops meaning anything.
    const visibility = smoothstep(IN_PLANE_FADE_START, IN_PLANE_FADE_END, seedPx.inPlane)
    const confidence = fit.confidence * visibility
    if (confidence < 0.05) return null

    // Lift the image line back into 3D at the wrist's depth.
    cam.unproject(creasePx.x + fit.dx * 40, creasePx.y + fit.dy * 40, depthMm, _silEnd)
    _silDir.subVectors(_silEnd, creasePoint).normalize()
    _silNormal.crossVectors(creasePoint, _silEnd)
    if (_silNormal.lengthSq() < 1e-9) return null
    _silNormal.normalize()

    this._sil.confidence = confidence
    this._measurePitch(fit, depthMm, creasePoint)
    return this._sil
  }

  /**
   * The arm's tilt toward/away from the camera, from perspective.
   *
   * The outlines fix the arm's direction across the image exactly, but not
   * its tilt in depth - that was left to the hand and a slow prior, and on
   * the recordings the rendered forearm narrowed 5-16 % toward the elbow that
   * the real one did not: a tracked tilt of ~15-20 deg away that was not there.
   * Perspective measures it. An arm leaning away gets narrower with distance
   * faster than its anatomy widens it:
   *
   *   d ln(width)/ds = taper - sin(tilt) / depth
   *
   * With the anatomical taper measured on the reference masks, the apparent
   * taper between two stations of the fitted outlines gives the tilt.
   */
  _measurePitch(arm, depthMm, creasePoint) {
    const sil = this._sil
    sil.pitchConfidence = 0
    if (!arm.lines || !arm.bothSides) return
    const s1 = PITCH_S1_MM
    const s2 = Math.min(arm.reachMm, PITCH_S2_MM)
    if (s2 - s1 < PITCH_MIN_BASELINE_MM) return
    const L = arm.lines
    const w1 = L.ra - L.la + (L.rb - L.lb) * s1
    const w2 = L.ra - L.la + (L.rb - L.lb) * s2
    if (!(w1 > 0) || !(w2 > 0)) return
    const apparent = Math.log(w2 / w1) / (s2 - s1)
    const raw = clamp(depthMm * (ARM_TAPER_LOG_PER_MM - apparent), -PITCH_MAX_SIN, PITCH_MAX_SIN)
    // Each frame's reading is noisy (a pixel of width error is a few degrees
    // of tilt) while a forearm's tilt changes slowly, so it is averaged over
    // PITCH_TAU_S. Fed raw, it multiplied axis jitter ~8x on the recordings.
    const t = this._pitchTime
    const dt = Number.isFinite(t) ? (this._now - t) / 1000 : Infinity
    this._pitchSmoothed = dt > 0.5 || !Number.isFinite(this._pitchSmoothed)
      ? raw
      : this._pitchSmoothed + (raw - this._pitchSmoothed) * (1 - Math.exp(-Math.max(0, dt) / PITCH_TAU_S))
    this._pitchTime = this._now
    sil.pitchSin = this._pitchSmoothed
    sil.ray.copy(creasePoint).normalize()
    // Longer baselines measure it better; a shaky outline fit, worse.
    sil.pitchConfidence = clamp(arm.confidence * 1.5, 0, 1) * clamp((s2 - s1) / 50, 0, 1)
  }

  /**
   * Image-space unit direction of a 3D direction leaving the wrist, plus how
   * much of it lies across the image rather than along the line of sight.
   */
  _imageDirection(creasePoint, creasePx, dir3) {
    _fit.copy(creasePoint).addScaledVector(dir3, 40)
    const aheadPx = this.camera.project(_fit, this._forearmPx)
    const dx = aheadPx.x - creasePx.x
    const dy = aheadPx.y - creasePx.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-3) return null
    const fullPx = 40 / Math.max(1e-6, -creasePoint.z / this.camera.focalPx)
    return { dx: dx / len, dy: dy / len, inPlane: clamp(len / fullPx, 0, 1) }
  }

  /**
   * Palm length in pixels: the mean wrist-to-knuckle span over the four MCPs.
   *
   * The span is measured on the 2D image landmarks, which are precise and
   * stable. The world landmarks contribute only a foreshortening RATIO — how
   * much of the bone lies in the image plane — never an absolute length. That
   * keeps the size measurement on the trustworthy set while still correcting
   * for a hand tilted toward or away from the camera.
   *
   * Median-filtered over a short window, because palm length is a property of
   * the person and should not change frame to frame.
   */
  _palmLengthPx(source) {
    const px = source.px
    const world = source.world
    const wrist = source.key.wrist
    const set = source.scaleSet
    if (!set || !set.length) return 0

    let sum = 0
    let n = 0
    for (const mcp of set) {
      const a = px[wrist]
      const b = px[mcp]
      const screen = Math.hypot(b.x - a.x, b.y - a.y)
      if (!(screen > 4)) continue

      const wa = world[wrist]
      const wb = world[mcp]
      const dx = wb.x - wa.x
      const dy = wb.y - wa.y
      const dz = wb.z - wa.z
      const full = Math.hypot(dx, dy, dz)
      const plane = Math.hypot(dx, dy)
      // Ratio only. If the world pair is degenerate, take the raw screen span
      // rather than inventing a correction.
      const foreshorten = full > 1e-6 ? clamp(plane / full, MIN_FORESHORTEN, 1) : 1
      sum += screen / foreshorten
      n++
    }
    if (n === 0) return 0

    // Prefer the robust multi-edge estimate when it is confident; it rides out
    // foreshortened and badly detected edges better. On recorded clips the
    // filtered scale varied 10-30 % less with it than with the plain mean.
    const robust = this._robustPalmPx(source, sum / n)
    const sample = robust > 0 ? robust : sum / n
    // Depth follows this, so it gets a 1€ filter: still -> heavily smoothed
    // (landmark wobble made the bracelet breathe), moving -> nearly raw (the
    // joint model needs real motion toward the camera promptly).
    const smoothPalm = this._palmFilter.filter(sample, this._palmTime ?? 0)
    this._palmNowPx = this.raw ? sample : smoothPalm
    this._palmSamples.push(sample)
    if (this._palmSamples.length > PALM_WINDOW) this._palmSamples.shift()
    const sorted = Float64Array.from(this._palmSamples).sort()
    return median(sorted)
  }

  /**
   * Palm scale from seven rigid palm edges, after the vto-bracelets estimator.
   *
   * Each edge gives its own estimate: image length, un-foreshortened with the
   * world landmarks' in-plane ratio, divided by that edge's anatomical ratio
   * to the wrist-middle edge. The ratios are captured once per session, so an
   * edge whose shape drifts more than 30 % from them (a splayed finger fanning
   * a cross-palm edge) drops out rather than skewing the scale. Survivors are
   * cut to a robust band and trimmed-averaged; a wide spread means the frame
   * cannot say, and the caller falls back to the plain estimate.
   *
   * Returned in the same units as the plain estimate (mean wrist-to-knuckle
   * span, pixels) so the two are interchangeable.
   *
   * @returns {number} pixels, or 0 when the edges do not agree
   */
  _robustPalmPx(source, plain) {
    const px = source.px
    const w = source.world
    const ref = dist3(w[0], w[9])
    if (!(ref > 1e-6)) return 0
    if (!this._edgeRatios) this._edgeRatios = new Float64Array(PALM_EDGES.length)
    const ratios = this._edgeRatios
    const est = this._edgeEstimates || (this._edgeEstimates = [])
    est.length = 0
    let seen = 0
    for (let k = 0; k < PALM_EDGES.length; k++) {
      const [a, b] = PALM_EDGES[k]
      const image = Math.hypot(px[b].x - px[a].x, px[b].y - px[a].y)
      const world = dist3(w[a], w[b])
      if (!(image > 4) || !(world > 1e-6)) continue
      const inPlane = Math.hypot(w[b].x - w[a].x, w[b].y - w[a].y) / world
      const anatomy = world / ref
      if (inPlane < MIN_FORESHORTEN || anatomy < 0.08) continue
      seen++
      if (!(ratios[k] > 0)) ratios[k] = anatomy
      if (Math.abs(anatomy / ratios[k] - 1) > 0.3) continue
      est.push(image / inPlane / ratios[k])
    }
    if (seen < 3 || est.length < 3) return 0
    est.sort((x, y) => x - y)
    const centre = median(est)
    const spread = madSorted(est, centre) * 1.4826
    const band = Math.max(centre * 0.14, spread * 2.8)
    let sum = 0
    let n = 0
    const lo = Math.floor(est.length * 0.15)
    const hi = est.length - lo
    for (let i = lo; i < hi; i++) {
      if (Math.abs(est[i] - centre) > band) continue
      sum += est[i]
      n++
    }
    if (n < 3) return 0
    const scale = sum / n // in units of the wrist-middle edge
    if (spread / scale > 0.2) return 0

    // Convert to the mean wrist-to-knuckle span the rest of the code uses.
    let span = 0
    for (const mcp of source.scaleSet) span += dist3(w[0], w[mcp])
    span /= source.scaleSet.length
    const out = (scale * span) / ref
    // A robust answer wildly off the plain one is a wrong reference, not news.
    return out > plain * 0.6 && out < plain * 1.6 ? out : 0
  }

  /**
   * Recovers the translation in camera space from the 2D landmarks.
   *
   * The world landmarks give a rigid 3D point set already in camera-aligned
   * axes, so only translation is unknown: 3 unknowns against many 2D
   * observations, not a full PnP.
   *
   * Depth is seeded by a median vote over point pairs, then refined, because
   * the pairwise estimate assumes both points of a pair share a depth — false
   * across a hand, and worth several millimetres.
   */
  _solveTranslation(source) {
    const cam = this.camera
    const f = cam.focalPx
    const cx = cam.width * 0.5
    const cy = cam.height * 0.5
    const pts = source.solve
    const world = source.world
    const px = source.px

    const votes = this._depthVotes
    let n = 0
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const Wa = world[pts[i].i]
        const Wb = world[pts[j].i]
        const pa = px[pts[i].i]
        const pb = px[pts[j].i]

        const pixDist = Math.hypot(pa.x - pb.x, pa.y - pb.y)
        // Only the image-plane component of the 3D separation projects to pixel
        // distance; the full 3D length would break as the arm turns.
        const projDist = Math.hypot(Wa.x - Wb.x, Wa.y - Wb.y)
        // Short baselines divide by a tiny number and amplify landmark noise.
        if (pixDist < 6 || projDist < 8) continue
        if (n >= votes.length) break

        votes[n++] = (f * projDist) / pixDist + (Wa.z + Wb.z) * 0.5
      }
    }
    if (n < 3) return null

    const slice = votes.subarray(0, n)
    slice.sort()
    const depthOrigin = median(slice)
    if (!(depthOrigin > 100) || !(depthOrigin < 3000)) return null

    let tx = 0
    let ty = 0
    let wsum = 0
    for (const pt of pts) {
      const W = world[pt.i]
      const p = px[pt.i]
      const depth = depthOrigin - W.z
      if (depth < 50) continue
      tx += pt.w * (((p.x - cx) * depth) / f - W.x)
      ty += pt.w * ((-(p.y - cy) * depth) / f - W.y)
      wsum += pt.w
    }
    if (wsum < 1e-6) return null

    const refined = this._refineTranslation(source, tx / wsum, ty / wsum, -depthOrigin)
    if (!refined) return null
    this._translation.set(refined.tx, refined.ty, refined.tz)

    const depthMm = -(world[source.key.wrist].z + refined.tz)
    if (!(depthMm > 50)) return null
    return {
      translation: this._translation,
      depthMm,
      mmPerPx: depthMm / f,
      agreement: refined.agreement,
      residualPx: refined.residualPx,
      pairCount: n,
    }
  }

  /**
   * Gauss-Newton refinement against the real perspective projection, with Huber
   * weighting, so a single bad landmark is outvoted rather than obeyed.
   */
  _refineTranslation(source, tx, ty, tz) {
    const cam = this.camera
    const f = cam.focalPx
    const cx = cam.width * 0.5
    const cy = cam.height * 0.5
    const pts = source.solve
    const world = source.world
    const px = source.px
    let residualPx = 0

    for (let iter = 0; iter < 6; iter++) {
      // Normal equations. a01 is identically zero: the horizontal residual does
      // not depend on vertical translation, or vice versa.
      let a00 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0
      let b0 = 0, b1 = 0, b2 = 0
      let used = 0
      residualPx = 0

      for (const pt of pts) {
        const W = world[pt.i]
        const p = px[pt.i]
        const d = -(W.z + tz)
        if (d < 50) continue

        const wx = W.x + tx
        const wy = W.y + ty
        const ru = (f * wx) / d - (p.x - cx)
        const rv = (-f * wy) / d - (p.y - cy)
        const mag = Math.hypot(ru, rv)
        residualPx += mag
        used++

        const huber = mag <= HUBER_PX ? 1 : HUBER_PX / mag
        const w = pt.w * huber

        const ju0 = f / d
        const ju2 = (f * wx) / (d * d)
        const jv1 = -f / d
        const jv2 = (-f * wy) / (d * d)

        a00 += w * ju0 * ju0
        a02 += w * ju0 * ju2
        a11 += w * jv1 * jv1
        a12 += w * jv1 * jv2
        a22 += w * (ju2 * ju2 + jv2 * jv2)
        b0 += w * ju0 * ru
        b1 += w * jv1 * rv
        b2 += w * (ju2 * ru + jv2 * rv)
      }
      if (used < 3) return null
      residualPx /= used

      // Levenberg damping keeps the depth update sane when the arm is nearly
      // face-on and depth is weakly observable.
      const lm = 1e-6 * (a00 + a11 + a22) + 1e-9
      const m00 = a00 + lm
      const m11 = a11 + lm
      const m22 = a22 + lm

      const det = m00 * (m11 * m22 - a12 * a12) - a02 * (a02 * m11)
      if (Math.abs(det) < 1e-12) return null

      const dx = -(b0 * (m11 * m22 - a12 * a12) - b1 * (-a02 * a12) + b2 * (-a02 * m11)) / det
      const dy = -(-b0 * (a12 * a02) + b1 * (m00 * m22 - a02 * a02) - b2 * (m00 * a12)) / det
      const dz = -(b0 * (-m11 * a02) - b1 * (m00 * a12) + b2 * (m00 * m11)) / det
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return null

      tx += dx
      ty += dy
      tz += dz
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 0.02) break
    }

    return { tx, ty, tz, agreement: clamp(1 - residualPx / 8, 0, 1), residualPx }
  }

  /**
   * The forearm's cross-section profile, read off this frame's arm
   * measurement (see ArmProfiler). Where the silhouette could not measure a
   * station, the anthropometric prior stands and the station is marked
   * unmeasured, so the geometry solver never mistakes a prior for data.
   */
  _measureProfile(perception, creasePx, creasePoint, mmPerPx, palmLengthMm) {
    const fallbackHalfWidth = (palmLengthMm * WRIST_BREADTH_PER_PALM) / 2
    const arm = this.armProfile

    // Image axis for the overlay: the measured arm line when there is one,
    // otherwise the projected 3D forearm axis.
    let dx = arm ? arm.dx : 0
    let dy = arm ? arm.dy : 1
    if (!arm) {
      const dir = this._imageDirection(creasePoint, creasePx, this.basis.y)
      if (dir) {
        dx = dir.dx
        dy = dir.dy
      }
    }
    this.imageAxis.dx = dx
    this.imageAxis.dy = dy
    this.imageAxis.perpX = -dy
    this.imageAxis.perpY = dx

    let measuredCount = 0
    const sleeveLimitMm = arm ? arm.sleeveLimitMm : Infinity
    for (const entry of this.profile) {
      const prior = fallbackHalfWidth * (1 + entry.s * FOREARM_TAPER_PER_MM)
      entry.measured = false
      entry.confidence = 0
      entry.offsetMm = 0
      entry.halfWidthMm = prior
      if (!arm || entry.s > sleeveLimitMm) continue
      if (!this.armProfiler.sectionAt(entry.s, entry)) {
        entry.halfWidthMm = prior
        entry.offsetMm = 0
        continue
      }
      entry.measured = true
      entry.confidence = clamp(1 - Math.abs(entry.halfWidthMm - prior) / (prior * 1.2), 0.25, 1) *
        clamp(arm.confidence * 1.5, 0.3, 1)
      measuredCount++
    }

    return { available: !!perception.armMask, measuredCount, sleeveLimitMm }
  }

  /**
   * Whether the mask agrees with THIS frame's hand: most palm landmarks must
   * land on skin (within a couple of pixels, for landmark jitter at the edge).
   */
  _maskCoversHand(perception) {
    const px = this.source.px
    let onSkin = 0
    for (const i of MASK_CHECK_LANDMARKS) {
      const p = px[i]
      if (!p) continue
      let hit = false
      for (let k = 0; k < MASK_CHECK_OFFSETS.length && !hit; k += 2) {
        hit = this._sampleMask(perception, p.x + MASK_CHECK_OFFSETS[k], p.y + MASK_CHECK_OFFSETS[k + 1]) >= 128
      }
      if (hit) onSkin++
    }
    return onSkin >= Math.ceil(MASK_CHECK_LANDMARKS.length * 0.5)
  }

  /**
   * The arm the silhouette measurement actually used, as a corridor in display
   * pixels: from the wrist anchor, s along (dx, dy), v along (-dy, dx), with
   * outlines v = a + b*s. Everything outside it - face, neck, the other hand -
   * is skin the network saw and the measurement ignored.
   */
  _armOverlay(creasePx) {
    const arm = this.armProfile
    if (!arm || !arm.lines || arm.confidence < 0.15) return null
    const k = 1 / arm.mmPerPx
    const o = this._overlay || (this._overlay = {})
    o.x = creasePx.x
    o.y = creasePx.y
    o.dx = arm.gridDx
    o.dy = arm.gridDy
    o.la = arm.lines.la * k
    o.lb = arm.lines.lb
    o.ra = arm.lines.ra * k
    o.rb = arm.lines.rb
    // The outline is drawn and used over the procedural tube's FULL, fixed
    // length - not just as far as this frame's mask happened to reach. The
    // measured reach swung between ~5 and ~20 cm frame to frame, and every
    // occluder and overlay that used it flickered in length with it.
    o.reach = ARM_TUBE_LENGTH_MM * k
    o.back = ARM_TUBE_BACK_MM * k
    return o
  }

  _armWidth() {
    const arm = this.armProfile
    const none = { armWidthPx: 0, armWidthConfidence: 0, armWidthStationMm: ARM_WIDTH_STATION_MM }
    if (!arm || !arm.lines || !arm.bothSides || arm.confidence < 0.2 || !this.forearm.fromSilhouette) return none
    const s = ARM_WIDTH_STATION_MM
    const L = arm.lines
    const gridMm = L.ra - L.la + (L.rb - L.lb) * s
    // Rows are cut across the grid; square-on to the arm is narrower by the lean.
    const widthMm = gridMm / Math.sqrt(1 + (arm.lean || 0) ** 2)
    const px = widthMm / arm.mmPerPx
    if (!(px > 4)) return none
    return { armWidthPx: px, armWidthConfidence: arm.confidence, armWidthStationMm: s }
  }

  /** Display-pixel mask lookup bound to this frame's perception. */
  _sampler(perception) {
    this._samplePerception = perception
    return this._boundSample || (this._boundSample = (x, y) => this._sampleMask(this._samplePerception, x, y))
  }

  _sampleMask(perception, px, py) {
    const cam = this.camera
    let u = px / cam.width
    const v = py / cam.height
    if (cam.mirrored) u = 1 - u
    if (u < 0 || u > 1 || v < 0 || v > 1) return -1
    return perception.sampleMask(u, v)
  }
}
