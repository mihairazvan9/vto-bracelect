import * as THREE from 'three'
import { BACKSTOP_NEAR_MM, BACKSTOP_FAR_MM } from './walls.js'
import { ArmInertia } from './ArmInertia.js'
import { JewelleryFrame } from './JewelleryFrame.js'
import { armContact, fitSqueeze } from './armTube.js'
import { tuningFrom } from './tuning.js'
import { BraceletCategory } from '../assets/schema.js'

/** Fixed simulation step, s: the result does not depend on the display rate. */
const STEP_S = 1 / 480
/** At most this much simulated time per call (a stalled tab must not spiral). */
const MAX_CATCH_UP_S = 0.1
/** Points sampled round the ring's inner edge for contact with the arm. */
const RING_SAMPLES = 24
/** Constraint passes per step. */
const ITERATIONS = 3
const GRAVITY_MM_S2 = 9810
const DOWN = new THREE.Vector3(0, -1, 0)
const Y = new THREE.Vector3(0, 1, 0)
/** A piece this slow, on a still arm, for this long, goes to sleep: it rests exactly. */
const SLEEP_SPEED_MM_S = 0.8
const SLEEP_SPIN_RAD_S = 0.03
const SLEEP_AFTER_S = 0.35
/** Approach speeds below this do not bounce (resting contact), mm/s. */
const BOUNCE_MIN_MM_S = 25
/** A piece settles here when first put on the arm (so it does not drop in view), s. */
const PRESETTLE_S = 0.6
/** The resting station moves at most this fast when the fit changes it, mm/s. */
const REST_GLIDE_MM_S = 40
/** Hard limits on the piece's speed: a last line of defence, never reached in normal use. */
const MAX_SPEED_MM_S = 2000
const MAX_SPIN_RAD_S = 40
/** An open cuff grips the wrist: pulled onto the arm at this rate, 1/s. */
const CUFF_GRIP = 45

const _g = new THREE.Vector3()
const _a = new THREE.Vector3()
const _t = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _r = new THREE.Vector3()
const _p = new THREE.Vector3()
const _n = new THREE.Vector3()
const _rn = new THREE.Vector3()
const _dw = new THREE.Vector3()
const _vp = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qi = new THREE.Quaternion()
const _toSim = new THREE.Quaternion()
const _from = new THREE.Vector3()
const _slip = new THREE.Vector3()
const _contact = { x: 0, z: 0, nx: 0, nz: 0, depth: 0 }

/**
 * Rigid bangle / open cuff: a real rigid body on the arm.
 *
 * A rigid ring keeps its manufactured size, and a loose one is a heavy object
 * resting on a limb: it lies on the top of the wrist under gravity, knocks
 * against it when the arm moves, slides along it when the arm tilts past what
 * skin friction holds, tips until two points of it jam, and comes to rest.
 * The old solver moved three numbers (station, sag, tilt) toward targets with
 * first-order lags - no mass, no momentum - so the piece glided rather than
 * weighed anything, and its frame was the tracked arm frame, so every roll
 * twitch of the tracker turned it.
 *
 * Here: an XPBD rigid body (Muller et al., "Detailed Rigid Body Simulation
 * with Extended Position Based Dynamics", 2020), stepped at a fixed 480 Hz and
 * interpolated for display, in the JewelleryFrame (the arm frame with its twist
 * followed softly). Contact with the arm: 24 points round the ring's inner
 * edge against the tube (armTube.js); position corrections at those points
 * move and turn the ring together. Coulomb skin friction, a soft bounce, wall
 * planes, a tasteful tilt limit, and sleep when it and the arm are at rest.
 * Liveliness (tuning.js) sets how much of the arm's motion it feels.
 */
export class RigidSolver {
  constructor() {
    /** World-space pose of the piece, for the renderer. */
    this.position = new THREE.Vector3()
    this.quaternion = new THREE.Quaternion()
    /** How far the ring's centre hangs off the arm's axis, mm. */
    this.dropMm = 0
    /** How far the ring is tipped off the arm's cross-section, rad. */
    this.tiltRad = 0
    this.contact = 0
    this.walls = { nearS: BACKSTOP_NEAR_MM, farS: BACKSTOP_FAR_MM }
    this.sleeping = false

    this.frame = new JewelleryFrame()
    this.inertia = new ArmInertia()
    // Sim-frame state: centre, orientation (body -> sim), velocities.
    this.x = new THREE.Vector3()
    this.q = new THREE.Quaternion()
    this.v = new THREE.Vector3()
    this.w = new THREE.Vector3()
    this._prevX = new THREE.Vector3()
    this._prevQ = new THREE.Quaternion()
    this._acc = 0
    this._rest = null
    this._stillFor = 0
    this._seated = false
    this._sweep = 0
    this._squeeze = 1
    this._samples = []
    this._lambda = new Float64Array(RING_SAMPLES)
    this._vnPre = new Float64Array(RING_SAMPLES)
    this._inContact = new Uint8Array(RING_SAMPLES)
    this._nx = new Float64Array(RING_SAMPLES)
    this._ny = new Float64Array(RING_SAMPLES)
    this._nz = new Float64Array(RING_SAMPLES)
    this._invI = new THREE.Vector3(1, 1, 1)
    this._invM = 1
    this._armAcc = new THREE.Vector3()
    this._armOmega = new THREE.Vector3()
    this._armAlpha = new THREE.Vector3()
  }

  reset() {
    this._seated = false
    this._rest = null
    this.frame.reset()
    this.inertia.reset()
    this.sleeping = false
  }

  /**
   * @param {object} asset
   * @param {object} fit          result from FitSolver
   * @param {import('../wrist/WristDigitalTwin.js').WristDigitalTwin} twin
   * @param {number} dt           seconds since the last call
   * @param {Array|object} [neighbours]  stacked pieces (world space), or the options
   * @param {{liveliness?: number, realistic?: boolean}} [options]
   */
  solve(asset, fit, twin, dt, neighbours = [], options = {}) {
    if (!Array.isArray(neighbours)) {
      options = neighbours ?? {}
      neighbours = []
    }
    const tune = tuningFrom(options)
    this._shape(asset, fit)

    const restarted = this.frame.begin(twin)
    const target = fit.restingOffsetMm
    if (this._rest === null || restarted) this._rest = target
    // A piece smaller than the arm here squeezes the skin instead of fighting it -
    // already while it is seated: settled against the full arm, a cuff smaller
    // than the wrist was pushed off it through its opening.
    const seating = !this._seated || restarted
    this._squeeze = fitSqueeze(twin, seating ? this._rest : this.x.y, fit.ringA, fit.ringB, asset.fit.clearanceMm * 0.3)
    if (seating) this._seat(asset, fit, twin, tune)

    _toSim.copy(this.frame.quaternion).invert()
    const stack = neighbours.map((nb) => nb.center.clone().sub(this.frame.origin).applyQuaternion(_toSim).y)
    this._squeeze = fitSqueeze(twin, this.x.y, fit.ringA, fit.ringB, asset.fit.clearanceMm * 0.3)
    this._acc = Math.min(this._acc + Math.max(0, dt), MAX_CATCH_UP_S)
    while (this._acc >= STEP_S) {
      this._rest += Math.max(-REST_GLIDE_MM_S * STEP_S, Math.min(REST_GLIDE_MM_S * STEP_S, target - this._rest))
      this._step(STEP_S, asset, fit, twin, tune, stack)
      this._acc -= STEP_S
    }
    this._publish(asset, fit)
    return this
  }

  // ------------------------------------------------------------------ setup

  /** Mass, inertia and the contact samples of this piece. */
  _shape(asset, fit) {
    if (this._shapeKey === `${asset.id}:${fit.ringA.toFixed(2)}:${fit.ringB.toFixed(2)}`) return
    this._shapeKey = `${asset.id}:${fit.ringA.toFixed(2)}:${fit.ringB.toFixed(2)}`
    const m = Math.max(1, asset.massG)
    const rho = asset.stockRadiusMm
    const A = fit.ringA + rho
    const B = fit.ringB + rho
    this._invM = 1 / m
    // Thin elliptical ring, centreline semi-axes A (x) and B (z), plus its stock.
    const tube = 0.6 * rho * rho
    this._invI.set(1 / (m * (B * B * 0.5 + tube)), 1 / (m * ((A * A + B * B) * 0.5 + tube)), 1 / (m * (A * A * 0.5 + tube)))
    // Contact points round the INNER edge; an open cuff has no metal in its gap.
    const gapHalf = asset.category === BraceletCategory.OPEN_CUFF && asset.opening
      ? asset.opening.gapMm / Math.max(1e-3, (fit.ringA + fit.ringB) * 0.5) / 2
      : 0
    this._samples = []
    for (let i = 0; i < RING_SAMPLES; i++) {
      const th = (i / RING_SAMPLES) * Math.PI * 2
      const inGap = gapHalf > 0 && Math.abs(Math.atan2(Math.sin(th), Math.cos(th))) < gapHalf
      this._samples.push(inGap ? null : new THREE.Vector3(Math.cos(th) * fit.ringA, 0, Math.sin(th) * fit.ringB))
    }
    this._seated = false
  }

  /**
   * Put the piece on the arm at its station, aligned with the arm's section,
   * and let it settle there out of sight, so it never visibly drops in.
   */
  _seat(asset, fit, twin, tune) {
    this.x.set(0, this._rest, 0)
    this.q.identity()
    this.v.set(0, 0, 0)
    this.w.set(0, 0, 0)
    this._prevX.copy(this.x)
    this._prevQ.copy(this.q)
    this._acc = 0
    this.sleeping = false
    this._stillFor = 0
    this._seated = true
    this._armAcc.set(0, 0, 0)
    this._armOmega.set(0, 0, 0)
    this._armAlpha.set(0, 0, 0)
    const n = Math.round(PRESETTLE_S / STEP_S)
    for (let i = 0; i < n; i++) this._step(STEP_S, asset, fit, twin, tune, [], true)
    this.inertia.reset()
  }

  // ------------------------------------------------------------------- step

  _step(h, asset, fit, twin, tune, stack, settling = false) {
    const frame = this.frame
    if (!settling) {
      frame.step(h, tune.twistFollowHz)
      this.inertia.update(frame.matrix, h, tune.inertia)
      _toSim.copy(frame.quaternion).invert()
      this._armAcc.copy(this.inertia.linearAcc).applyQuaternion(_toSim)
      this._armOmega.copy(this.inertia.omega).applyQuaternion(_toSim)
      this._armAlpha.copy(this.inertia.angularAcc).applyQuaternion(_toSim)
    }
    const armMoving = this._armAcc.lengthSq() > 0 || this._armOmega.lengthSq() > 0 || this._armAlpha.lengthSq() > 0

    // --- Sleep: a resting piece on a still arm does not move at all --------
    if (this.sleeping) {
      const restMoved = Math.abs(this._rest - this.x.y) > 0.3 && tune.axialHold > 0
      const shapeMoved = Math.abs(twin.wristWidthMm + twin.wristDepthMm - this._sleepShape) > 0.3
      if (!armMoving && !restMoved && !shapeMoved) {
        this._prevX.copy(this.x)
        this._prevQ.copy(this.q)
        return
      }
      this.sleeping = false
      this._stillFor = 0
    }

    // --- Forces: gravity and the arm's own motion (fictitious forces) -----
    _g.copy(DOWN).applyQuaternion(_toSim).multiplyScalar(GRAVITY_MM_S2).sub(this._armAcc)
    if (settling) _g.copy(DOWN).applyQuaternion(_q.copy(frame.quaternion).invert()).multiplyScalar(GRAVITY_MM_S2)
    _a.copy(_g)
    if (armMoving) {
      // Euler, centrifugal and Coriolis terms of the moving frame, at the centre.
      _a.sub(_t.crossVectors(this._armAlpha, this.x))
      _a.sub(_t.crossVectors(this._armOmega, _t2.crossVectors(this._armOmega, this.x)))
      _a.addScaledVector(_t.crossVectors(this._armOmega, this.v), -2)
      this.w.addScaledVector(this._armAlpha, -h)
    }
    this.v.addScaledVector(_a, h).multiplyScalar(Math.exp(-tune.linearDamping * h))
    this.w.multiplyScalar(Math.exp(-tune.angularDamping * h))

    // Speed of each point toward the arm's axis before the step, for the
    // bounce (the outward direction from the axis stands in for the contact
    // normal, which is not known until the point touches).
    for (let i = 0; i < RING_SAMPLES; i++) {
      this._lambda[i] = 0
      this._inContact[i] = 0
      const P = this._samples[i]
      if (!P) continue
      _r.copy(P).applyQuaternion(this.q)
      _p.copy(this.x).add(_r)
      const len = Math.hypot(_p.x, _p.z) || 1
      _vp.crossVectors(this.w, _r).add(this.v)
      this._vnPre[i] = (_vp.x * _p.x + _vp.z * _p.z) / len
    }

    this._prevX.copy(this.x)
    this._prevQ.copy(this.q)
    this.x.addScaledVector(this.v, h)
    integrate(this.q, this.w, h)

    // --- Constraints ------------------------------------------------------
    const pad = asset.fit.clearanceMm * 0.3
    const rho = asset.stockRadiusMm
    // Backstops only (walls.js): the flares in the contact surface are what
    // stop a piece at the hand and toward the elbow.
    const near = BACKSTOP_NEAR_MM + rho
    const far = BACKSTOP_FAR_MM - rho
    const cuff = asset.category === BraceletCategory.OPEN_CUFF
    if (cuff) {
      // A cuff springs onto the wrist: centred on the arm, turned with it (with
      // the twist this frame follows).
      const k = 1 - Math.exp(-CUFF_GRIP * h)
      this.x.x -= this.x.x * k
      this.x.z -= this.x.z * k
      this.x.y += (this._rest - this.x.y) * k
      this.q.slerp(_q.identity(), k)
    } else if (tune.axialHold > 0) {
      this.x.y += (this._rest - this.x.y) * (1 - Math.exp(-tune.axialHold * h))
    }
    // Contacts are resolved one after another; a fixed order lets the first
    // points always win and cocks a ring that should land level. The order
    // alternates direction every pass and its start moves every step.
    this._sweep = (this._sweep + 7) % RING_SAMPLES
    for (let it = 0; it < ITERATIONS; it++) {
      for (let k = 0; k < RING_SAMPLES; k++) {
        const i = it % 2 === 0 ? (this._sweep + k) % RING_SAMPLES : (this._sweep + RING_SAMPLES - 1 - k) % RING_SAMPLES
        const P = this._samples[i]
        if (!P) continue
        _r.copy(P).applyQuaternion(this.q)
        _p.copy(this.x).add(_r)
        // Where the point was before the step: tunnelled points go back out that side.
        _from.copy(P).applyQuaternion(this._prevQ).add(this._prevX)
        if (armContact(_p, twin, 0, pad, _from, _contact, true, this._squeeze)) {
          _n.set(_contact.nx, _contact.ny, _contact.nz)
          const c = (_contact.x - _p.x) * _n.x + (_contact.z - _p.z) * _n.z
          if (c > 0) {
            this._lambda[i] += this._applyPositional(_r, _n, c)
            this._inContact[i] = 1
            this._nx[i] = _n.x
            this._ny[i] = _n.y
            this._nz[i] = _n.z
            this._staticFriction(P, _n, _from, this._lambda[i], tune.frictionStatic)
          }
        }
        // Backstop planes: the band of metal, not just the centreline.
        const y = this.x.y + _r.y
        if (y < near) this._applyPositional(_r, _n.set(0, 1, 0), near - y)
        else if (y > far) this._applyPositional(_r, _n.set(0, -1, 0), y - far)
      }
      this._limitTilt(tune.maxTiltRad)
      for (const s of stack) {
        const gap = rho * 2 + 1.6
        const d = this.x.y - s
        if (Math.abs(d) < gap) this.x.y = s + Math.sign(d || 1) * gap
      }
    }

    // --- Velocities from the positions, then friction and bounce ------------
    this.v.subVectors(this.x, this._prevX).multiplyScalar(1 / h)
    _q.copy(this.q).multiply(_qi.copy(this._prevQ).invert())
    if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w)
    this.w.set(_q.x, _q.y, _q.z).multiplyScalar(2 / h)
    this._contactVelocities(h, tune)
    if (this.v.length() > MAX_SPEED_MM_S) this.v.setLength(MAX_SPEED_MM_S)
    if (this.w.length() > MAX_SPIN_RAD_S) this.w.setLength(MAX_SPIN_RAD_S)

    // --- Sleep bookkeeping ------------------------------------------------
    const calm = !armMoving && this.v.length() < SLEEP_SPEED_MM_S && this.w.length() < SLEEP_SPIN_RAD_S
    this._stillFor = calm ? this._stillFor + h : 0
    if (!settling && this._stillFor > SLEEP_AFTER_S) {
      this.sleeping = true
      this._sleepShape = twin.wristWidthMm + twin.wristDepthMm
      this.v.set(0, 0, 0)
      this.w.set(0, 0, 0)
    }
  }

  /**
   * Move the body so that the point at offset r moves by c along n: position
   * and orientation share the correction by their generalised inverse masses.
   * @returns {number} the positional impulse (lambda)
   */
  _applyPositional(r, n, c) {
    _rn.crossVectors(r, n)
    const w = this._invM + this._dotInvI(_rn, _rn)
    if (!(w > 0)) return 0
    const lambda = c / w
    this.x.addScaledVector(n, lambda * this._invM)
    this._applyInvI(_rn, _dw).multiplyScalar(lambda)
    rotateBy(this.q, _dw)
    return lambda
  }

  /**
   * Static skin friction, positional (Muller et al. 2020): if cancelling the
   * contact point's slip since the start of the step needs no more than the
   * static cone of the push the arm gave it, cancel it - the point sticks.
   * Friction applied only to velocities cannot undo the turn that the
   * position corrections themselves put in, and a ring jammed on the arm
   * wound itself round the wrist that way.
   */
  _staticFriction(P, n, from, lambdaN, mu) {
    _r.copy(P).applyQuaternion(this.q)
    _slip.copy(this.x).add(_r).sub(from)
    _slip.addScaledVector(n, -_slip.dot(n))
    const slip = _slip.length()
    if (slip < 1e-9) return
    _slip.multiplyScalar(1 / slip)
    if (slip / this._invMassAlong(_r, _slip) < mu * lambdaN) this._applyPositional(_r, _slip, -slip)
  }

  /** Keep the ring within maxTilt of the arm's cross-section. */
  _limitTilt(maxTilt) {
    _t.copy(Y).applyQuaternion(this.q)
    const cos = Math.min(1, Math.abs(_t.y))
    const tilt = Math.acos(cos)
    if (tilt <= maxTilt) return
    // Rotate the ring's axis back toward the arm's, about their common normal.
    _t2.copy(_t.y >= 0 ? Y : _n.set(0, -1, 0))
    _dw.crossVectors(_t, _t2)
    const len = _dw.length()
    if (len < 1e-9) return
    _dw.multiplyScalar((tilt - maxTilt) / len)
    rotateBy(this.q, _dw)
  }

  /** Coulomb friction and a soft bounce at the arm contacts, as velocity impulses. */
  _contactVelocities(h, tune) {
    for (let i = 0; i < RING_SAMPLES; i++) {
      if (!this._inContact[i]) continue
      const P = this._samples[i]
      _r.copy(P).applyQuaternion(this.q)
      _n.set(this._nx[i], this._ny[i], this._nz[i])
      _vp.crossVectors(this.w, _r).add(this.v)
      const vn = _vp.dot(_n)
      // Bounce: only off a real knock, never off resting contact.
      const pre = this._vnPre[i]
      if (pre < -BOUNCE_MIN_MM_S) {
        const want = -tune.restitution * pre
        if (want > vn) this._applyImpulse(_r, _n, (want - vn) / this._invMassAlong(_r, _n))
      }
      // Friction against the skin: stick while the needed impulse is within
      // the static cone, else slide with the kinetic one.
      _vp.crossVectors(this.w, _r).add(this.v)
      _t.copy(_vp).addScaledVector(_n, -_vp.dot(_n))
      const vt = _t.length()
      if (vt < 1e-6) continue
      _t.multiplyScalar(1 / vt)
      const jn = this._lambda[i] / h
      const jStop = vt / this._invMassAlong(_r, _t)
      const j = jStop <= tune.frictionStatic * jn ? jStop : tune.frictionKinetic * jn
      this._applyImpulse(_r, _t, -j)
    }
  }

  _invMassAlong(r, dir) {
    _rn.crossVectors(r, dir)
    return this._invM + this._dotInvI(_rn, _rn)
  }

  _applyImpulse(r, dir, j) {
    this.v.addScaledVector(dir, j * this._invM)
    _rn.crossVectors(r, dir)
    this.w.add(this._applyInvI(_rn, _dw).multiplyScalar(j))
  }

  /** out = I^-1 v, with I the body inertia turned into the sim frame. */
  _applyInvI(v, out) {
    _qi.copy(this.q).invert()
    out.copy(v).applyQuaternion(_qi)
    out.x *= this._invI.x
    out.y *= this._invI.y
    out.z *= this._invI.z
    return out.applyQuaternion(this.q)
  }

  _dotInvI(a, b) {
    return this._applyInvI(a, _vp.copy(a)).dot(b)
  }

  // --------------------------------------------------------------- publish

  _publish(asset, fit) {
    const alpha = this._acc / STEP_S
    _p.copy(this._prevX).lerp(this.x, alpha)
    _q.copy(this._prevQ).slerp(this.q, alpha)
    this.dropMm = Math.hypot(_p.x, _p.z)
    _t.copy(Y).applyQuaternion(_q)
    this.tiltRad = Math.acos(Math.min(1, Math.abs(_t.y)))
    this.position.copy(_p).applyMatrix4(this.frame.matrix)
    this.quaternion.copy(this.frame.quaternion).multiply(_q)
    // Open cuffs have a defined opening bearing around the forearm axis.
    if (asset.opening && asset.category === BraceletCategory.OPEN_CUFF) {
      _qi.setFromAxisAngle(Y, THREE.MathUtils.degToRad(asset.opening.bearingDeg))
      this.quaternion.multiply(_qi)
    }
    this.contact = Math.min(1, Math.max(0, 1 - fit.gapMm / 4))
  }
}

/** q <- exp(w h / 2) q, w in the sim frame. */
function integrate(q, w, h) {
  const angle = w.length() * h
  if (angle < 1e-12) return
  _t.copy(w).normalize()
  _q.setFromAxisAngle(_t, angle)
  q.premultiply(_q).normalize()
}

/** q <- rotation by the (small) rotation vector dw, then q. */
function rotateBy(q, dw) {
  const angle = dw.length()
  if (angle < 1e-12) return
  _qi.setFromAxisAngle(_t2.copy(dw).multiplyScalar(1 / angle), angle)
  q.premultiply(_qi).normalize()
}
