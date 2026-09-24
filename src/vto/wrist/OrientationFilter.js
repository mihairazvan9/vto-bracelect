import * as THREE from 'three'
import { Deadzone1D, DeadzoneDir } from '../core/Deadzone.js'

const _m = new THREE.Matrix4()
const _xObs = new THREE.Vector3()
const _yObs = new THREE.Vector3()
const _xRef = new THREE.Vector3()
const _xAl = new THREE.Vector3()
const _z = new THREE.Vector3()
const _c = new THREE.Vector3()
const _swing = new THREE.Quaternion()

/**
 * Forearm direction: a 1 deg deadzone, not a smoothing filter. The direction
 * comes from this frame's arm mask when it is confident (ForearmEstimator), and
 * the 1€ filter that used to sit here made the cylinder trail the mask it was
 * measured from: angle to the mask while the arm moved, p50 / p95, 1.2 / 10.2
 * deg with it, 0.8 / 2.9 with this; on a still arm the direction's second
 * difference stays at 0.04 / 1.2 deg. What it lets through while the arm moves
 * is the mask following the arm.
 */
export const DIRECTION_FILTER = { deg: 1 }
/**
 * Roll about the forearm, rad. The detector's roll is by far the noisiest part
 * of the pose (second difference p95 ~18 deg per frame on still recordings,
 * the forearm DIRECTION ~0.7). So roll gets the widest deadzone: 10 deg while
 * the arm is still, 2 deg once it turns.
 *
 * It replaced a constant-velocity Kalman filter (q 0.5), which was as calm on
 * a still arm but trailed every turn of the wrist. On the recordings, per
 * camera frame (still: second difference; turning: raw minus output averaged
 * over +-3 frames; p50 / p95, deg):
 *                         still          turning: lag
 *   Kalman, q 0.5         0.38 / 1.59    2.35 / 22.7
 *   this                  0.00 / 1.61    1.43 /  5.2
 */
export const ROLL_DEADZONE_DEG = { rest: 10, move: 2 }

/**
 * The tracked arm frame, filtered as two separate things: WHERE THE FOREARM
 * POINTS and HOW FAR IT HAS ROLLED ABOUT ITSELF.
 *
 * One filter over the whole orientation cannot treat them differently: roll
 * noise reads as rotation speed, which opens the filter up for the axis too,
 * and the axis's steadiness does nothing for the roll. Separated, each gets a
 * deadzone of its own size - no smoothing: still, the frame holds; turning, it
 * follows to within the band.
 *
 * Frame convention (the observer's): x radial, y forearm (wrist -> elbow),
 * z dorsal, z = x cross y.
 */
export class OrientationFilter {
  constructor({ direction = DIRECTION_FILTER, roll = ROLL_DEADZONE_DEG } = {}) {
    this.dir = new DeadzoneDir(direction)
    const rad = Math.PI / 180
    /** Accumulated (unwrapped) roll, rad. */
    this.roll = new Deadzone1D({ rest: roll.rest * rad, move: roll.move * rad, calmStep: roll.rest * rad * 0.3 })
    this._rollRate = 0
    this.radial = new THREE.Vector3(1, 0, 0)
    this.axis = new THREE.Vector3(0, -1, 0)
    this.quaternion = new THREE.Quaternion()
    this.valid = false
    this._t = 0
  }

  reset() {
    this.dir.reset()
    this.roll.reset()
    this.valid = false
  }

  /** Roll rate about the forearm over the last frame, rad/s (positive = right-handed about +y). */
  get rollRate() {
    return this.valid ? this._rollRate : 0
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
      this.roll.reset(0)
      this._rollRate = 0
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

    const before = this.roll.value
    const turn = this.roll.filter(before + measured) - before
    this._rollRate = turn / dt
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
