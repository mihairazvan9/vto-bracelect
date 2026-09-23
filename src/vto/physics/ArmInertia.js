import * as THREE from 'three'

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _err = new THREE.Vector3()
const _dq = new THREE.Quaternion()
const _a = new THREE.Vector3()
const _alpha = new THREE.Vector3()
const _ray = new THREE.Vector3()

/**
 * Follower bandwidth, Hz. A critically damped second-order follower is a
 * two-pole low-pass on the arm's trajectory: a wrist swing or a flick (1-3 Hz)
 * passes, the detector's frame-to-frame noise (5-15 Hz) is cut by 40 dB/decade
 * BEFORE it is differentiated twice into an acceleration.
 */
const BANDWIDTH_HZ = 3.2
const OMEGA_N = 2 * Math.PI * BANDWIDTH_HZ
const SUBSTEP_S = 1 / 240

/**
 * Soft dead zones: below these the arm is, for jewellery purposes, still.
 * What remains of tracking noise after the low-pass lives here, so a held arm
 * puts exactly zero force on the chain and it settles completely.
 */
const LINEAR_DEADZONE = 900 // mm/s^2 (~0.09 g)
const ANGULAR_VEL_DEADZONE = 0.35 // rad/s (the tracker's own "stationary")
const ANGULAR_ACC_DEADZONE = 5 // rad/s^2

/**
 * Depth is the least trustworthy axis of the pose (it comes from a size
 * estimate, not from a pixel), so apparent motion along the camera ray only
 * counts for this much of its value.
 */
const DEPTH_TRUST = 0.35

/** A pose change this large in one step is a re-acquisition, not motion. */
const SNAP_DISTANCE_MM = 150
const SNAP_ANGLE_RAD = (60 * Math.PI) / 180

/**
 * How strongly the chain feels the arm's motion, and the most it ever feels.
 * Stable mode keeps the piece calm (a little life, never a swing); realistic
 * is the full rigid-body answer, capped at a hard flick.
 */
export const INERTIA_STABLE = { gain: 0.3, maxLinear: 12000, maxAngularVel: 6, maxAngularAcc: 40 }
export const INERTIA_REALISTIC = { gain: 1, maxLinear: 40000, maxAngularVel: 14, maxAngularAcc: 120 }

/**
 * The arm's motion, as the jewellery should feel it.
 *
 * The chain is simulated in the arm's own frame (see WristDigitalTwin.
 * frameMatrix), so the arm's motion only reaches it as fictitious forces:
 * linear acceleration, and the Euler, centrifugal and Coriolis terms of the
 * arm's rotation. Taken straight from the tracked pose those would be the
 * detector's noise differentiated twice - exactly the shaking that used to
 * throw bracelets off. Instead a critically damped follower tracks the pose,
 * and its (smooth, bounded) acceleration is what the chain feels.
 */
export class ArmInertia {
  constructor() {
    this.position = new THREE.Vector3()
    this.velocity = new THREE.Vector3()
    this.quaternion = new THREE.Quaternion()
    this.angularVelocity = new THREE.Vector3()

    /** Outputs, world space, after gain, dead zone and clamping. */
    this.linearAcc = new THREE.Vector3()
    this.omega = new THREE.Vector3()
    this.angularAcc = new THREE.Vector3()

    this.initialised = false
  }

  reset() {
    this.initialised = false
    this.linearAcc.set(0, 0, 0)
    this.omega.set(0, 0, 0)
    this.angularAcc.set(0, 0, 0)
  }

  /**
   * @param {THREE.Matrix4} frame world-from-arm (WristDigitalTwin.frameMatrix)
   * @param {number} dt seconds since the last update
   * @param {typeof INERTIA_STABLE} profile
   */
  update(frame, dt, profile = INERTIA_STABLE) {
    frame.decompose(_pos, _quat, _scale)

    if (!this.initialised || !(dt > 0) || dt > 0.25 || this._jumped(_pos, _quat)) {
      this._snap(_pos, _quat)
      return this
    }

    // Integrate the follower at a fixed fine step: exact enough for a
    // 3 Hz filter at any render rate, and unconditionally stable.
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP_S))
    const h = dt / steps
    const k = OMEGA_N * OMEGA_N
    const c = 2 * OMEGA_N
    _a.set(0, 0, 0)
    _alpha.set(0, 0, 0)
    for (let i = 0; i < steps; i++) {
      // Linear: a = wn^2 (target - x) - 2 wn v
      _err.subVectors(_pos, this.position).multiplyScalar(k).addScaledVector(this.velocity, -c)
      this.velocity.addScaledVector(_err, h)
      this.position.addScaledVector(this.velocity, h)
      _a.addScaledVector(_err, 1 / steps)

      // Angular, on SO(3): the error is the rotation vector taking the
      // follower onto the target, expressed in world space.
      rotationVector(_dq.copy(_quat).multiply(_invert(this.quaternion)), _err)
      _err.multiplyScalar(k).addScaledVector(this.angularVelocity, -c)
      this.angularVelocity.addScaledVector(_err, h)
      integrate(this.quaternion, this.angularVelocity, h)
      _alpha.addScaledVector(_err, 1 / steps)
    }

    // Depth is measured, not seen: discount the along-ray part.
    _ray.copy(this.position)
    if (_ray.lengthSq() > 1e-6) {
      _ray.normalize()
      const along = _a.dot(_ray)
      _a.addScaledVector(_ray, -along * (1 - DEPTH_TRUST))
    }

    shape(this.linearAcc.copy(_a), profile.gain, LINEAR_DEADZONE, profile.maxLinear)
    shape(this.omega.copy(this.angularVelocity), profile.gain, ANGULAR_VEL_DEADZONE, profile.maxAngularVel)
    shape(this.angularAcc.copy(_alpha), profile.gain, ANGULAR_ACC_DEADZONE, profile.maxAngularAcc)
    return this
  }

  _jumped(pos, quat) {
    if (pos.distanceTo(this.position) > SNAP_DISTANCE_MM) return true
    const dot = Math.min(1, Math.abs(quat.dot(this.quaternion)))
    return 2 * Math.acos(dot) > SNAP_ANGLE_RAD
  }

  _snap(pos, quat) {
    this.position.copy(pos)
    this.quaternion.copy(quat)
    this.velocity.set(0, 0, 0)
    this.angularVelocity.set(0, 0, 0)
    this.linearAcc.set(0, 0, 0)
    this.omega.set(0, 0, 0)
    this.angularAcc.set(0, 0, 0)
    this.initialised = true
  }
}

/**
 * Gain, then a soft dead zone (shrink the magnitude by the dead zone, so the
 * response is continuous through it), then a hard cap.
 */
function shape(v, gain, deadzone, max) {
  const m = v.length()
  if (m <= deadzone) return v.set(0, 0, 0)
  const out = Math.min(max, (m - deadzone) * gain)
  return v.multiplyScalar(out / m)
}

const _inv = new THREE.Quaternion()
function _invert(q) {
  return _inv.copy(q).invert()
}

/** Rotation vector (axis * angle) of a unit quaternion, shortest way round. */
function rotationVector(q, out) {
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w)
  const s = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z)
  if (s < 1e-9) return out.set(q.x * 2, q.y * 2, q.z * 2)
  const angle = 2 * Math.atan2(s, q.w)
  return out.set(q.x, q.y, q.z).multiplyScalar(angle / s)
}

const _step = new THREE.Quaternion()
const _axis = new THREE.Vector3()
/** q <- exp(w h) q  (world-space angular velocity). */
function integrate(q, w, h) {
  const angle = w.length() * h
  if (angle < 1e-12) return
  _axis.copy(w).normalize()
  _step.setFromAxisAngle(_axis, angle)
  q.premultiply(_step).normalize()
}
