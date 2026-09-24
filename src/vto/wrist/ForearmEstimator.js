import * as THREE from 'three'
import { clamp, smoothstep } from '../core/mathUtils.js'

const DEG = Math.PI / 180

/**
 * Lever arm used to decide whether a hand rotation came from the elbow. Only
 * the order of magnitude matters: elbow-to-wrist is ~250 mm on an adult.
 */
const FOREARM_LENGTH_MM = 250

/**
 * The most the wrist can bend, hand axis to forearm axis. Flexion reaches about
 * 80 deg, extension about 70, deviation far less. Anything beyond this is not
 * the wrist bending — the forearm has moved and the estimate must follow.
 */
const MAX_JOINT_RAD = 80 * DEG

/**
 * Time constant of the slow drift back toward the hand axis. This is only the
 * safety net for motion the other cues missed; it must be slow enough that a
 * palm tilt held for a couple of seconds is still not read as the arm moving.
 */
const RELAX_TAU_S = 4

/** A gap this long means the estimate is stale: re-seed rather than carry it. */
const RESET_GAP_MS = 400

/** Silhouette confidence from which the arm's image line is taken as it is (see update). */
const SILHOUETTE_FULL_CONFIDENCE = 0.5

/** Smoothing of the motion cue itself, so one noisy frame cannot flip it. */
const MOTION_LP_S = 0.08

/**
 * The motion cue differentiates over this baseline rather than one frame.
 * Frame-to-frame hand rotation from landmarks carries a few degrees of noise,
 * which over 33 ms looks like a brisk swing; over ~130 ms it mostly cancels.
 */
const MOTION_BASELINE_MS = 130
const HISTORY = 8

/**
 * Depth velocity from a monocular solve is far noisier than image-plane
 * velocity, so it counts for less in the motion cue.
 */
const DEPTH_SPEED_WEIGHT = 0.35

/**
 * How much of the wrist velocity an elbow swing would predict is actually
 * there, at which the hand's rotation is carried onto the forearm.
 */
const CARRY_START = 0.25
const CARRY_END = 0.7
/** Keeps the ratio sane when the hand is barely rotating. */
const SPEED_FLOOR_MM_S = 20

/**
 * Per-frame share of the way toward the tilt measured from perspective, at
 * full confidence. OFF: on the recordings it straightened the rendered arm's
 * width toward the elbow (side 0.84 -> 0.90 at 88 mm) but multiplied axis
 * jitter 3-8x at every gain tried (0.35 / 0.15 / 0.08) - the reading needs
 * both outlines and a long stretch, so it drops in and out between frames,
 * and each switch nudges the axis. Stability wins. Kept for a steadier input.
 */
const PITCH_GAIN = 0

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _p = new THREE.Vector3()
const _carried = new THREE.Vector3()
const _expected = new THREE.Vector3()
const _dqBase = new THREE.Quaternion()
const _dq = new THREE.Quaternion()
const _inv = new THREE.Quaternion()

/** Rotate unit vector `v` toward unit vector `target` by fraction `t` of the angle. */
function rotateToward(v, target, t) {
  if (t <= 0) return v
  const angle = v.angleTo(target)
  if (angle < 1e-6) return v
  _w.crossVectors(v, target)
  if (_w.lengthSq() < 1e-12) return v // antiparallel: no unique axis, hold
  _w.normalize()
  return v.applyAxisAngle(_w, angle * Math.min(1, t)).normalize()
}

/**
 * The forearm direction, estimated over time with a model of the wrist joint.
 *
 * THE PROBLEM IT SOLVES
 * Everything MediaPipe gives us is on the HAND. The wrist is a two-axis joint
 * (flexion/extension, radial/ulnar deviation), so tilting the palm rotates the
 * hand frame while the forearm - which is what the bracelet sits on - does not
 * move. Reading the bracelet's frame off the hand makes it turn with the palm.
 *
 * THE MODEL
 * The bracelet frame is the hand frame with the joint's swing removed: rotate
 * the hand frame by the smallest rotation that takes the hand axis onto the
 * forearm axis. Twist about the arm (pronation/supination) survives that
 * untouched, which is correct - the distal forearm does roll with the hand.
 * So the only thing to estimate is the forearm DIRECTION, and that has three
 * sources of evidence, in order of authority:
 *
 *   1. The arm silhouette. It fixes the direction's in-image component
 *      exactly, under the true perspective (a plane through the camera), but
 *      says nothing about tilt toward or away from the camera.
 *   2. The motion of the wrist. When the arm swings about the elbow, the wrist
 *      TRAVELS - roughly forearm-length times angular speed. When only the
 *      wrist bends, it barely moves. So hand rotation with a travelling wrist
 *      is carried onto the forearm; hand rotation with a stationary wrist is
 *      treated as the joint bending, and the forearm holds still.
 *   3. A slow relaxation toward the hand axis, plus the joint's range of
 *      motion as a hard limit, so the estimate can never drift somewhere the
 *      anatomy cannot reach.
 */
export class ForearmEstimator {
  constructor() {
    /** Unit vector, wrist -> elbow, in camera/world space. */
    this.direction = new THREE.Vector3(0, -1, 0)
    this.valid = false
    /** 0 = hand rotation read as wrist bend, 1 = read as the whole arm moving. */
    this.carry = 0
    this.fromSilhouette = false
    /** Diagnostic: no carry-over between frames (see update). */
    this.raw = false

    this._lastTime = 0
    this._lastCrease = new THREE.Vector3()
    this._lastHandQ = new THREE.Quaternion()
    this._vel = new THREE.Vector3()
    this._expectedVel = new THREE.Vector3()
    /** Ring of recent (time, wrist, hand orientation) for the motion cue. */
    this._history = Array.from({ length: HISTORY }, () => ({
      t: -Infinity, crease: new THREE.Vector3(), q: new THREE.Quaternion(),
    }))
    this._head = 0
  }

  reset() {
    this.valid = false
    this.carry = 0
    this._vel.set(0, 0, 0)
    this._expectedVel.set(0, 0, 0)
    for (const h of this._history) h.t = -Infinity
  }

  /**
   * @param {{axis:THREE.Vector3, quaternion:THREE.Quaternion}} hand hand axis
   *        (wrist -> elbow direction the hand alone implies) and hand frame.
   * @param {{normal:THREE.Vector3, direction:THREE.Vector3, confidence:number}|null} silhouette
   *        plane through the camera that contains the arm's image line, and
   *        the in-plane direction pointing away from the hand.
   * @param {THREE.Vector3} crease wrist point, world space
   * @param {number} t ms
   */
  update(hand, silhouette, crease, t) {
    const d = this.direction
    const dt = (t - this._lastTime) / 1000
    this.fromSilhouette = false

    // Diagnostic (the engine's raw pose): no memory across frames - this
    // frame's mask line where there is one, else the hand's own axis.
    if (this.raw) {
      d.copy(hand.axis)
      if (silhouette) this.fromSilhouette = this._applySilhouette(silhouette, 1)
      this.carry = 0
      this._remember(hand, crease, t)
      this.valid = true
      return d
    }

    if (!this.valid || !(dt > 0) || dt * 1000 > RESET_GAP_MS) {
      d.copy(hand.axis)
      if (silhouette) this.fromSilhouette = this._applySilhouette(silhouette, 1)
      this.carry = 0
      this._vel.set(0, 0, 0)
      this._expectedVel.set(0, 0, 0)
      for (const h of this._history) h.t = -Infinity
      this._remember(hand, crease, t)
      this.valid = true
      return d
    }

    // --- Is the arm moving, or only the wrist bending? ---------------------
    // If the hand's rotation came from the elbow, the wrist moved by exactly
    // omega x (wrist - elbow). If it came from the wrist bending, the wrist
    // barely moved. Project the measured wrist velocity onto that prediction:
    // ~1 means the arm swung, ~0 means the joint bent, and translation that
    // has nothing to do with the rotation falls out of the projection.
    const base = this._baseline(t)
    const span = (t - base.t) / 1000
    _v.subVectors(crease, base.crease).multiplyScalar(1 / span)
    _dqBase.copy(hand.quaternion).multiply(_inv.copy(base.q).invert())
    if (_dqBase.w < 0) _dqBase.set(-_dqBase.x, -_dqBase.y, -_dqBase.z, -_dqBase.w)
    const angle = 2 * Math.acos(clamp(_dqBase.w, -1, 1))
    _expected.set(0, 0, 0)
    if (angle > 1e-6) {
      const s = Math.sin(angle / 2)
      _w.set(_dqBase.x / s, _dqBase.y / s, _dqBase.z / s).multiplyScalar(angle / span)
      // wrist - elbow = -L * d. Twist about d drops out of the cross product,
      // which is right: rolling the forearm moves neither wrist nor axis.
      _expected.crossVectors(_w, d).multiplyScalar(-FOREARM_LENGTH_MM)
    }
    // Depth velocity is the noisiest thing a monocular solve produces, so it
    // is down-weighted - on both sides, so the ratio stays unbiased.
    _v.z *= DEPTH_SPEED_WEIGHT
    _expected.z *= DEPTH_SPEED_WEIGHT

    // Smooth the VECTORS, then compare: noise is zero-mean and cancels in a
    // vector average, but it would not cancel in an average of squares.
    const lp = 1 - Math.exp(-dt / MOTION_LP_S)
    this._vel.lerp(_v, lp)
    this._expectedVel.lerp(_expected, lp)
    const ratio =
      this._vel.dot(this._expectedVel) /
      (this._expectedVel.lengthSq() + SPEED_FLOOR_MM_S * SPEED_FLOOR_MM_S)
    this.carry = smoothstep(CARRY_START, CARRY_END, ratio)

    // The hypothesis is applied to this frame's own rotation.
    _dq.copy(hand.quaternion).multiply(_inv.copy(this._lastHandQ).invert())

    // --- Predict: blend the two hypotheses ---------------------------------
    if (this.carry > 0) {
      _carried.copy(d).applyQuaternion(_dq)
      rotateToward(d, _carried, this.carry)
    }
    rotateToward(d, hand.axis, 1 - Math.exp(-dt / RELAX_TAU_S))

    // --- Correct: the silhouette owns the in-image direction ---------------
    // Fully, once its fit is confident: taken only `confidence` of the way
    // (0.3-0.6 typically), the rest was carried from earlier frames - a
    // smoothing filter in disguise, and the cylinder trailed the mask.
    if (silhouette) this.fromSilhouette = this._applySilhouette(silhouette, silhouette.confidence / SILHOUETTE_FULL_CONFIDENCE)

    // --- Range of motion ---------------------------------------------------
    const joint = d.angleTo(hand.axis)
    if (joint > MAX_JOINT_RAD) rotateToward(d, hand.axis, 1 - MAX_JOINT_RAD / joint)

    this._remember(hand, crease, t)
    return d
  }

  /**
   * Move the direction onto the silhouette plane, keeping its tilt toward the
   * camera. The silhouette only knows the arm's image line, so the smallest
   * correction that agrees with it is a projection onto that line's plane.
   */
  _applySilhouette(sil, gain) {
    const d = this.direction
    _p.copy(d).addScaledVector(sil.normal, -d.dot(sil.normal))
    // The prior points almost straight out of the plane: it has no usable
    // opinion, so take the silhouette's own in-image direction.
    if (_p.lengthSq() < 0.09) _p.copy(sil.direction)
    _p.normalize()
    // The plane holds both directions along the line; the silhouette knows
    // which one leads away from the hand. Disagreement means a bad fit.
    if (_p.dot(sil.direction) < 0) return false

    // Tilt in depth, measured from perspective (see WristObserver): within
    // the silhouette plane, move the elevation toward the measured one.
    // Gently - it is the noisiest thing the silhouette measures - and the
    // pose filter smooths it further.
    if (sil.pitchConfidence > 0 && sil.ray) {
      _w.copy(sil.ray).addScaledVector(sil.direction, -sil.ray.dot(sil.direction))
      if (_w.lengthSq() > 1e-6) {
        _w.normalize() // away from the camera, within the plane
        const current = clamp(_p.dot(_w), -1, 1)
        const target = current + (sil.pitchSin - current) * clamp(sil.pitchConfidence * PITCH_GAIN, 0, 1)
        _p.copy(sil.direction).multiplyScalar(Math.sqrt(Math.max(0, 1 - target * target)))
          .addScaledVector(_w, target).normalize()
      }
    }
    rotateToward(d, _p, clamp(gain, 0, 1))
    return true
  }

  _remember(hand, crease, t) {
    this._lastCrease.copy(crease)
    this._lastHandQ.copy(hand.quaternion)
    this._lastTime = t
    const slot = this._history[this._head]
    slot.t = t
    slot.crease.copy(crease)
    slot.q.copy(hand.quaternion)
    this._head = (this._head + 1) % HISTORY
  }

  /** The newest remembered sample at least MOTION_BASELINE_MS old, else the oldest. */
  _baseline(t) {
    let best = null
    let oldest = null
    for (const h of this._history) {
      if (!(h.t > -Infinity) || h.t >= t) continue
      if (!oldest || h.t < oldest.t) oldest = h
      if (t - h.t >= MOTION_BASELINE_MS && (!best || h.t > best.t)) best = h
    }
    return best ?? oldest
  }
}
