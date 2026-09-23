import * as THREE from 'three'

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
export const lerp = (a, b, t) => a + (b - a) * t
export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Build a right-handed orthonormal basis from two roughly-orthogonal vectors.
 * `primary` is preserved exactly; `hint` is orthogonalised against it.
 * Returns { x: radial, y: forearm(primary), z: dorsal }.
 */
export function orthonormalBasis(primary, hint, out = {}) {
  const y = out.y || (out.y = new THREE.Vector3())
  const x = out.x || (out.x = new THREE.Vector3())
  const z = out.z || (out.z = new THREE.Vector3())

  y.copy(primary).normalize()
  x.copy(hint).addScaledVector(y, -hint.dot(y))
  if (x.lengthSq() < 1e-10) {
    // Degenerate hint — pick any perpendicular.
    x.set(1, 0, 0).addScaledVector(y, -y.x)
    if (x.lengthSq() < 1e-10) x.set(0, 0, 1).addScaledVector(y, -y.z)
  }
  x.normalize()
  z.crossVectors(x, y).normalize()
  return out
}

const _m = new THREE.Matrix4()

/** Quaternion whose local +Y maps to basis.y, +X to basis.x, +Z to basis.z. */
export function quaternionFromBasis(basis, out = new THREE.Quaternion()) {
  _m.makeBasis(basis.x, basis.y, basis.z)
  return out.setFromRotationMatrix(_m)
}

/**
 * Shortest-arc-safe slerp. Ensures we never take the long way round, which is
 * what produces the classic 180 degree bracelet flip.
 */
export function slerpSafe(from, to, t, out = new THREE.Quaternion()) {
  // The target is staged in a scratch quaternion first. Writing `from` into
  // `out` before reading the target is how this silently degenerated into
  // "slerp a rotation toward itself", which freezes orientation completely.
  _slerpTarget.copy(to)
  if (from.dot(_slerpTarget) < 0) {
    _slerpTarget.set(-_slerpTarget.x, -_slerpTarget.y, -_slerpTarget.z, -_slerpTarget.w)
  }
  return out.copy(from).slerp(_slerpTarget, t)
}

const _slerpTarget = new THREE.Quaternion()
const _avNext = new THREE.Quaternion()
const _avPrev = new THREE.Quaternion()
const _axis = new THREE.Vector3()

/** Angular velocity (rad/s, as an axis-scaled vector) between two orientations. */
export function angularVelocity(qPrev, qNext, dt, out = new THREE.Vector3()) {
  if (dt <= 0) return out.set(0, 0, 0)
  const q = _avNext.copy(qNext)
  if (qPrev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w)
  const delta = q.multiply(_avPrev.copy(qPrev).invert())
  const angle = 2 * Math.acos(clamp(delta.w, -1, 1))
  const s = Math.sqrt(Math.max(1e-12, 1 - delta.w * delta.w))
  if (angle < 1e-6) return out.set(0, 0, 0)
  return out.set(delta.x / s, delta.y / s, delta.z / s).multiplyScalar(angle / dt)
}

/** Integrate an angular velocity vector over dt onto an orientation. */
export function integrateAngularVelocity(q, omega, dt, out = new THREE.Quaternion()) {
  const angle = omega.length() * dt
  if (angle < 1e-7) return out.copy(q)
  const axis = _axis.copy(omega).normalize()
  return out.setFromAxisAngle(axis, angle).multiply(q)
}

/**
 * Least-squares fit of an ellipse cross-section from silhouette half-widths
 * observed at different viewing angles.
 *
 * The silhouette half-width of an ellipse with semi-axes (a, b) viewed at an
 * angle theta from the b-axis is  r(theta) = sqrt(a^2 cos^2 + b^2 sin^2).
 * Squaring linearises it:  r^2 = A cos^2 + B sin^2  with A = a^2, B = b^2.
 *
 * @param {Array<{theta:number, radius:number, weight?:number}>} samples
 * @returns {{a:number, b:number, residual:number, conditioning:number}|null}
 */
export function fitEllipseFromSilhouettes(samples) {
  if (samples.length < 4) return null

  let suu = 0, svv = 0, suv = 0, suy = 0, svy = 0, wsum = 0
  for (const s of samples) {
    const w = s.weight ?? 1
    const u = Math.cos(s.theta) ** 2
    const v = Math.sin(s.theta) ** 2
    const y = s.radius * s.radius
    suu += w * u * u
    svv += w * v * v
    suv += w * u * v
    suy += w * u * y
    svy += w * v * y
    wsum += w
  }
  if (wsum <= 0) return null

  const det = suu * svv - suv * suv
  // A poorly conditioned system means every sample came from the same angle:
  // we cannot separate width from depth and must not pretend otherwise.
  const scale = suu * svv
  const conditioning = scale > 0 ? clamp(det / scale, 0, 1) : 0
  if (conditioning < 1e-3) return null

  const A = (suy * svv - svy * suv) / det
  const B = (svy * suu - suy * suv) / det
  if (!(A > 0) || !(B > 0)) return null

  const a = Math.sqrt(A)
  const b = Math.sqrt(B)

  let residual = 0
  for (const s of samples) {
    const pred = Math.sqrt(A * Math.cos(s.theta) ** 2 + B * Math.sin(s.theta) ** 2)
    residual += ((pred - s.radius) / Math.max(1e-6, s.radius)) ** 2
  }
  residual = Math.sqrt(residual / samples.length)

  return { a, b, residual, conditioning }
}

/** Ramanujan's approximation — accurate to ~1e-5 for jewellery aspect ratios. */
export function ellipseCircumference(a, b) {
  const h = ((a - b) * (a - b)) / ((a + b) * (a + b))
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
}

/**
 * Semi-axes of an ellipse with the given circumference that preserves the
 * aspect ratio a:b. Used to convert a bracelet's stated inner circumference
 * into the oval it actually forms.
 */
export function ellipseFromCircumference(circumference, aspect) {
  // Solve scale s such that circumference(s*aspect, s) == circumference.
  const unit = ellipseCircumference(aspect, 1)
  const s = circumference / unit
  return { a: aspect * s, b: s }
}

/** Distance from centre to the ellipse boundary along a given local angle. */
export function ellipseRadiusAt(a, b, angle) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return (a * b) / Math.sqrt(b * b * c * c + a * a * s * s)
}

/** Running mean + variance (Welford), used for confidence + jitter metrics. */
export class RunningStat {
  constructor(window = 90) {
    this.window = window
    this.values = []
    this.sum = 0
  }

  push(v) {
    this.values.push(v)
    this.sum += v
    if (this.values.length > this.window) this.sum -= this.values.shift()
    return this
  }

  get mean() {
    return this.values.length ? this.sum / this.values.length : 0
  }

  get std() {
    const n = this.values.length
    if (n < 2) return 0
    const m = this.mean
    let acc = 0
    for (const v of this.values) acc += (v - m) ** 2
    return Math.sqrt(acc / (n - 1))
  }

  clear() {
    this.values.length = 0
    this.sum = 0
  }
}
