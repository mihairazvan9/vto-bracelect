import * as THREE from 'three'

const UP = new THREE.Vector3(0, 1, 0)
const HALF_EXTENT_MM = 90
const NEAR = 1
const FAR = 320

/**
 * Contact shadow / ambient occlusion between jewellery and skin.
 *
 * Without it, metal floats. This renders the jewellery's depth from directly
 * above the wrist, then the skin shader darkens itself where something is
 * hovering very close to it. Restrained on purpose: the term is about proximity
 * contact, not a cast shadow.
 */
export class ContactShadow {
  constructor(size = 256) {
    this.target = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
    })
    this.camera = new THREE.OrthographicCamera(
      -HALF_EXTENT_MM, HALF_EXTENT_MM, HALF_EXTENT_MM, -HALF_EXTENT_MM, NEAR, FAR,
    )
    this.depthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    })
    this.matrix = new THREE.Matrix4()
    this.depthRangeMm = FAR - NEAR
    /** How close metal has to be before the skin darkens, in mm. */
    this.contactRangeMm = 7
    this.strength = 0.55
    this.enabled = true
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Object3D} jewelryRoot  a group containing only jewellery
   * @param {import('../wrist/WristDigitalTwin.js').WristDigitalTwin} twin
   */
  render(renderer, jewelryRoot, twin) {
    if (!this.enabled || !twin.valid) return

    // Look straight down at the wrist: contact shadows are a gravity-aligned
    // phenomenon, not a key-light one.
    const center = twin.pointAt(24, _center)
    this.camera.position.copy(center).addScaledVector(UP, FAR * 0.5)
    this.camera.up.set(0, 0, -1)
    this.camera.lookAt(center)
    this.camera.updateMatrixWorld()
    this.camera.updateProjectionMatrix()

    this.matrix.copy(this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse)

    const prevTarget = renderer.getRenderTarget()
    const prevClear = renderer.getClearColor(_prevClear)
    const prevClearAlpha = renderer.getClearAlpha()
    const prevOverride = _scene.overrideMaterial
    _scene.overrideMaterial = this.depthMaterial

    const parent = jewelryRoot.parent
    _scene.add(jewelryRoot)

    renderer.setRenderTarget(this.target)
    renderer.setClearColor(0xffffff, 1)
    renderer.clear(true, true, false)
    renderer.render(_scene, this.camera)
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(prevClear, prevClearAlpha)

    _scene.overrideMaterial = prevOverride
    _scene.remove(jewelryRoot)
    if (parent) parent.add(jewelryRoot)
  }

  get uniforms() {
    return {
      uContactMap: { value: this.target.texture },
      uContactMatrix: { value: this.matrix },
      uContactRange: { value: this.contactRangeMm },
      uContactDepthRange: { value: this.depthRangeMm },
      uContactStrength: { value: this.strength },
    }
  }

  dispose() {
    this.target.dispose()
    this.depthMaterial.dispose()
  }
}

const _center = new THREE.Vector3()
const _prevClear = new THREE.Color()
const _scene = new THREE.Scene()
