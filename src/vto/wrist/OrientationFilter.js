import * as THREE from 'three'
import { OneEuroDir } from '../core/OneEuroFilter.js'
import { KalmanCV } from '../core/KalmanCV.js'

const _m = new THREE.Matrix4()
const _xObs = new THREE.Vector3()
const _yObs = new THREE.Vector3()
const _xRef = new THREE.Vector3()
const _xAl = new THREE.Vector3()
const _z = new THREE.Vector3()
const _c = new THREE.Vector3()
const _swing = new THREE.Quaternion()

/**
 * Forearm direction: 1€ on the axis. Same response as the old whole-frame
 * filter had for it (the axis was already steady on the recordings).
 */
export const DIRECTION_FILTER = { minCutoff: 1.2, beta: 0.9, dCutoff: 1.0 }
/**
 * Roll about the forearm, rad. The detector's roll is by far the noisiest part
 * of the pose (second difference p95 ~18 deg per frame on still recordings,
 * the forearm DIRECTION ~0.7), while a real forearm turns smoothly. So roll
 * gets a constant-velocity Kalman filter.
 *
 * Chosen on the recordings with the scorecard, against the old whole-frame
 * 1€ filter (roll shake p95 still-ish / moving, roll lag p50 / p90, deg):
 *   old 1€ on the quaternion     3.06 / 10.0    0.81 / 3.6
 *   q 1                          2.61 /  6.9    0.48 / 4.3
 *   q 0.5   <- this              2.32 /  6.1    0.62 / 5.2
 *   q 0.3                        2.12 /  5.6    0.76 / 6.0
 *   q 0.1                        1.70 /  4.2    1.06 / 8.7
 * Lower q is calmer and later. Manoeuvre-adaptive noise and a 1€ filter on
 * the roll angle were also tried; neither beat this trade.
 */
export const ROLL_FILTER = { q: 0.5, r: 0.09 * 0.09, gate: 3 }

/**
 * The tracked arm frame, filtered as two separate things: WHERE THE FOREARM
 * POINTS and HOW FAR IT HAS ROLLED ABOUT ITSELF.
 *
 * One filter over the whole orientation cannot treat them differently: roll
 * noise reads as rotation speed, which opens the filter up for the axis too,
 * and the axis's steadiness does nothing for the roll. Separated, the axis
 * keeps its responsive 1€ filter, and the roll - the bracelet visibly turning
 * round the arm - gets heavy, prediction-based smoothing with outliers
 * down-weighted rather than obeyed.
 *
 * Frame convention (the observer's): x radial, y forearm (wrist -> elbow),
 * z dorsal, z = x cross y.
 */
export class OrientationFilter {
  constructor({ direction = DIRECTION_FILTER, roll = ROLL_FILTER } = {}) {
    this.dir = new OneEuroDir(direction)
    this.roll = new KalmanCV(roll)
    this.rollR = roll.r
    this.radial = new THREE.Vector3(1, 0, 0)
    this.axis = new THREE.Vector3(0, -1, 0)
    this.quaternion = new THREE.Quaternion()
    this.valid = false
    this._t = 0
  }

  reset() {
    this.dir.reset()
    this.roll.valid = false
    this.valid = false
  }

  /** Roll rate about the forearm, rad/s (positive = right-handed about +y). */
  get rollRate() {
    return this.valid ? this.roll.v : 0
  }

  /**
   * @param {THREE.Quaternion} q observed arm frame
   * @param {number} t ms
   * @param {number} [trust=1] 0..1 pose confidence
   * @returns {THREE.Quaternion} the filtered frame (owned by the filter)
   */
  filter(q, t, trust = 1) {
    _m.makeRotationFromQuaternion(q)
    _xObs.setFromMatrixColumn(_m, 0)
    _yObs.setFromMatrixColumn(_m, 1)

    if (!this.valid) {
      this.dir.reset()
      this.axis.copy(this.dir.filter(_yObs, t, trust))
      this.radial.copy(_xObs)
      this.roll.reset(0, 0)
      this.valid = true
      this._t = t
      return this._compose()
    }
    const dt = Math.max(1e-3, (t - this._t) / 1000)
    this._t = t

    // --- Where the forearm points -----------------------------------------
    const prevAxis = _c.copy(this.axis)
    this.axis.copy(this.dir.filter(_yObs, t, trust))

    // --- Roll about it ------------------------------------------------------
    // The last filtered radial axis, carried onto the new axis by the smallest
    // rotation (no roll of its own), is the reference; the observed radial
    // axis, swung onto the same axis, is the measurement. Their angle about
    // the axis is this frame's roll relative to the filter.
    _swing.setFromUnitVectors(prevAxis, this.axis)
    _xRef.copy(this.radial).applyQuaternion(_swing)
    orthogonalise(_xRef, this.axis)
    _swing.setFromUnitVectors(_yObs, this.axis)
    _xAl.copy(_xObs).applyQuaternion(_swing)
    orthogonalise(_xAl, this.axis)
    const measured = Math.atan2(_z.crossVectors(_xRef, _xAl).dot(this.axis), _xRef.dot(_xAl))

    const before = this.roll.x
    this.roll.predict(dt)
    const trustFactor = Math.max(0.25, Math.min(1, trust))
    this.roll.update(before + measured, this.rollR / (trustFactor * trustFactor))
    const turn = this.roll.x - before
    this.radial.copy(_xRef).applyAxisAngle(this.axis, turn)
    orthogonalise(this.radial, this.axis)
    return this._compose()
  }

  _compose() {
    _z.crossVectors(this.radial, this.axis).normalize()
    _m.makeBasis(this.radial, this.axis, _z)
    this.quaternion.setFromRotationMatrix(_m)
    return this.quaternion
  }
}

function orthogonalise(v, axis) {
  v.addScaledVector(axis, -v.dot(axis))
  const len = v.length()
  if (len > 1e-9) v.multiplyScalar(1 / len)
  else v.crossVectors(axis, Math.abs(axis.x) < 0.9 ? _X : _Y).normalize() // degenerate: any perpendicular
  return v
}

const _X = new THREE.Vector3(1, 0, 0)
const _Y = new THREE.Vector3(0, 1, 0)
