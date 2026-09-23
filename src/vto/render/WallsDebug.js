import * as THREE from 'three'
import { WALL_NEAR_MM, WALL_FAR_MM } from '../physics/walls.js'

const _c = new THREE.Vector3()
const _section = { a: 0, b: 0 }
const _m = new THREE.Matrix4()
const PLANE_SCALE = 2.2 // plane radius relative to the arm's larger semi-axis

/**
 * Debug view of the invisible walls: two planes across the arm at the ends of
 * the tube (physics/walls.js). The bracelet moves freely between them and can
 * never pass either one. Drawn from the positions the solvers report they
 * enforced, so what you see is what the physics used.
 *
 * Translucent discs with an outline, drawn over everything with no depth:
 * they neither occlude nor are occluded, exactly like the walls themselves.
 */
export class WallsDebug {
  constructor() {
    this.group = new THREE.Group()
    this.group.renderOrder = 120
    this.planes = [0, 1].map(() => {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(1, 48),
        new THREE.MeshBasicMaterial({
          color: 0xff4d4d,
          transparent: true,
          opacity: 0.22,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
        }),
      )
      const rim = new THREE.LineLoop(
        new THREE.EdgesGeometry(new THREE.CircleGeometry(1, 48)),
        new THREE.LineBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
      )
      const plane = new THREE.Group()
      plane.add(disc, rim)
      plane.renderOrder = 120
      disc.renderOrder = 120
      rim.renderOrder = 121
      plane.visible = false
      this.group.add(plane)
      return plane
    })
  }

  /**
   * @param {import('../wrist/WristDigitalTwin.js').WristDigitalTwin} twin
   * @param {Array<{rigid:object|null, chain:object|null}>} instances
   * @param {boolean} enabled
   */
  update(twin, instances, enabled) {
    // All pieces share the same two planes; take them from whichever solver
    // reported (falling back to the shared constants).
    const walls = instances.map((i) => i.rigid?.walls ?? i.chain?.walls).find(Boolean)
    const show = enabled && twin.valid
    const stations = [walls?.nearS ?? WALL_NEAR_MM, walls?.farS ?? WALL_FAR_MM]
    for (let i = 0; i < 2; i++) {
      const plane = this.planes[i]
      plane.visible = show
      if (!show) continue
      const s = stations[i]
      twin.sectionAt(s, _section)
      twin.pointAt(s, _c)
      const r = Math.max(_section.a, _section.b) * PLANE_SCALE
      // Disc local +Z = the forearm axis: the plane lies across the arm. The
      // basis must be right-handed: the twin frame is radial x forearm =
      // dorsal, so (dorsal, radial, forearm) is; (radial, dorsal, forearm)
      // is a reflection and stood the discs up ALONG the arm.
      _m.makeBasis(twin.dorsalAxis, twin.radialAxis, twin.forearmAxis)
      plane.quaternion.setFromRotationMatrix(_m)
      plane.position.copy(_c)
      plane.scale.set(r, r, r)
    }
  }

  dispose() {
    for (const plane of this.planes) {
      for (const child of plane.children) {
        child.geometry.dispose()
        child.material.dispose()
      }
    }
  }
}
