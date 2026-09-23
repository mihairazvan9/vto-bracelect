import * as THREE from 'three'

/**
 * A wrist cross-section: an oriented ellipse sitting on the forearm centreline.
 * `a` is the radial (thumb-to-pinky) semi-axis, `b` the dorsal (back-to-palm)
 * semi-axis. Both in millimetres.
 */
export class WristCrossSection {
  constructor() {
    this.center = new THREE.Vector3()
    this.a = 26
    this.b = 18
    /** Arc-length position along the centreline from the wrist crease, in mm. */
    this.s = 0
    this.confidence = 0
  }

  copy(o) {
    this.center.copy(o.center)
    this.a = o.a
    this.b = o.b
    this.s = o.s
    this.confidence = o.confidence
    return this
  }
}

/**
 * The wrist digital twin.
 *
 * This is what the whole system is built around: not a position + quaternion,
 * but an actual metric description of the wrist and lower forearm that jewellery
 * can be fitted to, collided against and occluded by.
 *
 * Everything is in millimetres, in the renderer's world space (which is metric
 * and shares the camera's projection, so 3D and 2D always agree).
 */
export class WristDigitalTwin {
  constructor(sectionCount = 8) {
    this.center = new THREE.Vector3()

    // Orthonormal anatomical frame.
    this.forearmAxis = new THREE.Vector3(0, -1, 0) // wrist -> elbow
    this.radialAxis = new THREE.Vector3(1, 0, 0) // ulnar -> radial (pinky -> thumb)
    this.dorsalAxis = new THREE.Vector3(0, 0, 1) // palm -> back of hand
    this.quaternion = new THREE.Quaternion()

    this.crossSections = Array.from({ length: sectionCount }, () => new WristCrossSection())

    // Locked metric shape. Position and rotation change every frame; these
    // should not, which is what kills most of the AR "breathing".
    this.wristWidthMm = 52
    this.wristDepthMm = 38
    this.circumferenceMm = 160
    /** Breadth across the metacarpals: what a rigid bangle has to pass over. */
    this.handBreadthMm = 82
    this.shapeLocked = false

    /** Where the hand stops and the forearm begins, in world space. */
    this.creasePoint = new THREE.Vector3()
    /** Arc length at which a sleeve occludes the forearm (mm, Infinity = none). */
    this.sleeveLimitMm = Infinity

    this.poseConfidence = 0
    this.geometryConfidence = 0
    this.sizingConfidence = 0
    this.occlusionConfidence = 0

    this.handedness = 'Right'
    this.valid = false
  }

  /**
   * The arm's own frame: world-from-arm, as a rigid transform.
   *
   * Arm space is where the procedural tube is built ONCE: the tube's axis is
   * +Y (wrist -> elbow, y = arc length s in mm), +X is radial and +Z dorsal,
   * and every cross-section is the ellipse (a cos t, s, b sin t). The tube is
   * straight by construction (WristTracker), so its axis is the line through
   * the section centres; the origin is where that line crosses s = 0, which
   * includes the centreline offset. Each frame only this matrix changes.
   *
   * Everything that has to stay ON the arm - the occluder, the chain physics,
   * the chain's links - lives in this space, so pose jitter moves it together
   * with the arm instead of shaking it against the arm.
   */
  frameMatrix(out = new THREE.Matrix4()) {
    const first = this.crossSections[0]
    if (first) _origin.copy(first.center).addScaledVector(this.forearmAxis, -first.s)
    else _origin.copy(this.creasePoint)
    out.makeBasis(this.radialAxis, this.forearmAxis, this.dorsalAxis)
    out.setPosition(_origin)
    return out
  }

  /** World-space point at arc length `s` mm down the forearm. */
  pointAt(s, out = new THREE.Vector3()) {
    const sections = this.crossSections
    if (sections.length === 0) return out.copy(this.center)
    if (s <= sections[0].s) return out.copy(sections[0].center)
    for (let i = 1; i < sections.length; i++) {
      if (s <= sections[i].s) {
        const prev = sections[i - 1]
        const t = (s - prev.s) / Math.max(1e-4, sections[i].s - prev.s)
        return out.lerpVectors(prev.center, sections[i].center, t)
      }
    }
    return out.copy(sections[sections.length - 1].center)
  }

  /** Interpolated semi-axes (mm) at arc length `s`. */
  sectionAt(s, out = { a: 0, b: 0 }) {
    const sections = this.crossSections
    if (sections.length === 0) {
      out.a = this.wristWidthMm / 2
      out.b = this.wristDepthMm / 2
      return out
    }
    if (s <= sections[0].s) {
      out.a = sections[0].a
      out.b = sections[0].b
      return out
    }
    for (let i = 1; i < sections.length; i++) {
      if (s <= sections[i].s) {
        const prev = sections[i - 1]
        const t = (s - prev.s) / Math.max(1e-4, sections[i].s - prev.s)
        out.a = prev.a + (sections[i].a - prev.a) * t
        out.b = prev.b + (sections[i].b - prev.b) * t
        return out
      }
    }
    const last = sections[sections.length - 1]
    out.a = last.a
    out.b = last.b
    return out
  }

  /**
   * Smallest arc length at which the forearm is wide enough to stop a ring of
   * the given inner circumference from sliding further up the arm. This is what
   * makes a loose bangle settle where a real one would.
   */
  restingPositionFor(circumferenceMm, minS = 8) {
    const sections = this.crossSections
    let s = minS
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i]
      if (sec.s < minS) continue
      const c = ellipsePerimeter(sec.a, sec.b)
      if (c >= circumferenceMm) return sec.s
      s = sec.s
    }
    return s
  }
}

const _origin = new THREE.Vector3()

function ellipsePerimeter(a, b) {
  const h = ((a - b) * (a - b)) / ((a + b) * (a + b))
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
}
