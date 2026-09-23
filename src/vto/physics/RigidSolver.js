import * as THREE from 'three'
import { clamp, ellipseRadiusAt } from '../core/mathUtils.js'
import { WALL_NEAR_MM, WALL_FAR_MM } from './walls.js'

const _c = new THREE.Vector3()
const _u = new THREE.Vector3()
const _g = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()

const GRAVITY = new THREE.Vector3(0, -1, 0)
const SAMPLES = 32
/** A loose ring's tilt is kept subtle: it reads as physics, not as a wrong pose. */
const MAX_TILT_RAD = (8 * Math.PI) / 180

/**
 * STABLE mode (the default): the piece may slide along the arm between the
 * two wall planes, but slowly, with barely any sag or tilt, so the arm's
 * every small movement does not set it swinging. REALISTIC mode is the full
 * gravity behaviour. Either way the planes (walls.js) keep it on the tube.
 */
const STABLE_SAG_MM = 1.5
/** Furthest a very loose piece slides from its rest with the arm vertical, mm. */
const SLIDE_MM = 24
const STABLE_TILT_RAD = (3 * Math.PI) / 180
/** How quickly the piece settles onto a new resting station, per second. */
const STABLE_SETTLE = 1.5
const REALISTIC_SETTLE = 5

/**
 * Rigid bangle / open cuff solver.
 *
 * A rigid ring keeps its manufactured size, so the only freedoms are where it
 * rests along the forearm, how far it drops inside its own slack, and how far it
 * tilts. Getting those three right is the difference between a bangle that
 * looks worn and a torus stuck to a landmark.
 */
export class RigidSolver {
  constructor() {
    this.position = new THREE.Vector3()
    this.quaternion = new THREE.Quaternion()
    this.dropMm = 0
    this.tiltRad = 0
    this.contact = 0
    this._sag = 0
    this._tilt = 0
    this._offset = null
    /**
     * The walls this solver enforces, for the debug overlay: arm stations of
     * the two axial walls (mm), where the ring rests, where its un-sagged
     * centre is, and how far that centre may sag.
     */
    this.walls = { nearS: WALL_NEAR_MM, farS: WALL_FAR_MM }
  }

  reset() {
    this._sag = 0
    this._tilt = 0
    this._offset = null
  }

  /**
   * @param {object} asset
   * @param {object} fit         result from FitSolver
   * @param {import('../wrist/WristDigitalTwin.js').WristDigitalTwin} twin
   * @param {number} dt
   * @param {{realistic?: boolean}} [options]
   */
  solve(asset, fit, twin, dt, { realistic = false } = {}) {
    // --- Where along the forearm -------------------------------------------
    let targetOffset = fit.restingOffsetMm
    if (asset.fit.slide) {
      // Gravity pulls the ring down the arm; which way that is depends on how
      // the arm is held. A hand held palm-down with a lowered wrist sends a
      // loose bangle toward the hand.
      const along = twin.forearmAxis.dot(GRAVITY)
      // The product's offset range decides where it RESTS (FitSolver); how far
      // it slides from there is bounded only by the wall planes below.
      const slide = clamp(fit.slackMm / 40, 0, 1) * along * SLIDE_MM
      targetOffset += slide
    }
    // The wall planes: the band of metal, not just its centre, stays between.
    const halfBand = Math.max(asset.stockRadiusMm, (asset.links?.widthMm ?? 0) / 2)
    targetOffset = clamp(targetOffset, WALL_NEAR_MM + halfBand, WALL_FAR_MM - halfBand)
    if (this._offset === null) this._offset = targetOffset
    this._offset += (targetOffset - this._offset) * Math.min(1, dt * (realistic ? REALISTIC_SETTLE : STABLE_SETTLE))
    const s = this._offset

    const section = twin.sectionAt(s)
    twin.pointAt(s, _c)

    // --- How far it drops inside its slack ---------------------------------
    // Project gravity into the plane of the ring; that is the direction a loose
    // ring falls until the wrist stops it.
    _g.copy(GRAVITY).addScaledVector(twin.forearmAxis, -GRAVITY.dot(twin.forearmAxis))
    const gLen = _g.length()
    let dropTarget = 0
    let gu = 0
    let gv = 0
    if (gLen > 1e-4) {
      _g.multiplyScalar(1 / gLen)
      gu = _g.dot(twin.radialAxis)
      gv = _g.dot(twin.dorsalAxis)
      // Realistic: as far as the arm itself lets it drop. Stable: barely.
      const drop = this._maxDrop(section, fit, asset, gu, gv)
      dropTarget = realistic ? drop : Math.min(STABLE_SAG_MM, drop)
    }
    this._sag += (dropTarget - this._sag) * Math.min(1, dt * 9)
    this.dropMm = this._sag

    // --- Tilt ---------------------------------------------------------------
    // Slack lets the ring tip out of the plane perpendicular to the forearm.
    const bandHalfWidth = Math.max(asset.stockRadiusMm, asset.links?.widthMm ?? 0) * 0.5 + 0.5
    const maxTilt = Math.min(
      realistic ? MAX_TILT_RAD : STABLE_TILT_RAD,
      Math.atan2(Math.max(0, fit.gapMm), Math.max(1e-3, bandHalfWidth + section.a * 0.5)),
    )
    // Gravity tips a loose ring about the axis across both it and the arm, so
    // the tilt needs BOTH: a slope along the arm and a component across it.
    // The old law tilted hardest with the arm vertical - exactly where that
    // axis (forearm x gravity) has no defined direction, so the ring tipped to
    // an arbitrary side. A ring round a vertical arm hangs level.
    const along = twin.forearmAxis.dot(GRAVITY)
    _axis.crossVectors(twin.forearmAxis, GRAVITY)
    const across = _axis.length()
    const tiltTarget = clamp(along * across * 2, -1, 1) * maxTilt * (asset.fit.gravity ? 1 : 0)
    this._tilt += (tiltTarget - this._tilt) * Math.min(1, dt * 7)
    this.tiltRad = this._tilt

    // --- Compose ------------------------------------------------------------
    this.position
      .copy(_c)
      .addScaledVector(twin.radialAxis, gu * this._sag)
      .addScaledVector(twin.dorsalAxis, gv * this._sag)

    _m.makeBasis(twin.radialAxis, twin.forearmAxis, twin.dorsalAxis)
    this.quaternion.setFromRotationMatrix(_m)

    if (Math.abs(this._tilt) > 1e-5) {
      // Tilt about the axis perpendicular to both gravity and the forearm.
      _axis.crossVectors(twin.forearmAxis, GRAVITY)
      if (_axis.lengthSq() > 1e-4) {
        _axis.normalize()
        // Convert the world-space tilt axis into the ring's local frame.
        _u.copy(_axis).applyQuaternion(_q.copy(this.quaternion).invert())
        _q.setFromAxisAngle(_u, this._tilt)
        this.quaternion.multiply(_q)
      }
    }

    // Open cuffs have a defined opening bearing around the forearm axis.
    if (asset.opening && asset.category === 'open_cuff') {
      _q.setFromAxisAngle(_YAXIS, THREE.MathUtils.degToRad(asset.opening.bearingDeg))
      this.quaternion.multiply(_q)
    }

    this.contact = clamp(1 - fit.gapMm / 4, 0, 1)
    return this
  }

  /**
   * Largest displacement along (gu, gv) that still keeps the wrist ellipse
   * inside the ring ellipse. Sampled rather than solved in closed form: 32
   * samples is exact enough at these scales and completely robust.
   */
  _maxDrop(section, fit, asset, gu, gv) {
    // fit.ringA/B are already the inner semi-axes of the piece as manufactured.
    const innerA = fit.ringA
    const innerB = fit.ringB
    const skinA = section.a + asset.fit.clearanceMm
    const skinB = section.b + asset.fit.clearanceMm
    if (skinA >= innerA && skinB >= innerB) return 0

    let best = Infinity
    for (let i = 0; i < SAMPLES; i++) {
      const phi = (i / SAMPLES) * Math.PI * 2
      const r = ellipseRadiusAt(skinA, skinB, phi)
      const px = Math.cos(phi) * r
      const py = Math.sin(phi) * r
      // Largest t with ((px + t*gu)/innerA)^2 + ((py + t*gv)/innerB)^2 <= 1
      const A = (gu * gu) / (innerA * innerA) + (gv * gv) / (innerB * innerB)
      const B = 2 * ((px * gu) / (innerA * innerA) + (py * gv) / (innerB * innerB))
      const C = (px * px) / (innerA * innerA) + (py * py) / (innerB * innerB) - 1
      if (A < 1e-9) continue
      const disc = B * B - 4 * A * C
      if (disc <= 0) return 0
      const t = (-B + Math.sqrt(disc)) / (2 * A)
      if (t < best) best = t
    }
    return Number.isFinite(best) ? Math.max(0, best) : 0
  }
}

const _YAXIS = new THREE.Vector3(0, 1, 0)
