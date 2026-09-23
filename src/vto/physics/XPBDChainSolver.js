import * as THREE from 'three'
import { WALL_NEAR_MM, WALL_FAR_MM } from './walls.js'
import { ArmInertia, INERTIA_REALISTIC, INERTIA_STABLE } from './ArmInertia.js'
import { clamp } from '../core/mathUtils.js'

const _d = new THREE.Vector3()
const _v = new THREE.Vector3()
const _acc = new THREE.Vector3()
const _tmp = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _toArm = new THREE.Quaternion()
const _n = new THREE.Vector3()

const GRAVITY_MM_S2 = 9810 // mm/s^2
const DOWN = new THREE.Vector3(0, -1, 0)

/** Arm-space stations the tube is modelled over (the collision surface). */
const TUBE_MIN_S = -10
const TUBE_MAX_S = 120

/**
 * Deeper than this inside the arm (in ellipse units, f = r^2 / R^2) a link
 * cannot have got by sliding over the skin: it was knocked through. It is put
 * back out on the side it came from, not the side it happens to be on.
 */
const TUNNEL_F = 0.36

/** Metal on skin: friction coefficients (static holds, kinetic slows a slide). */
const MU_STATIC = 0.7
const MU_KINETIC = 0.45

/**
 * XPBD solver for articulated jewellery: tennis bracelets, chains, charms.
 *
 * A chain is not a torus. It hangs, it sags under the wrist, it slides around
 * when the arm turns, and its charms swing. Modelling it as particles with
 * distance and bend constraints, colliding against the wrist twin, is what
 * produces that for free.
 *
 * THE SIMULATION RUNS IN ARM SPACE (WristDigitalTwin.frameMatrix): the tube,
 * its two wall planes and every link are expressed in the arm's own frame,
 * where the arm never moves. Tracking jitter therefore cannot teleport the
 * tube through the links - which, in world space, is exactly how a chain got
 * knocked off the wrist: a pose step the size of the wrist's radius put links
 * past the arm's axis, collision pushed them out the wrong side, and the loop
 * no longer went round the arm.
 *
 * The arm's real motion still reaches the chain, as the fictitious forces of
 * a moving frame, filtered so that only genuine motion does (ArmInertia).
 * `particles` / `charms[].position` are published in world space every solve
 * for anything that wants them; the renderer draws straight from arm space.
 */
export class XPBDChainSolver {
  constructor() {
    /** Arm-space state: x radial, y along the arm (mm from the crease), z dorsal. */
    this.local = []
    this.prevLocal = []
    /** World-space copy of `local`, refreshed at the end of every solve. */
    this.particles = []
    this.invMass = []
    this.charms = []
    this.linkLength = 5
    this.initialised = false
    this.substeps = 4
    // Loose, heavy-sag loops need more Gauss-Seidel passes than a stiff tennis
    // bracelet does; this is the budget that converges the worst case.
    this.iterations = 5
    this.bendStiffness = 0.5
    this.damping = 0.06
    this.maxContact = 0

    /** World-from-arm transform the current state is expressed in. */
    this.frame = new THREE.Matrix4()
    this.frameQuaternion = new THREE.Quaternion()
    this.inertia = new ArmInertia()
    /** Arm-space acceleration field this step: uniform part, rotation (rad/s, rad/s^2). */
    this._g = new THREE.Vector3()
    this._w = new THREE.Vector3()
    this._alpha = new THREE.Vector3()

    /**
     * Times the loop was found not to go round the arm and was re-seated.
     * A safety net that should never fire; counted so it is visible if it does.
     */
    this.recoveries = 0
    this.walls = { nearS: WALL_NEAR_MM, farS: WALL_FAR_MM }
  }

  reset() {
    this.initialised = false
    this.inertia.reset()
  }

  /** Lay the loop out round the arm at its resting station. */
  _initialise(asset, fit) {
    const n = asset.links.count
    this.local = []
    this.prevLocal = []
    this.particles = []
    this.invMass = []
    this.linkLength = asset.innerCircumferenceMm / n
    this.bendStiffness = asset.links.bendStiffness
    const massPerLink = Math.max(1e-3, asset.massG / n)

    for (let i = 0; i < n; i++) {
      const pos = new THREE.Vector3()
      this.local.push(pos)
      this.prevLocal.push(new THREE.Vector3())
      this.particles.push(new THREE.Vector3())
      this.invMass.push(1 / massPerLink)
    }
    this._contactDepth = new Float32Array(n)
    this._seat(fit)

    this.charms = (asset.charms ?? []).map((charm) => {
      const index = charm.linkIndex % n
      const local = this.local[index].clone()
      return {
        spec: charm,
        index,
        local,
        prevLocal: local.clone(),
        position: new THREE.Vector3(),
        invMass: 1 / Math.max(1e-3, charm.massG),
      }
    })
    this._hangCharms()
    this.initialised = true
  }

  /** Put the loop round the arm, at rest, at the fitted station. */
  _seat(fit) {
    const n = this.local.length
    for (let i = 0; i < n; i++) {
      const phi = (i / n) * Math.PI * 2
      this.local[i].set(Math.cos(phi) * fit.ringA, fit.restingOffsetMm, Math.sin(phi) * fit.ringB)
      this.prevLocal[i].copy(this.local[i])
    }
  }

  /** Charms start hanging straight down (arm space) from their links. */
  _hangCharms() {
    for (const charm of this.charms) {
      charm.local.copy(this.local[charm.index]).addScaledVector(_d.copy(this._g).normalize(), charm.spec.dropMm)
      if (!Number.isFinite(charm.local.x)) charm.local.copy(this.local[charm.index])
      charm.prevLocal.copy(charm.local)
    }
  }

  /**
   * @param {number} dt seconds
   * @param {Array<{center:THREE.Vector3,axis:THREE.Vector3,radiusA:number,radiusB:number,stockRadiusMm:number}>} neighbours
   *        other bracelets in the stack (world space), for bracelet-to-bracelet collision
   * @param {{realistic?: boolean}} [options]
   */
  solve(asset, fit, twin, dt, neighbours = [], { realistic = false } = {}) {
    // --- The arm's frame, and what its motion does to the chain -------------
    twin.frameMatrix(this.frame)
    this.frame.decompose(_pos, this.frameQuaternion, _scale)
    _toArm.copy(this.frameQuaternion).invert()
    this.inertia.update(this.frame, dt, realistic ? INERTIA_REALISTIC : INERTIA_STABLE)
    // Uniform field: gravity, minus the arm's own acceleration.
    this._g.copy(DOWN).multiplyScalar(GRAVITY_MM_S2).sub(this.inertia.linearAcc).applyQuaternion(_toArm)
    this._w.copy(this.inertia.omega).applyQuaternion(_toArm)
    this._alpha.copy(this.inertia.angularAcc).applyQuaternion(_toArm)

    if (!this.initialised || this.local.length !== asset.links.count) {
      this._initialise(asset, fit)
    }
    this.walls = { nearS: WALL_NEAR_MM, farS: WALL_FAR_MM }
    const h = Math.min(dt, 1 / 40) / this.substeps
    this.maxContact = 0

    const locals = neighbours.map((nb) => toArmNeighbour(nb, _pos, _toArm))

    for (let step = 0; step < this.substeps; step++) {
      if (h > 0) this._integrate(h)
      this._contactDepth.fill(0)
      for (let it = 0; it < this.iterations; it++) {
        this._solveDistance()
        if (this.bendStiffness > 0.01) this._solveBend()
        this._solveAxialBand(asset, fit)
        for (const nb of locals) this._solveNeighbour(nb, asset)
        // Collision and the axial constraint both move particles freely, which
        // stretches links. Re-solving distance keeps the chain's length
        // credible: a visibly stretching chain reads as fake immediately.
        this._solveDistance()
        // The hard constraints go LAST, so nothing after them in the pass can
        // pull a link back into the arm or past a wall.
        this._solveWristCollision(asset, twin)
        this._solveWalls(asset)
      }
      this._solveFriction(asset, twin)
      if (h > 0) this._solveCharms(h, twin)
    }

    // Safety net: the loop must still go once round the arm. In arm space
    // nothing should ever unthread it; if something does, re-seat it rather
    // than let the bracelet fall off.
    if (Math.abs(this._winding(fit)) !== 1) {
      this.recoveries++
      this._seat(fit)
      this._hangCharms()
    }

    this._publish()
    return this
  }

  /**
   * Verlet in a moving frame. Per link:
   *   a = g_arm - alpha x r - w x (w x r) - 2 w x v
   * (uniform field, Euler, centrifugal, Coriolis), all from the filtered arm
   * motion, so still-arm jitter contributes exactly nothing.
   */
  _integrate(h) {
    const drag = 1 - this.damping
    const w = this._w
    const spin = w.lengthSq() > 0 || this._alpha.lengthSq() > 0
    for (let i = 0; i < this.local.length; i++) {
      const p = this.local[i]
      const prev = this.prevLocal[i]
      _v.subVectors(p, prev)
      this._field(p, _v, h, spin, _acc)
      prev.copy(p)
      p.addScaledVector(_v, drag).addScaledVector(_acc, h * h)
    }
  }

  /** Arm-space acceleration at r moving by `step` this substep. */
  _field(r, step, h, spin, out) {
    out.copy(this._g)
    if (!spin) return out
    // Euler: - alpha x r
    out.sub(_tmp.crossVectors(this._alpha, r))
    // Centrifugal: - w x (w x r)
    _d.crossVectors(this._w, r)
    out.sub(_tmp.crossVectors(this._w, _d))
    // Coriolis: - 2 w x v
    out.addScaledVector(_tmp.crossVectors(this._w, step), -2 / h)
    return out
  }

  /**
   * Gauss-Seidel sweeps alternate direction. Always sweeping the loop the same
   * way round leaves a small bias in that direction every pass, and on a
   * closed loop a bias accumulates into circulation: the bracelet creeps
   * round the wrist on its own.
   */
  _flipSweep() {
    this._forward = !this._forward
    return this._forward
  }

  _solveDistance() {
    const pts = this.local
    const n = pts.length
    const rest = this.linkLength
    const forward = this._flipSweep()
    for (let k = 0; k < n; k++) {
      const i = forward ? k : n - 1 - k
      const a = pts[i]
      const b = pts[(i + 1) % n]
      _d.subVectors(b, a)
      const len = _d.length()
      if (len < 1e-6) continue
      const wa = this.invMass[i]
      const wb = this.invMass[(i + 1) % n]
      const wsum = wa + wb
      if (wsum < 1e-9) continue
      const correction = (len - rest) / len / wsum
      a.addScaledVector(_d, correction * wa)
      b.addScaledVector(_d, -correction * wb)
    }
  }

  /**
   * Bend constraint: pulls each particle toward the midpoint of its neighbours.
   * A tennis bracelet with stiff links holds its arc; a rope chain barely does.
   *
   * Projected with the constraint's proper gradient weights (1, -1/2, -1/2),
   * so the three moves cancel and the correction never shifts the loop as a
   * whole. The earlier weights (1, -1/4, -1/4) nudged every triple toward its
   * middle link; summed round a closed loop that is a push along it, and a
   * stiff tennis bracelet spun ~190 deg/s round a perfectly still arm.
   */
  _solveBend() {
    const pts = this.local
    const n = pts.length
    // x1.25 keeps the per-pass reduction of the bend error what it was.
    const k = this.bendStiffness * 0.5 * 1.25
    const forward = this._flipSweep()
    for (let j = 0; j < n; j++) {
      const i = forward ? j : n - 1 - j
      const prev = pts[(i - 1 + n) % n]
      const cur = pts[i]
      const next = pts[(i + 1) % n]
      _d.addVectors(prev, next).multiplyScalar(0.5).sub(cur)
      cur.addScaledVector(_d, (k * 2) / 3)
      prev.addScaledVector(_d, -k / 3)
      next.addScaledVector(_d, -k / 3)
    }
  }

  /**
   * Soft constraint keeping the loop near its resting station. Real chains
   * do drift along the arm, but they do not wander off the wrist.
   */
  _solveAxialBand(asset, fit) {
    const rest = fit.restingOffsetMm
    const stiffness = 0.22 + 0.5 * asset.fit.stiffness
    const allowedMm = 5 + asset.links.widthMm
    for (const p of this.local) {
      const along = p.y - rest
      const excess = Math.abs(along) - allowedMm
      if (excess > 0) p.y -= Math.sign(along) * excess * stiffness
    }
  }

  /**
   * The wall planes (walls.js): in arm space, simply y = near and y = far.
   * The chain moves freely between them; no link may pass either.
   * Constraint only: nothing is drawn, nothing occludes.
   */
  _solveWalls(asset) {
    const pad = asset.stockRadiusMm
    const near = WALL_NEAR_MM + pad
    const far = WALL_FAR_MM - pad
    for (const p of this.local) {
      if (p.y < near) p.y = near
      else if (p.y > far) p.y = far
    }
  }

  /**
   * Push links out of the arm: in arm space a fixed elliptical tube round +Y.
   *
   * A link found deep inside was knocked through rather than having slid in,
   * so it goes back out along the direction it came from (its previous
   * position), which keeps the loop threaded round the arm.
   */
  _solveWristCollision(asset, twin) {
    const pad = asset.stockRadiusMm + asset.fit.clearanceMm * 0.3
    const section = _section
    for (let i = 0; i < this.local.length; i++) {
      const p = this.local[i]
      twin.sectionAt(clamp(p.y, TUBE_MIN_S, TUBE_MAX_S), section)
      const A = section.a + pad
      const B = section.b + pad
      const f = (p.x * p.x) / (A * A) + (p.z * p.z) / (B * B)
      if (f >= 1) continue
      let u = p.x
      let v = p.z
      let g = f
      if (f < TUNNEL_F) {
        const q = this.prevLocal[i]
        const fq = (q.x * q.x) / (A * A) + (q.z * q.z) / (B * B)
        if (fq > 1e-6) {
          u = q.x
          v = q.z
          g = fq
        }
      }
      if (g < 1e-9) {
        // Dead centre with no history: any outward direction will do.
        u = A
        v = 0
        g = 1
      }
      const k = 1 / Math.sqrt(g)
      const px = p.x
      const pz = p.z
      p.x = u * k
      p.z = v * k
      // How hard the skin pushed back this substep: the friction budget.
      this._contactDepth[i] += Math.hypot(p.x - px, p.z - pz)
      this.maxContact = Math.max(this.maxContact, clamp(1 - f, 0, 1))
    }
  }

  /**
   * Skin friction (position-based Coulomb friction, as in Macklin et al.,
   * "Unified Particle Physics", 2014), once per substep for the links that
   * touched the arm in it.
   *
   * The normal push the collision applied is the contact's "normal force";
   * the link's slip over the skin this substep is cancelled outright while it
   * is within MU_STATIC of that (the link sticks), and reduced by MU_KINETIC
   * of it once it breaks free. A uniform loop round an arm is in neutral
   * equilibrium at ANY rotation, so without this nothing stops the tiniest
   * numerical bias turning it round the wrist; with it a resting bracelet
   * rests, and only a real push (gravity on a steep slope, the arm's own
   * motion) makes it slide.
   */
  _solveFriction(asset, twin) {
    const pad = asset.stockRadiusMm + asset.fit.clearanceMm * 0.3
    const section = _section
    for (let i = 0; i < this.local.length; i++) {
      const depth = this._contactDepth[i]
      if (depth <= 0) continue
      const p = this.local[i]
      twin.sectionAt(clamp(p.y, TUBE_MIN_S, TUBE_MAX_S), section)
      const A = section.a + pad
      const B = section.b + pad
      // Outward surface normal of the ellipse at the link.
      _n.set(p.x / (A * A), 0, p.z / (B * B))
      if (_n.lengthSq() < 1e-12) continue
      _n.normalize()
      // Slip this substep, less its normal part.
      _d.subVectors(p, this.prevLocal[i])
      _d.addScaledVector(_n, -_d.dot(_n))
      const slip = _d.length()
      if (slip < 1e-9) continue
      if (slip <= MU_STATIC * depth) p.sub(_d)
      else p.addScaledVector(_d, -Math.min(1, (MU_KINETIC * depth) / slip))
    }
  }

  /** Keep stacked bracelets from occupying the same space (arm space). */
  _solveNeighbour(nb, asset) {
    const minDist = asset.stockRadiusMm + nb.stockRadiusMm + 0.4
    for (const p of this.local) {
      _d.subVectors(p, nb.center)
      const along = _d.dot(nb.axis)
      if (Math.abs(along) >= minDist) continue
      // Only separate along the arm; a stack sits side by side, not nested.
      const radial = _tmp.copy(_d).addScaledVector(nb.axis, -along).length()
      if (radial > Math.max(nb.radiusA, nb.radiusB) + minDist * 2) continue
      const push = (minDist - Math.abs(along)) * (along >= 0 ? 1 : -1)
      p.addScaledVector(nb.axis, push * 0.5)
    }
  }

  /** Charms hang from their link and swing with the arm (arm space). */
  _solveCharms(h, twin) {
    const drag = 0.94
    const spin = this._w.lengthSq() > 0 || this._alpha.lengthSq() > 0
    const section = _section
    for (const charm of this.charms) {
      const anchor = this.local[charm.index]
      const p = charm.local
      _v.subVectors(p, charm.prevLocal)
      this._field(p, _v, h, spin, _acc)
      charm.prevLocal.copy(p)
      p.addScaledVector(_v, drag).addScaledVector(_acc, h * h)

      // Rigid pivot distance to the anchor link.
      _d.subVectors(p, anchor)
      const len = _d.length()
      if (len > 1e-5) p.copy(anchor).addScaledVector(_d, charm.spec.dropMm / len)

      // Charms should not sink into the arm either.
      twin.sectionAt(clamp(p.y, TUBE_MIN_S, TUBE_MAX_S), section)
      const A = section.a + charm.spec.sizeMm * 0.4
      const B = section.b + charm.spec.sizeMm * 0.4
      const f = (p.x * p.x) / (A * A) + (p.z * p.z) / (B * B)
      if (f < 1) {
        const k = 1 / Math.sqrt(Math.max(1e-9, f))
        p.x *= k
        p.z *= k
      }
    }
  }

  /**
   * How many times the loop goes round the arm's axis (arm space, measured
   * on the normalised ellipse so a flattened arm counts the same). 1 or -1
   * means the bracelet is on; 0 means it has come off.
   */
  _winding(fit) {
    const pts = this.local
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

  /** World-space copies, for anything outside the renderer that wants them. */
  _publish() {
    for (let i = 0; i < this.local.length; i++) {
      this.particles[i].copy(this.local[i]).applyMatrix4(this.frame)
    }
    for (const charm of this.charms) charm.position.copy(charm.local).applyMatrix4(this.frame)
  }
}

const _section = { a: 0, b: 0 }

/** A world-space stack neighbour, re-expressed in arm space. */
function toArmNeighbour(nb, origin, toArm) {
  return {
    center: nb.center.clone().sub(origin).applyQuaternion(toArm),
    axis: nb.axis.clone().applyQuaternion(toArm),
    radiusA: nb.radiusA,
    radiusB: nb.radiusB,
    stockRadiusMm: nb.stockRadiusMm,
  }
}
