import * as THREE from 'three'
import { BACKSTOP_NEAR_MM, BACKSTOP_FAR_MM } from './walls.js'
import { ArmInertia } from './ArmInertia.js'
import { JewelleryFrame } from './JewelleryFrame.js'
import { armContact, armSection } from './armTube.js'
import { tuningFrom } from './tuning.js'
import { BraceletCategory } from '../assets/schema.js'

/**
 * Fixed simulation step, s. XPBD converges best with many small steps and a
 * single constraint pass each (Macklin et al., "Small Steps in Physics
 * Simulation", 2019): stiffer links, less artificial damping, and the result
 * no longer depends on how often the display asks for a frame.
 */
const STEP_S = 1 / 600
const MAX_CATCH_UP_S = 0.1
const GRAVITY_MM_S2 = 9810
const DOWN = new THREE.Vector3(0, -1, 0)
/** The loop settles here when first put on the arm, out of sight, s. */
const PRESETTLE_S = 0.8
/** The resting station moves at most this fast when the fit changes it, mm/s. */
const REST_GLIDE_MM_S = 40
/** Hard limit on a link's speed: a last line of defence, never reached in normal use, mm/s. */
const MAX_SPEED_MM_S = 3000
/** A chain lies on skin all round, so it follows the arm's twist faster than a loose bangle. */
const CHAIN_TWIST_FOLLOW = 1.6

const _d = new THREE.Vector3()
const _v = new THREE.Vector3()
const _acc = new THREE.Vector3()
const _tmp = new THREE.Vector3()
const _tmp2 = new THREE.Vector3()
const _toSim = new THREE.Quaternion()
const _g = new THREE.Vector3()
const _w = new THREE.Vector3()
const _alpha = new THREE.Vector3()
const _contact = { x: 0, z: 0, nx: 0, ny: 0, nz: 0, depth: 0 }

/**
 * Move `p` out of the arm along the contact normal, by the depth measured
 * along it (armContact's surface point is straight out from the axis; on a
 * slope the normal reaches the surface sooner). Returns that depth.
 */
function pushAlongNormal(p, contact) {
  const c = (contact.x - p.x) * contact.nx + (contact.z - p.z) * contact.nz
  if (!(c > 0)) return 0
  p.x += contact.nx * c
  p.y += contact.ny * c
  p.z += contact.nz * c
  return c
}
const _section = { a: 0, b: 0 }

/**
 * XPBD solver for articulated jewellery: tennis bracelets, chains, charms.
 *
 * A chain is particles joined by inextensible links, with bending that
 * depends on the piece - a tennis bracelet's hinged links curve round the
 * wrist but keep the band flat along the arm; a rope chain drapes both ways -
 * colliding with the arm's tube, held by skin friction, bounded by the two
 * wall planes, and charms hang from their links as pendulums that pull on them.
 *
 * It runs in the JewelleryFrame (the arm frame with its twist followed
 * softly), so tracking noise can neither shake the tube through the links nor
 * turn the loop round the wrist; the arm's real motion reaches it as the
 * fictitious forces of that frame, filtered (ArmInertia). Fixed 600 Hz steps,
 * interpolated for display.
 *
 * Published every solve:
 *   local       link positions in the ARM's frame (twin.frameMatrix), which is
 *               also `frame`, the matrix the renderer draws them under
 *   particles   the same in world space
 *   charms[].local / .position   likewise
 */
export class XPBDChainSolver {
  constructor() {
    this.local = []
    this.particles = []
    this.invMass = []
    this.charms = []
    this.linkLength = 5
    this.initialised = false
    this.maxContact = 0
    /** Arm frame the published `local` is expressed in (the renderer's matrix). */
    this.frame = new THREE.Matrix4()
    this.frameQuaternion = new THREE.Quaternion()
    this.jframe = new JewelleryFrame()
    this.inertia = new ArmInertia()
    /**
     * Times the loop was found not to go round the arm and was re-seated.
     * A safety net that should never fire; counted so it is visible if it does.
     */
    this.recoveries = 0
    this.walls = { nearS: BACKSTOP_NEAR_MM, farS: BACKSTOP_FAR_MM }

    /** Link positions in the simulation's own frame (JewelleryFrame): the physical state. */
    this.sim = []
    this._vel = []
    this._prev = []
    this._contactDepth = new Float32Array(0)
    this._acc = 0
    this._rest = null
    this._g = new THREE.Vector3()
    this._w = new THREE.Vector3()
    this._alpha = new THREE.Vector3()
    this._forward = false
    this._squeeze = 1
  }

  reset() {
    this.initialised = false
    this._rest = null
    this.jframe.reset()
    this.inertia.reset()
  }

  /**
   * @param {object} asset
   * @param {object} fit
   * @param {import('../wrist/WristDigitalTwin.js').WristDigitalTwin} twin
   * @param {number} dt seconds since the last call
   * @param {Array<{center:THREE.Vector3,axis:THREE.Vector3,radiusA:number,radiusB:number,stockRadiusMm:number}>} neighbours
   *        other bracelets in the stack (world space)
   * @param {{liveliness?: number, realistic?: boolean}} [options]
   */
  solve(asset, fit, twin, dt, neighbours = [], options = {}) {
    const tune = tuningFrom(options)
    const restarted = this.jframe.begin(twin)
    const target = fit.restingOffsetMm
    if (this._rest === null || restarted) this._rest = target
    if (!this.initialised || restarted || this.sim.length !== asset.links.count) {
      this._initialise(asset, fit, twin, tune)
    }

    _toSim.copy(this.jframe.quaternion).invert()
    const stack = neighbours.map((nb) => nb.center.clone().sub(this.jframe.origin).applyQuaternion(_toSim).y)

    // Skin gives (armTube fitSqueeze): a loop shorter than the arm is round
    // cannot close outside it; the arm is squeezed to fit, not fought.
    armSection(twin, this._rest, _section)
    const pad = asset.stockRadiusMm + asset.fit.clearanceMm * 0.3
    const loopR = asset.innerCircumferenceMm / (2 * Math.PI)
    this._squeeze = Math.min(1, Math.max(0.5, (loopR * 0.97 - pad) / Math.max(1e-3, (_section.a + _section.b) / 2)))

    this.maxContact = 0
    this._acc = Math.min(this._acc + Math.max(0, dt), MAX_CATCH_UP_S)
    while (this._acc >= STEP_S) {
      this._rest += Math.max(-REST_GLIDE_MM_S * STEP_S, Math.min(REST_GLIDE_MM_S * STEP_S, target - this._rest))
      this._step(STEP_S, asset, fit, twin, tune, stack)
      this._acc -= STEP_S
    }

    // Safety net: the loop must still go once round the arm.
    if (Math.abs(this._winding(fit)) !== 1) {
      this.recoveries++
      this._seat(fit)
    }

    twin.frameMatrix(this.frame)
    this.frameQuaternion.setFromRotationMatrix(this.frame)
    this._publish()
    return this
  }

  // ------------------------------------------------------------------ setup

  _initialise(asset, fit, twin, tune) {
    const n = asset.links.count
    this.linkLength = asset.innerCircumferenceMm / n
    const massPerLink = Math.max(1e-3, asset.massG / n)
    this.sim = Array.from({ length: n }, () => new THREE.Vector3())
    this._vel = Array.from({ length: n }, () => new THREE.Vector3())
    this._prev = Array.from({ length: n }, () => new THREE.Vector3())
    this.local = Array.from({ length: n }, () => new THREE.Vector3())
    this.particles = Array.from({ length: n }, () => new THREE.Vector3())
    this.invMass = Array.from({ length: n }, () => 1 / massPerLink)
    this._contactDepth = new Float32Array(n)
    this._bending(asset, fit)
    this._seat(fit)
    this.charms = (asset.charms ?? []).map((charm) => {
      const index = charm.linkIndex % n
      const x = this.sim[index].clone()
      return {
        spec: charm,
        index,
        x,
        vel: new THREE.Vector3(),
        prev: x.clone(),
        local: new THREE.Vector3(),
        position: new THREE.Vector3(),
        invMass: 1 / Math.max(1e-3, charm.massG),
      }
    })
    this._hangCharms()
    this.initialised = true
    // Let it come to rest on the arm before anyone sees it.
    const steps = Math.round(PRESETTLE_S / STEP_S)
    for (let i = 0; i < steps; i++) this._step(STEP_S, asset, fit, twin, tune, [], true)
    this.inertia.reset()
    this._acc = 0
  }

  /**
   * Bending compliance (s^2/g). Stiffness 0..1 from the asset maps onto four
   * decades: a tennis bracelet (0.72) holds its arc, a rope chain (0.12) is
   * limp. Across the arm the rest shape is the loop's own curve (see
   * _solveBend) - straightening toward zero curvature fought the loop's
   * closure and threw a stiff bracelet about. Along the arm a tennis band
   * stays flat; a chain bends as freely that way as the other.
   */
  _bending(asset, fit) {
    const s = Math.min(1, Math.max(0, asset.links.bendStiffness ?? 0.5))
    this._bendCompliance = 10 ** (-6 + 4 * (1 - s))
    this._flatCompliance = asset.category === BraceletCategory.TENNIS ? 1e-7 : this._bendCompliance
    // A link's offset from its neighbours' midpoint on the rest loop (a circle
    // of the bracelet's length): R (1 - cos(2 pi / n)).
    const n = asset.links.count
    const R = asset.innerCircumferenceMm / (2 * Math.PI)
    this._restBend = R * (1 - Math.cos((2 * Math.PI) / n))
  }

  /** Lay the loop round the arm, at rest, at its station, aligned with the arm's section. */
  _seat(fit) {
    const n = this.sim.length
    for (let i = 0; i < n; i++) {
      const phi = (i / n) * Math.PI * 2
      this.sim[i].set(Math.cos(phi) * fit.ringA, this._rest ?? fit.restingOffsetMm, Math.sin(phi) * fit.ringB)
      this._vel[i].set(0, 0, 0)
      this._prev[i].copy(this.sim[i])
    }
    this._hangCharms()
  }

  /** Charms start hanging straight down from their links. */
  _hangCharms() {
    _d.copy(DOWN).applyQuaternion(_toSim.copy(this.jframe.quaternion).invert())
    for (const charm of this.charms) {
      charm.x.copy(this.sim[charm.index]).addScaledVector(_d, charm.spec.dropMm)
      charm.vel.set(0, 0, 0)
      charm.prev.copy(charm.x)
    }
  }

  // ------------------------------------------------------------------- step

  _step(h, asset, fit, twin, tune, stack, settling = false) {
    const jf = this.jframe
    if (settling) {
      _g.copy(DOWN).applyQuaternion(_toSim.copy(jf.quaternion).invert()).multiplyScalar(GRAVITY_MM_S2)
      _w.set(0, 0, 0)
      _alpha.set(0, 0, 0)
    } else {
      jf.step(h, tune.twistFollowHz * CHAIN_TWIST_FOLLOW)
      this.inertia.update(jf.matrix, h, tune.inertia)
      _toSim.copy(jf.quaternion).invert()
      _g.copy(DOWN).multiplyScalar(GRAVITY_MM_S2).sub(this.inertia.linearAcc).applyQuaternion(_toSim)
      _w.copy(this.inertia.omega).applyQuaternion(_toSim)
      _alpha.copy(this.inertia.angularAcc).applyQuaternion(_toSim)
    }
    const spin = _w.lengthSq() > 0 || _alpha.lengthSq() > 0
    const damp = Math.exp(-tune.linearDamping * h)

    // --- Predict ---------------------------------------------------------
    for (let i = 0; i < this.sim.length; i++) {
      const x = this.sim[i]
      const v = this._vel[i]
      this._field(x, v, spin, _acc)
      v.addScaledVector(_acc, h).multiplyScalar(damp)
      this._prev[i].copy(x)
      x.addScaledVector(v, h)
    }
    for (const charm of this.charms) {
      this._field(charm.x, charm.vel, spin, _acc)
      charm.vel.addScaledVector(_acc, h).multiplyScalar(damp)
      charm.prev.copy(charm.x)
      charm.x.addScaledVector(charm.vel, h)
    }

    // --- Constraints (one pass: small steps do the converging) -----------
    this._contactDepth.fill(0)
    this._solveDistance()
    this._solveBend(h)
    this._solveCharms()
    this._solveAxial(asset, tune, h)
    for (const s of stack) this._solveNeighbour(s, asset)
    // Hard constraints last, so nothing after them can pull a link back in -
    // twice, with the links' length restored in between: collision moves
    // links freely, and a visibly stretching chain reads as fake at once.
    this._solveArm(asset, twin)
    this._solveWalls(asset)
    this._solveDistance()
    this._solveArm(asset, twin)
    this._solveWalls(asset)
    this._solveFriction(tune)

    // --- Velocities from positions -----------------------------------------
    const inv = 1 / h
    for (let i = 0; i < this.sim.length; i++) {
      const v = this._vel[i].subVectors(this.sim[i], this._prev[i]).multiplyScalar(inv)
      if (v.lengthSq() > MAX_SPEED_MM_S * MAX_SPEED_MM_S) v.setLength(MAX_SPEED_MM_S)
    }
    for (const charm of this.charms) {
      charm.vel.subVectors(charm.x, charm.prev).multiplyScalar(inv)
      if (charm.vel.lengthSq() > MAX_SPEED_MM_S * MAX_SPEED_MM_S) charm.vel.setLength(MAX_SPEED_MM_S)
    }
  }

  /**
   * Acceleration of a point at r moving at v in the sim frame:
   *   a = g - alpha x r - w x (w x r) - 2 w x v
   * (uniform field, Euler, centrifugal, Coriolis), all from the filtered arm
   * motion, so still-arm jitter contributes exactly nothing.
   */
  _field(r, v, spin, out) {
    out.copy(_g)
    if (!spin) return out
    out.sub(_tmp.crossVectors(_alpha, r))
    out.sub(_tmp.crossVectors(_w, _tmp2.crossVectors(_w, r)))
    out.addScaledVector(_tmp.crossVectors(_w, v), -2)
    return out
  }

  /**
   * Gauss-Seidel sweeps alternate direction: always sweeping the loop the same
   * way round leaves a small bias that, on a closed loop, accumulates into
   * the bracelet creeping round the wrist on its own.
   */
  _flipSweep() {
    this._forward = !this._forward
    return this._forward
  }

  /** Inextensible links (zero compliance). */
  _solveDistance() {
    const pts = this.sim
    const n = pts.length
    const rest = this.linkLength
    const forward = this._flipSweep()
    for (let k = 0; k < n; k++) {
      const i = forward ? k : n - 1 - k
      const j = (i + 1) % n
      const a = pts[i]
      const b = pts[j]
      _d.subVectors(b, a)
      const len = _d.length()
      if (len < 1e-6) continue
      const wa = this.invMass[i]
      const wb = this.invMass[j]
      const c = (len - rest) / len / (wa + wb)
      a.addScaledVector(_d, c * wa)
      b.addScaledVector(_d, -c * wb)
    }
  }

  /**
   * Bending as XPBD constraints on each link's offset from the midpoint of its
   * neighbours - along the arm (y: keeps a tennis band flat) and across it
   * (x, z: holds the curve, relative to the rest loop's own curvature, which
   * bows outward, away from the arm) - each with its own compliance. The
   * gradient weights (1, -1/2, -1/2) cancel, so bending never shifts the loop
   * as a whole round the arm.
   */
  _solveBend(h) {
    const pts = this.sim
    const n = pts.length
    const aFlat = this._flatCompliance / (h * h)
    const aBend = this._bendCompliance / (h * h)
    const bow = this._restBend
    const forward = this._flipSweep()
    for (let k = 0; k < n; k++) {
      const i = forward ? k : n - 1 - k
      const ip = (i - 1 + n) % n
      const inx = (i + 1) % n
      const prev = pts[ip]
      const cur = pts[i]
      const next = pts[inx]
      const w = this.invMass[i] + (this.invMass[ip] + this.invMass[inx]) * 0.25
      _d.addVectors(prev, next).multiplyScalar(0.5).sub(cur) // -C
      // Rest offset: `bow` along the chord's perpendicular that points away
      // from the arm (the side the link itself is on).
      let px = -(next.z - prev.z)
      let pz = next.x - prev.x
      const pl = Math.hypot(px, pz)
      if (pl > 1e-9) {
        if (px * cur.x + pz * cur.z < 0) {
          px = -px
          pz = -pz
        }
        _d.x += (px / pl) * bow
        _d.z += (pz / pl) * bow
      }
      const sy = _d.y / (w + aFlat)
      const sxz = 1 / (w + aBend)
      const dx = _d.x * sxz
      const dz = _d.z * sxz
      cur.x += dx * this.invMass[i]
      cur.y += sy * this.invMass[i]
      cur.z += dz * this.invMass[i]
      prev.x -= dx * this.invMass[ip] * 0.5
      prev.y -= sy * this.invMass[ip] * 0.5
      prev.z -= dz * this.invMass[ip] * 0.5
      next.x -= dx * this.invMass[inx] * 0.5
      next.y -= sy * this.invMass[inx] * 0.5
      next.z -= dz * this.invMass[inx] * 0.5
    }
  }

  /** Charms on rigid pivots: two-way, so a heavy charm pulls its link down. */
  _solveCharms() {
    for (const charm of this.charms) {
      const link = this.sim[charm.index]
      _d.subVectors(charm.x, link)
      const len = _d.length()
      if (len < 1e-6) continue
      const wl = this.invMass[charm.index]
      const wc = charm.invMass
      const c = (len - charm.spec.dropMm) / len / (wl + wc)
      link.addScaledVector(_d, c * wl)
      charm.x.addScaledVector(_d, -c * wc)
    }
  }

  /**
   * Along the arm: the pull toward the resting station, if the tuning has one
   * (tuning.js axialHold - none by default). There is no band round the
   * station any more: a loop slides freely until friction holds it or a flare
   * stops it (walls.js); the band pinned every chain within ~8 mm of one spot.
   */
  _solveAxial(asset, tune, h) {
    if (!(tune.axialHold > 0)) return
    const rest = this._rest
    const hold = 1 - Math.exp(-tune.axialHold * h)
    for (const p of this.sim) p.y -= (p.y - rest) * hold
  }

  /** Keep stacked bracelets from occupying the same stretch of arm. */
  _solveNeighbour(stationY, asset) {
    const minDist = asset.stockRadiusMm * 2 + 0.4
    for (const p of this.sim) {
      const d = p.y - stationY
      if (Math.abs(d) < minDist) p.y = stationY + Math.sign(d || 1) * minDist
    }
  }

  /**
   * Push links (and charms) out of the arm; how hard is the friction budget.
   * Along the surface's true normal: on the arm's cylinder that is straight
   * out, on the hand flare (walls.js) it is out AND back up the arm - the
   * slope a loop that slid down comes to rest on.
   */
  _solveArm(asset, twin) {
    const pad = asset.stockRadiusMm + asset.fit.clearanceMm * 0.3
    for (let i = 0; i < this.sim.length; i++) {
      const p = this.sim[i]
      if (!armContact(p, twin, 0, pad, this._prev[i], _contact, true, this._squeeze)) continue
      const c = pushAlongNormal(p, _contact)
      this._contactDepth[i] += c
      this.maxContact = Math.max(this.maxContact, Math.min(1, c / pad))
    }
    for (const charm of this.charms) {
      if (armContact(charm.x, twin, 0, charm.spec.sizeMm * 0.4, charm.prev, _contact, true, this._squeeze)) {
        pushAlongNormal(charm.x, _contact)
      }
    }
  }

  /** The backstop planes (walls.js): in this frame simply y = near and y = far. The flares in the contact surface stop links first. */
  _solveWalls(asset) {
    const pad = asset.stockRadiusMm
    const near = BACKSTOP_NEAR_MM + pad
    const far = BACKSTOP_FAR_MM - pad
    for (const p of this.sim) {
      if (p.y < near) p.y = near
      else if (p.y > far) p.y = far
    }
  }

  /**
   * Skin friction (position-based Coulomb friction, Macklin et al. 2014), for
   * the links the arm pushed on this step: their slip over the skin is
   * cancelled while it is within the static cone of that push, and reduced by
   * the kinetic one beyond it. A uniform loop round an arm is in neutral
   * equilibrium at any rotation; without this, the tiniest bias turns it.
   */
  _solveFriction(tune) {
    for (let i = 0; i < this.sim.length; i++) {
      const depth = this._contactDepth[i]
      if (depth <= 0) continue
      const p = this.sim[i]
      // Outward direction from the arm's axis stands in for the normal.
      const len = Math.hypot(p.x, p.z)
      if (len < 1e-6) continue
      const nx = p.x / len
      const nz = p.z / len
      _d.subVectors(p, this._prev[i])
      const dn = _d.x * nx + _d.z * nz
      _d.x -= dn * nx
      _d.z -= dn * nz
      const slip = _d.length()
      if (slip < 1e-9) continue
      if (slip <= tune.frictionStatic * depth) p.sub(_d)
      else p.addScaledVector(_d, -Math.min(1, (tune.frictionKinetic * depth) / slip))
    }
  }

  /**
   * How many times the loop goes round the arm's axis, on the normalised
   * ellipse. 1 or -1: on the arm; 0: off it.
   */
  _winding(fit) {
    const pts = this.sim
    const n = pts.length
    if (n < 3) return 1
    const A = Math.max(1, fit.ringA)
    const B = Math.max(1, fit.ringB)
    let total = 0
    let prev = Math.atan2(pts[n - 1].z / B, pts[n - 1].x / A)
    for (let i = 0; i < n; i++) {
      const ang = Math.atan2(pts[i].z / B, pts[i].x / A)
      let d = ang - prev
      if (d > Math.PI) d -= 2 * Math.PI
      else if (d < -Math.PI) d += 2 * Math.PI
      total += d
      prev = ang
    }
    return Math.round(total / (2 * Math.PI))
  }

  // --------------------------------------------------------------- publish

  /**
   * Interpolate between the last two steps to the display time, express the
   * result in the arm frame (the renderer's matrix) and in world space.
   */
  _publish() {
    const alpha = this._acc / STEP_S
    for (let i = 0; i < this.sim.length; i++) {
      const l = this.local[i].copy(this._prev[i]).lerp(this.sim[i], alpha)
      this.jframe.toArm(l)
      this.particles[i].copy(l).applyMatrix4(this.frame)
    }
    for (const charm of this.charms) {
      charm.local.copy(charm.prev).lerp(charm.x, alpha)
      this.jframe.toArm(charm.local)
      charm.position.copy(charm.local).applyMatrix4(this.frame)
    }
  }
}
