import * as THREE from 'three'
import { ELBOW_FLARE_FROM_MM, HAND_FLARE_FROM_MM } from '../physics/walls.js'
import { contactSection } from '../physics/armTube.js'

const _c = new THREE.Vector3()
const _section = { a: 0, b: 0 }
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()

/**
 * Where the flares are drawn, mm: the hand flare from where it starts down
 * onto the hand; the forearm-end flare from where it starts, toward the elbow.
 */
const HAND_STATIONS = [0, -3, -6, -9, -12, -16].map((d) => HAND_FLARE_FROM_MM + d)
const FAR_OFFSETS = [0, 10, 20, 30]
const COUNT = HAND_STATIONS.length + FAR_OFFSETS.length

/**
 * Debug view of the invisible walls (physics/walls.js): the physics arm's
 * surface where it flares - past the wrist onto the hand, and toward the
 * elbow - as rings of the exact section the contact solve uses. A bracelet
 * that slides down rests on the hand rings; nothing here is rendered for real
 * or occludes anything.
 *
 * Outlines over everything with no depth: they neither occlude nor are
 * occluded, exactly like the walls themselves.
 */
export class WallsDebug {
  constructor() {
    this.group = new THREE.Group()
    this.group.renderOrder = 120
    const circle = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2), 0)),
    )
    this._geometry = circle
    this._material = new THREE.LineBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })
    this.rings = Array.from({ length: COUNT }, () => {
      const ring = new THREE.LineLoop(circle, this._material)
      ring.renderOrder = 121
      ring.visible = false
      this.group.add(ring)
      return ring
    })
  }

  /**
   * @param {import('../wrist/WristDigitalTwin.js').WristDigitalTwin} twin
   * @param {Array<{rigid:object|null, chain:object|null}>} instances
   * @param {boolean} enabled
   */
  update(twin, instances, enabled) {
    const show = enabled && twin.valid
    // Ring local x = dorsal, y = radial, z = forearm: right-handed in the twin
    // frame (radial x forearm = dorsal); (radial, dorsal, forearm) would be a
    // reflection.
    if (show) _q.setFromRotationMatrix(_m.makeBasis(twin.dorsalAxis, twin.radialAxis, twin.forearmAxis))
    for (let i = 0; i < COUNT; i++) {
      const ring = this.rings[i]
      ring.visible = show
      if (!show) continue
      const s = i < HAND_STATIONS.length ? HAND_STATIONS[i] : ELBOW_FLARE_FROM_MM + FAR_OFFSETS[i - HAND_STATIONS.length]
      contactSection(twin, s, 1, _section)
      // pointAt holds the centre within the twin's sections; beyond them, carry on along the axis.
      const sections = twin.crossSections
      const inside = Math.min(sections[sections.length - 1]?.s ?? s, Math.max(sections[0]?.s ?? s, s))
      twin.pointAt(inside, _c).addScaledVector(twin.forearmAxis, s - inside)
      ring.position.copy(_c)
      ring.quaternion.copy(_q)
      ring.scale.set(_section.b, _section.a, 1)
    }
  }

  dispose() {
    this._geometry.dispose()
    this._material.dispose()
  }
}
