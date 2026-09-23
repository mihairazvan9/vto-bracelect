import * as THREE from 'three'

const RADIAL_COLOR = 0xff6b6b // X
const FOREARM_COLOR = 0x7fd77f // Y
const DORSAL_COLOR = 0x6ba8ff // Z
const THUMB_COLOR = 0xe06bd8
const PALM_COLOR = 0x9ad4ff
const VIEW_COLOR = 0xffffff

const SOLVED_LEN = 52
const RAW_LEN = 38
const RING_RADIUS = 34

const VIEW_DIR = new THREE.Vector3(0, 0, 1) // wrist -> camera

/**
 * Visual debugger for the wrist rotation solve.
 *
 * Rotation is the part of the pipeline that is hardest to trust by eye, because
 * a wrong axis looks like "the bracelet is a bit off" rather than like an
 * obvious bug. This draws every piece of evidence the solver actually uses:
 *
 *   thick axes   the filtered, predicted frame that drives the jewellery
 *   thin axes    the raw per-frame observation, before smoothing
 *   palm plane   the triangle wrist-index-pinky that defines the frame
 *   thumb vector the anatomical evidence that fixes the dorsal sign
 *   roll ring    the dorsal axis against the camera axis - the angle that the
 *                multi-view wrist-depth fit depends on
 *
 * The gap between the thick and thin axes is the smoothing and prediction doing
 * their job, so it is meant to be visible, not zero.
 */
export class WristFrameDebug {
  constructor() {
    this.group = new THREE.Group()
    this.group.visible = false
    this.group.renderOrder = 90

    this.solved = this._makeAxes(SOLVED_LEN, 1, 3)
    this.raw = this._makeAxes(RAW_LEN, 0.38, 1)

    // Palm plane: wrist -> index MCP -> pinky MCP.
    this.palmGeometry = new THREE.BufferGeometry()
    this.palmGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3))
    this.palmMesh = new THREE.Mesh(
      this.palmGeometry,
      new THREE.MeshBasicMaterial({
        color: PALM_COLOR,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    this.palmMesh.frustumCulled = false
    this.group.add(this.palmMesh)

    // The thumb vector that decides which way the back of the hand faces.
    this.thumbGeometry = new THREE.BufferGeometry()
    this.thumbGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
    this.thumbLine = new THREE.Line(
      this.thumbGeometry,
      new THREE.LineBasicMaterial({
        color: THUMB_COLOR,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    this.thumbLine.frustumCulled = false
    this.group.add(this.thumbLine)

    // Roll ring: lies in the plane the bracelet occupies.
    this.ringGeometry = new THREE.BufferGeometry()
    this._ringPositions = new Float32Array(65 * 3)
    this.ringGeometry.setAttribute('position', new THREE.BufferAttribute(this._ringPositions, 3))
    this.ring = new THREE.Line(
      this.ringGeometry,
      new THREE.LineBasicMaterial({
        color: DORSAL_COLOR,
        transparent: true,
        opacity: 0.4,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    this.ring.frustumCulled = false
    this.group.add(this.ring)

    // Arc from the dorsal axis to the camera axis: this angle IS the roll the
    // wrist-depth fit samples against.
    this.arcGeometry = new THREE.BufferGeometry()
    this._arcPositions = new Float32Array(25 * 3)
    this.arcGeometry.setAttribute('position', new THREE.BufferAttribute(this._arcPositions, 3))
    this.arc = new THREE.Line(
      this.arcGeometry,
      new THREE.LineBasicMaterial({
        color: VIEW_COLOR,
        transparent: true,
        opacity: 0.75,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    this.arc.frustumCulled = false
    this.group.add(this.arc)
  }

  _makeAxes(length, opacity, headScale) {
    const make = (color) => {
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(),
        length,
        color,
        length * 0.26,
        length * 0.1 * headScale,
      )
      for (const part of [arrow.line, arrow.cone]) {
        part.material.depthTest = false
        part.material.depthWrite = false
        part.material.transparent = true
        part.material.opacity = opacity
        part.material.toneMapped = false
      }
      arrow.frustumCulled = false
      this.group.add(arrow)
      return arrow
    }
    return {
      x: make(RADIAL_COLOR),
      y: make(FOREARM_COLOR),
      z: make(DORSAL_COLOR),
      length,
    }
  }

  _placeAxes(axes, origin, basis) {
    axes.x.position.copy(origin)
    axes.x.setDirection(basis.x)
    axes.y.position.copy(origin)
    axes.y.setDirection(basis.y)
    axes.z.position.copy(origin)
    axes.z.setDirection(basis.z)
  }

  /**
   * @param {import('../wrist/WristDigitalTwin.js').WristDigitalTwin} twin
   * @param {object|null} raw snapshot of the last raw observation
   */
  update(twin, raw, enabled) {
    if (!enabled || !twin.valid) {
      this.group.visible = false
      return
    }
    this.group.visible = true

    // The frame that actually drives the jewellery.
    this._placeAxes(this.solved, twin.creasePoint, {
      x: twin.radialAxis,
      y: twin.forearmAxis,
      z: twin.dorsalAxis,
    })

    // The raw observation, unfiltered and unpredicted.
    const hasRaw = raw && raw.valid
    this.raw.x.visible = hasRaw
    this.raw.y.visible = hasRaw
    this.raw.z.visible = hasRaw
    this.palmMesh.visible = hasRaw
    this.thumbLine.visible = hasRaw
    if (hasRaw) {
      this._placeAxes(this.raw, raw.origin, raw)

      const palm = this.palmGeometry.attributes.position.array
      writeVec(palm, 0, raw.palmWrist)
      writeVec(palm, 3, raw.palmIndex)
      writeVec(palm, 6, raw.palmPinky)
      this.palmGeometry.attributes.position.needsUpdate = true
      this.palmGeometry.computeBoundingSphere()

      const thumb = this.thumbGeometry.attributes.position.array
      writeVec(thumb, 0, raw.palmWrist)
      writeVec(thumb, 3, raw.thumb)
      this.thumbGeometry.attributes.position.needsUpdate = true
      this.thumbGeometry.computeBoundingSphere()
    }

    // --- Roll ring, in the plane the bracelet sits in ----------------------
    const centre = twin.pointAt(22, _centre)
    const ringPos = this._ringPositions
    for (let i = 0; i <= 64; i++) {
      const phi = (i / 64) * Math.PI * 2
      _p.copy(centre)
        .addScaledVector(twin.radialAxis, Math.cos(phi) * RING_RADIUS)
        .addScaledVector(twin.dorsalAxis, Math.sin(phi) * RING_RADIUS)
      writeVec(ringPos, i * 3, _p)
    }
    this.ringGeometry.attributes.position.needsUpdate = true
    this.ringGeometry.computeBoundingSphere()

    // --- Roll arc: dorsal axis swept to the camera axis --------------------
    // acos(|dorsal . viewDir|) is exactly the roll the geometry solver bins on,
    // so seeing this arc open and close is seeing the wrist-depth measurement
    // gather the information it needs.
    const arcPos = this._arcPositions
    const flip = twin.dorsalAxis.dot(VIEW_DIR) < 0 ? -1 : 1
    _from.copy(twin.dorsalAxis).multiplyScalar(flip)
    for (let i = 0; i < 25; i++) {
      const t = i / 24
      _p.copy(_from).lerp(VIEW_DIR, t)
      if (_p.lengthSq() < 1e-8) _p.copy(VIEW_DIR)
      _p.normalize().multiplyScalar(RING_RADIUS * 0.72).add(centre)
      writeVec(arcPos, i * 3, _p)
    }
    this.arcGeometry.attributes.position.needsUpdate = true
    this.arcGeometry.computeBoundingSphere()
  }

  dispose() {
    for (const set of [this.solved, this.raw]) {
      for (const key of ['x', 'y', 'z']) {
        set[key].line.geometry.dispose()
        set[key].line.material.dispose()
        set[key].cone.geometry.dispose()
        set[key].cone.material.dispose()
      }
    }
    for (const mesh of [this.palmMesh, this.thumbLine, this.ring, this.arc]) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
  }
}

function writeVec(array, offset, v) {
  array[offset] = v.x
  array[offset + 1] = v.y
  array[offset + 2] = v.z
}

const _p = new THREE.Vector3()
const _centre = new THREE.Vector3()
const _from = new THREE.Vector3()
