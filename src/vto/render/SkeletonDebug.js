import * as THREE from 'three'

const DOT_RADIUS_MM = 3.4

/**
 * Debug overlay for a landmark skeleton, used for both the hand and the pose.
 *
 * Drawn in 3D at the positions the translation solve produced, not as a flat
 * 2D sprite pass — so if the pose solve is wrong, the dots visibly leave the
 * limb. That makes this a check on the solver rather than a decoration.
 *
 * Landmarks that feed the position solve are highlighted; the rest are drawn
 * dimmer, because which points are load-bearing is what you want to see when
 * something drifts.
 */
export class SkeletonDebug {
  constructor({ count, connections, solveColor = 0xf2cf86, otherColor = 0x5fa8d3, lineColor = 0x8fbcd4, radius = DOT_RADIUS_MM }) {
    this.count = count
    this.connections = connections
    this.solveColor = new THREE.Color(solveColor)
    this.otherColor = new THREE.Color(otherColor)

    this.group = new THREE.Group()
    this.group.visible = false
    this.group.renderOrder = 100

    const dotGeo = new THREE.SphereGeometry(radius, 12, 8)
    this.dotMaterial = new THREE.MeshBasicMaterial({
      toneMapped: false,
      depthTest: false, // a debug overlay hidden behind the arm occluder is useless
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    })
    this.dots = new THREE.InstancedMesh(dotGeo, this.dotMaterial, count)
    this.dots.frustumCulled = false
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.dots.renderOrder = 101
    this.dots.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
    this.group.add(this.dots)

    const lineGeo = new THREE.BufferGeometry()
    this._linePositions = new Float32Array(connections.length * 2 * 3)
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this._linePositions, 3))
    this.lineMaterial = new THREE.LineBasicMaterial({
      color: lineColor,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.55,
    })
    this.lines = new THREE.LineSegments(lineGeo, this.lineMaterial)
    this.lines.frustumCulled = false
    this.lines.renderOrder = 100
    this.group.add(this.lines)
    this._lineGeometry = lineGeo
    this._solveSet = null
  }

  /** Which landmark indices drive the position solve, for colouring. */
  setSolveIndices(indices) {
    const key = indices ? indices.join(',') : ''
    if (key === this._solveSet) return
    this._solveSet = key
    const set = new Set(indices ?? [])
    for (let i = 0; i < this.count; i++) {
      this.dots.setColorAt(i, set.has(i) ? this.solveColor : this.otherColor)
    }
    this.dots.instanceColor.needsUpdate = true
  }

  /**
   * @param {THREE.Vector3[]|null} points world-space landmarks
   * @param {boolean} enabled
   * @param {number} available how many of `points` are valid
   */
  update(points, enabled, available = this.count) {
    const n = Math.min(this.count, available, points?.length ?? 0)
    if (!enabled || n === 0) {
      this.group.visible = false
      return
    }
    this.group.visible = true

    for (let i = 0; i < n; i++) {
      _m.makeTranslation(points[i].x, points[i].y, points[i].z)
      this.dots.setMatrixAt(i, _m)
    }
    this.dots.count = n
    this.dots.instanceMatrix.needsUpdate = true

    const pos = this._linePositions
    let drawn = 0
    for (let c = 0; c < this.connections.length; c++) {
      const [a, b] = this.connections[c]
      if (a >= n || b >= n) continue
      const pa = points[a]
      const pb = points[b]
      const o = drawn * 6
      pos[o] = pa.x
      pos[o + 1] = pa.y
      pos[o + 2] = pa.z
      pos[o + 3] = pb.x
      pos[o + 4] = pb.y
      pos[o + 5] = pb.z
      drawn++
    }
    this._lineGeometry.setDrawRange(0, drawn * 2)
    this._lineGeometry.attributes.position.needsUpdate = true
    this._lineGeometry.computeBoundingSphere()
  }

  dispose() {
    this.dots.geometry.dispose()
    this.dotMaterial.dispose()
    this._lineGeometry.dispose()
    this.lineMaterial.dispose()
  }
}

const _m = new THREE.Matrix4()
