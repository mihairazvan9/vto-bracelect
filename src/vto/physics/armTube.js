/**
 * The arm, as the physics sees it: a tapered elliptical tube along +y (arc
 * length s in mm from the wrist crease), its section (a radial, b dorsal) from
 * the twin, expressed in JewelleryFrame SIM coordinates - so the section is
 * turned by the frame's delta (the arm's twist the frame has not followed).
 */

/** Arm-space stations the tube is modelled over (the collision surface). */
export const TUBE_MIN_S = -10
export const TUBE_MAX_S = 120

/**
 * Deeper than this inside the arm (in ellipse units, f = r^2 / R^2) a point
 * cannot have got by sliding over the skin: it was knocked through. It goes
 * back out on the side it came from, not the side it happens to be on.
 */
const TUNNEL_F = 0.36

const _section = { a: 0, b: 0 }
const _ahead = { a: 0, b: 0 }
const _behind = { a: 0, b: 0 }
/** Half the span over which the arm's taper is read, mm. */
const TAPER_DS = 3

/**
 * Where `p` (sim coordinates) would have to be to sit on the arm's surface
 * inflated by `pad`, if it is inside.
 *
 * @param {{x:number,y:number,z:number}} p      the point (not modified)
 * @param {object} twin                          WristDigitalTwin (sectionAt)
 * @param {number} delta                         JewelleryFrame.delta
 * @param {number} pad                           mm added to both semi-axes
 * @param {{x:number,y:number,z:number}|null} from  where the point was before (tunnelling)
 * @param {{x:number,z:number,nx:number,nz:number,ny?:number,depth:number}} out
 *        surface point (x, z) in the point's cross-section and the outward
 *        normal (nx, nz) there, sim coordinates. With `taper`, also the
 *        normal's component along the arm (ny) and (nx, nz) scaled to match,
 *        so (nx, ny, nz) is the true unit normal of the tapered surface.
 * @param {boolean} [taper] include the arm's taper in the normal
 * @param {number} [squeeze] scale on the arm's section (<= 1), see fitSqueeze
 * @returns {boolean} whether the point is inside
 */
export function armContact(p, twin, delta, pad, from, out, taper = false, squeeze = 1) {
  const c = Math.cos(delta)
  const s = Math.sin(delta)
  // Into the arm's own axes: u radial, v dorsal.
  let u = p.x * c - p.z * s
  let v = p.x * s + p.z * c
  twin.sectionAt(Math.min(TUBE_MAX_S, Math.max(TUBE_MIN_S, p.y)), _section)
  const A = _section.a * squeeze + pad
  const B = _section.b * squeeze + pad
  const f = (u * u) / (A * A) + (v * v) / (B * B)
  if (f >= 1) return false
  let g = f
  if (f < TUNNEL_F && from) {
    const fu = from.x * c - from.z * s
    const fv = from.x * s + from.z * c
    const fg = (fu * fu) / (A * A) + (fv * fv) / (B * B)
    if (fg > 1e-6) {
      u = fu
      v = fv
      g = fg
    }
  }
  if (g < 1e-9) {
    // Dead centre with no history: any outward direction will do.
    u = A
    v = 0
    g = 1
  }
  const k = 1 / Math.sqrt(g)
  const su = u * k
  const sv = v * k
  // Outward normal: gradient of F = u^2/A^2 + v^2/B^2 - 1 at the surface point.
  let nu = su / (A * A)
  let nv = sv / (B * B)
  let ns = 0
  if (taper) {
    // dF/ds = -2 (u^2 A'/A^3 + v^2 B'/B^3): where the arm widens toward the
    // elbow, the surface faces a little back toward the hand. That slope is
    // what wedges a tight ring and stops a loose one sliding up the arm.
    const y = Math.min(TUBE_MAX_S, Math.max(TUBE_MIN_S, p.y))
    twin.sectionAt(y + TAPER_DS, _ahead)
    twin.sectionAt(y - TAPER_DS, _behind)
    const dA = ((_ahead.a - _behind.a) * squeeze) / (2 * TAPER_DS)
    const dB = ((_ahead.b - _behind.b) * squeeze) / (2 * TAPER_DS)
    ns = -((su * su * dA) / (A * A * A) + (sv * sv * dB) / (B * B * B))
  }
  const nl = Math.hypot(nu, nv, ns) || 1
  nu /= nl
  nv /= nl
  // Back to sim coordinates.
  out.x = su * c + sv * s
  out.z = -su * s + sv * c
  out.nx = nu * c + nv * s
  out.nz = -nu * s + nv * c
  out.ny = ns / nl
  out.depth = Math.hypot(out.x - p.x, out.z - p.z)
  return true
}

/**
 * Skin gives. Where a piece is smaller than the arm - a wrist measured larger
 * than it is, or a bracelet genuinely too small - there is no position in
 * which it clears the tube, and a rigid contact solve fights itself until it
 * throws the piece off (on the recordings: 178 rad/s). A real too-tight piece
 * squeezes the skin under it; so does this: the arm's section is scaled down
 * just enough for the piece to fit, with a little room.
 *
 * @param {object} twin
 * @param {number} s          station along the arm, mm
 * @param {number} innerA     the piece's inner semi-axes (a loop: its length
 * @param {number} innerB       as a circle, both the same), mm
 * @param {number} pad        what the contact adds to the section, mm
 * @returns {number} scale <= 1 for the section
 */
export function fitSqueeze(twin, s, innerA, innerB, pad) {
  armSection(twin, s, _section)
  const room = 0.97
  const k = Math.min((innerA * room - pad) / Math.max(1e-3, _section.a), (innerB * room - pad) / Math.max(1e-3, _section.b))
  return Math.min(1, Math.max(0.5, k))
}

/** The arm's section at station s: { a, b } semi-axes (mm), unrotated. */
export function armSection(twin, s, out = { a: 0, b: 0 }) {
  return twin.sectionAt(Math.min(TUBE_MAX_S, Math.max(TUBE_MIN_S, s)), out)
}
