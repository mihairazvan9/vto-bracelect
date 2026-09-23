import * as THREE from 'three'
import { BraceletCategory } from '../assets/schema.js'
import { createMetalMaterial, createStoneMaterial } from './materials.js'

/**
 * Procedural jewellery geometry, built from the asset's real millimetre
 * dimensions. Swapping in a GLB later changes nothing about fit or physics
 * because both read the same numbers this does.
 *
 * Local frame convention, shared with the solvers:
 *   +Y = forearm axis (the hole through the bracelet)
 *   +X = radial (thumb side)
 *   +Z = dorsal (back of the hand)
 */

/** Elliptical path in the local XZ plane, for tube extrusion. */
class EllipsePath extends THREE.Curve {
  constructor(a, b, arc = Math.PI * 2, start = 0) {
    super()
    this.a = a
    this.b = b
    this.arc = arc
    this.start = start
  }

  getPoint(t, target = new THREE.Vector3()) {
    const phi = this.start + t * this.arc
    return target.set(Math.cos(phi) * this.a, 0, Math.sin(phi) * this.b)
  }
}

function buildRigidGeometry(asset, ringA, ringB) {
  const closed = asset.category === BraceletCategory.RIGID_BANGLE
  const gapArc = closed ? 0 : (asset.opening.gapMm / Math.max(1e-3, (ringA + ringB) * 0.5)) // radians
  const arc = Math.PI * 2 - gapArc
  const path = new EllipsePath(ringA, ringB, arc, gapArc * 0.5)
  const tubular = closed ? 128 : 96
  const geo = new THREE.TubeGeometry(path, tubular, asset.stockRadiusMm, 20, closed)

  if (closed) return geo

  // Rounded terminals on an open cuff.
  const merged = [geo]
  const cap = new THREE.SphereGeometry(asset.stockRadiusMm, 20, 12)
  for (const t of [0, 1]) {
    const p = path.getPoint(t)
    const c = cap.clone()
    c.translate(p.x, p.y, p.z)
    merged.push(c)
  }
  cap.dispose()
  return mergeGeometries(merged)
}

function mergeGeometries(list) {
  // Minimal positional merge: every geometry here is non-indexed-compatible and
  // shares the same attribute layout.
  const nonIndexed = list.map((g) => (g.index ? g.toNonIndexed() : g))
  let total = 0
  for (const g of nonIndexed) total += g.attributes.position.count
  const position = new Float32Array(total * 3)
  const normal = new Float32Array(total * 3)
  const uv = new Float32Array(total * 2)
  let vo = 0
  for (const g of nonIndexed) {
    position.set(g.attributes.position.array, vo * 3)
    normal.set(g.attributes.normal.array, vo * 3)
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2)
    vo += g.attributes.position.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(position, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  list.forEach((g) => g.dispose?.())
  return out
}

function buildLinkGeometry(asset) {
  const { widthMm, lengthMm } = asset.links
  if (asset.category === BraceletCategory.TENNIS) {
    // Square setting: a small box that carries one stone.
    return new THREE.BoxGeometry(widthMm * 0.82, widthMm * 0.62, lengthMm * 0.86)
  }
  // Oval chain link, extruded around its own minor axis.
  const link = new THREE.TorusGeometry(lengthMm * 0.42, asset.stockRadiusMm * 0.55, 10, 22)
  link.rotateY(Math.PI / 2)
  link.scale(1, widthMm / (lengthMm * 0.9), 1)
  return link
}

function buildStoneGeometry(sizeMm) {
  // Round brilliant approximation: crown cone + pavilion cone sharing a girdle.
  const r = sizeMm * 0.5
  const crown = new THREE.ConeGeometry(r, r * 0.35, 16, 1)
  crown.translate(0, r * 0.175, 0)
  const pavilion = new THREE.ConeGeometry(r, r * 0.85, 16, 1)
  pavilion.rotateX(Math.PI)
  pavilion.translate(0, -r * 0.425, 0)
  return mergeGeometries([crown, pavilion])
}

function buildCharmGeometry(charm) {
  const s = charm.sizeMm
  if (charm.shape === 'disc') {
    const g = new THREE.CylinderGeometry(s * 0.5, s * 0.5, s * 0.16, 28)
    g.rotateX(Math.PI / 2)
    return g
  }
  const shape = new THREE.Shape()
  if (charm.shape === 'heart') {
    const k = s * 0.5
    shape.moveTo(0, -k)
    shape.bezierCurveTo(k * 1.3, -k * 0.2, k * 0.9, k * 0.9, 0, k * 0.45)
    shape.bezierCurveTo(-k * 0.9, k * 0.9, -k * 1.3, -k * 0.2, 0, -k)
  } else {
    const outer = s * 0.5
    const inner = outer * 0.42
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outer : inner
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2
      const x = Math.cos(a) * r
      const y = Math.sin(a) * r
      i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)
    }
    shape.closePath()
  }
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: s * 0.14,
    bevelEnabled: true,
    bevelSize: s * 0.035,
    bevelThickness: s * 0.03,
    bevelSegments: 2,
    curveSegments: 16,
  })
  g.center()
  return g
}

/**
 * A renderable bracelet instance: geometry, materials and the per-frame update
 * that reads the solver output.
 */
export class BraceletMesh {
  constructor(asset, fit, quality = 'high') {
    this.asset = asset
    this.quality = quality
    this.group = new THREE.Group()
    this.metal = createMetalMaterial(asset.material, quality)
    this.stone = asset.stones ? createStoneMaterial(asset.stones, quality) : null
    this.articulated = asset.category !== BraceletCategory.RIGID_BANGLE && asset.category !== BraceletCategory.OPEN_CUFF
    // Chains are placed by the arm's frame matrix (applyChain); rigid pieces
    // by the position + quaternion their solver hands over.
    this.group.matrixAutoUpdate = !this.articulated

    if (this.articulated) {
      const linkGeo = buildLinkGeometry(asset)
      this.links = new THREE.InstancedMesh(linkGeo, this.metal, asset.links.count)
      this.links.frustumCulled = false
      this.links.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.group.add(this.links)

      if (asset.stones) {
        const stoneGeo = buildStoneGeometry(asset.stones.sizeMm)
        this.stones = new THREE.InstancedMesh(stoneGeo, this.stone, asset.links.count)
        this.stones.frustumCulled = false
        this.stones.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.group.add(this.stones)
      }

      this.charmMeshes = (asset.charms ?? []).map((charm) => {
        const mesh = new THREE.Mesh(buildCharmGeometry(charm), this.metal)
        mesh.frustumCulled = false
        this.group.add(mesh)
        return mesh
      })
    } else {
      this.body = new THREE.Mesh(buildRigidGeometry(asset, fit.ringA, fit.ringB), this.metal)
      this.body.frustumCulled = false
      this.group.add(this.body)
      this._ringA = fit.ringA
      this._ringB = fit.ringB
    }
  }

  /** Rigid pieces: the solver hands us a transform. */
  applyRigid(solver, fit) {
    // Rebuild only if the fit geometry genuinely changed (e.g. size swap).
    if (Math.abs(fit.ringA - this._ringA) > 0.5 || Math.abs(fit.ringB - this._ringB) > 0.5) {
      this.body.geometry.dispose()
      this.body.geometry = buildRigidGeometry(this.asset, fit.ringA, fit.ringB)
      this._ringA = fit.ringA
      this._ringB = fit.ringB
    }
    this.group.position.copy(solver.position)
    this.group.quaternion.copy(solver.quaternion)
  }

  /**
   * Articulated pieces: one instance per link, oriented along the loop.
   *
   * Drawn straight from the solver's ARM-SPACE state, under the arm's own
   * transform - the same matrix the occluder tube is placed with. The chain
   * and the arm it sits on therefore move as one rigid thing on screen: pose
   * jitter can shake them together, never apart.
   */
  applyChain(solver) {
    const particles = solver.local
    const n = particles.length
    const m = _matrix
    const up = _up
    for (let i = 0; i < n; i++) {
      const cur = particles[i]
      const next = particles[(i + 1) % n]
      const prev = particles[(i - 1 + n) % n]
      _dir.subVectors(next, prev)
      if (_dir.lengthSq() < 1e-8) _dir.set(1, 0, 0)
      _dir.normalize()
      // Point the link outward from the arm's axis (arm-space +Y) so settings
      // face away from skin. Measured from the axis itself, so it stays right
      // when the arm's centreline is offset from the wrist landmark.
      _out.set(cur.x, 0, cur.z)
      if (_out.lengthSq() < 1e-8) _out.set(0, 0, 1)
      _out.normalize()
      up.crossVectors(_dir, _out).normalize()
      _out.crossVectors(up, _dir).normalize()
      m.makeBasis(_out, up, _dir)
      m.setPosition(cur)
      this.links.setMatrixAt(i, m)

      if (this.stones) {
        _stoneM.copy(m)
        _offset.copy(_out).multiplyScalar(this.asset.links.widthMm * 0.32)
        _stoneM.setPosition(cur.x + _offset.x, cur.y + _offset.y, cur.z + _offset.z)
        this.stones.setMatrixAt(i, _stoneM)
      }
    }
    this.links.instanceMatrix.needsUpdate = true
    this.links.count = n
    if (this.stones) {
      this.stones.instanceMatrix.needsUpdate = true
      this.stones.count = n
    }

    for (let i = 0; i < this.charmMeshes.length; i++) {
      const charm = solver.charms[i]
      if (!charm) continue
      const mesh = this.charmMeshes[i]
      mesh.position.copy(charm.local)
      // Hang from the anchor: the charm's local +Y points back up the pivot.
      _dir.subVectors(particles[charm.index], charm.local)
      if (_dir.lengthSq() > 1e-8) {
        _dir.normalize()
        _q.setFromUnitVectors(_Y, _dir)
        mesh.quaternion.copy(_q)
      }
    }

    this.group.matrix.copy(solver.frame)
    this.group.matrixWorldNeedsUpdate = true
  }

  setPresence(presence) {
    this.metal.opacity = presence
    this.metal.transparent = presence < 0.999
    this.metal.depthWrite = presence > 0.85
    if (this.stone) {
      this.stone.opacity = presence
      this.stone.transparent = true
    }
    this.group.visible = presence > 0.01
  }

  setEnvironment(envMap) {
    // Assigning needsUpdate every frame would force a shader re-evaluation on
    // every frame, so only react to an actual change of environment texture.
    if (this.metal.envMap === envMap) return
    this.metal.envMap = envMap
    this.metal.needsUpdate = true
    if (this.stone) {
      this.stone.envMap = envMap
      this.stone.needsUpdate = true
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
    })
    this.metal.dispose()
    this.stone?.dispose()
  }
}

const _matrix = new THREE.Matrix4()
const _stoneM = new THREE.Matrix4()
const _dir = new THREE.Vector3()
const _out = new THREE.Vector3()
const _up = new THREE.Vector3()
const _offset = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _Y = new THREE.Vector3(0, 1, 0)
