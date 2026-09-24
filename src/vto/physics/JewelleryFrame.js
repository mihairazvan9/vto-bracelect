import * as THREE from 'three'

const _m = new THREE.Matrix4()
const _tx = new THREE.Vector3()
const _ty = new THREE.Vector3()
const _tz = new THREE.Vector3()
const _o = new THREE.Vector3()
const _c = new THREE.Vector3()
const _q = new THREE.Quaternion()

/** A pose change this large at once is a new track, not motion: start over. */
const SNAP_DISTANCE_MM = 150
const SNAP_ANGLE_RAD = (60 * Math.PI) / 180
/** The twist follower is integrated at this step, s. */
const FOLLOW_STEP_S = 1 / 240

/**
 * The frame jewellery is simulated in: the arm's own frame, EXCEPT for its
 * twist, which it follows through a soft rotational spring.
 *
 * Why: the arm frame's roll (twist about the forearm) is the noisiest part of
 * the tracked pose, while a real forearm twists slowly. Simulated in the arm
 * frame itself, every roll twitch of the tracker turned the whole bracelet
 * round the wrist with it. In this frame the piece only feels the twist that
 * lasts - a real pronation reaches it (a little late, as it would a loose
 * bracelet sliding on skin), a twitch does not.
 *
 *   world-from-sim  S = P * R_y(simRoll)        (matrix / quaternion)
 *   the arm frame   T = S * R_y(delta)          (twin.frameMatrix)
 *
 * P is the arm frame carried along by the smallest rotations that keep its y
 * on the forearm (no roll of its own); armRoll is how far T has rolled from
 * it (unwrapped); simRoll follows armRoll, critically damped at `followHz`;
 * delta = armRoll - simRoll is the twist not followed yet. The physics
 * collides with the arm as THIS frame sees it - its elliptical section turned
 * only by the twist the frame has followed - so a roll twitch cannot shake a
 * piece through the tube either. delta is used only to express the result in
 * the arm frame: sim -> arm coordinates rotates by -delta about y.
 */
export class JewelleryFrame {
  constructor() {
    this.matrix = new THREE.Matrix4()
    this.quaternion = new THREE.Quaternion()
    this.origin = new THREE.Vector3()
    this.delta = 0
    this.valid = false
    this.snapped = false
    this._px = new THREE.Vector3(1, 0, 0)
    this._py = new THREE.Vector3(0, 1, 0)
    this._pz = new THREE.Vector3(0, 0, 1)
    this._armRoll = 0
    this._simRoll = 0
    this._simRate = 0
  }

  reset() {
    this.valid = false
  }

  /**
   * Take the arm's pose for this render frame. Returns true when the frame was
   * (re)started - the caller should re-seat its piece.
   * @param {import('../wrist/WristDigitalTwin.js').WristDigitalTwin} twin
   */
  begin(twin) {
    twin.frameMatrix(_m)
    _m.extractBasis(_tx, _ty, _tz)
    _o.setFromMatrixPosition(_m)
    this.snapped = false
    if (!this.valid || _ty.angleTo(this._py) > SNAP_ANGLE_RAD || _o.distanceTo(this.origin) > SNAP_DISTANCE_MM) {
      this._px.copy(_tx)
      this._py.copy(_ty)
      this._pz.copy(_tz)
      this._armRoll = 0
      this._simRoll = 0
      this._simRate = 0
      this.origin.copy(_o)
      this.valid = true
      this.snapped = true
      this._compose()
      return true
    }
    // Carry P onto the new axis without rolling it.
    _q.setFromUnitVectors(this._py, _ty)
    this._px.applyQuaternion(_q)
    this._py.copy(_ty)
    this._px.addScaledVector(_ty, -this._px.dot(_ty)).normalize()
    this._pz.crossVectors(this._px, this._py).normalize()
    // How far the arm has rolled from P, unwrapped.
    const raw = Math.atan2(_c.crossVectors(this._px, _tx).dot(_ty), this._px.dot(_tx))
    const step = wrap(raw - wrap(this._armRoll))
    this._armRoll += step
    this.origin.copy(_o)
    this._compose()
    return false
  }

  /**
   * Advance the twist follower by h seconds (call once per physics step).
   * @param {number} h
   * @param {number} followHz
   */
  step(h, followHz) {
    if (followHz === Infinity) {
      // Pinned (tuningFrom): the frame IS the arm's.
      this._simRoll = this._armRoll
      this._simRate = 0
      this._compose()
      return
    }
    const wn = 2 * Math.PI * followHz
    const n = Math.max(1, Math.ceil(h / FOLLOW_STEP_S - 1e-9))
    const k = h / n
    for (let i = 0; i < n; i++) {
      const a = wn * wn * (this._armRoll - this._simRoll) - 2 * wn * this._simRate
      this._simRate += a * k
      this._simRoll += this._simRate * k
    }
    this._compose()
  }

  _compose() {
    this.delta = this._armRoll - this._simRoll
    const c = Math.cos(this._simRoll)
    const s = Math.sin(this._simRoll)
    // Rotate P's x and z about y by simRoll (v' = v cos + (y x v) sin).
    _tx.copy(this._px).multiplyScalar(c).addScaledVector(_c.crossVectors(this._py, this._px), s)
    _tz.copy(this._pz).multiplyScalar(c).addScaledVector(_c.crossVectors(this._py, this._pz), s)
    this.matrix.makeBasis(_tx, this._py, _tz)
    this.matrix.setPosition(this.origin)
    this.quaternion.setFromRotationMatrix(this.matrix)
  }

  /** Sim coordinates -> arm (twin frame) coordinates, in place. */
  toArm(v) {
    const c = Math.cos(this.delta)
    const s = Math.sin(this.delta)
    const x = v.x * c - v.z * s
    const z = v.x * s + v.z * c
    v.x = x
    v.z = z
    return v
  }

  /** Arm coordinates -> sim coordinates, in place. */
  fromArm(v) {
    const c = Math.cos(this.delta)
    const s = Math.sin(this.delta)
    const x = v.x * c + v.z * s
    const z = -v.x * s + v.z * c
    v.x = x
    v.z = z
    return v
  }
}

function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a))
}
