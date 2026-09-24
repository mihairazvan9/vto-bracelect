import * as THREE from 'three'
import { TUBE_START_MM } from '../physics/walls.js'

const RADIAL = 28
/** The tube's hand end: only a short lip past the start wall (see walls.js). */
const EXTRA_S = TUBE_START_MM

const MASK_TRIM_GLSL = /* glsl */ `
  uniform sampler2D uMask;
  uniform vec2 uResolution;
  uniform vec2 uMaskTexel;
  uniform float uMaskEnabled;
  uniform float uMirror;
  // Where the mask sits in the raw frame: x, y, w, h (normalised, y down).
  uniform vec4 uMaskRoi;
  // The fitted arm (display px, y down): origin, direction, outlines, reach.
  uniform float uHasArm;
  uniform vec2 uArmOrigin;
  uniform vec2 uArmDir;
  uniform vec2 uArmLeft;
  uniform vec2 uArmRight;
  uniform float uArmReach;
  uniform float uArmBack;

  // Inside the fitted arm outline. The outline is a model fitted to many rows
  // of the mask, so it bridges the holes hair and shading punch in the mask
  // itself; there the arm is the arm, whatever a single pixel says.
  float insideArmModel() {
    if (uHasArm < 0.5) return 0.0;
    vec2 px = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) - uArmOrigin;
    float s = dot(px, uArmDir);
    if (s < -uArmBack || s > uArmReach) return 0.0;
    float v = dot(px, vec2(-uArmDir.y, uArmDir.x));
    return step(uArmLeft.x + uArmLeft.y * s + 1.0, v) * step(v, uArmRight.x + uArmRight.y * s - 1.0);
  }

  // MASK ORIENTATION, the one place it is easy to get wrong:
  //   the mask is row-major with row 0 = the TOP of the image, and DataTexture
  //   sets flipY = false, so texture t = 0 addresses that top row.
  //   gl_FragCoord.y, by contrast, is 0 at the BOTTOM of the frame.
  // Hence the y flip. The CPU sampler in PerceptionSystem needs no flip because
  // it is fed a y-down display pixel; the two conventions must stay in step.
  vec2 maskUv() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    if (uMirror > 0.5) uv.x = 1.0 - uv.x;
    uv.y = 1.0 - uv.y;
    return uv;
  }

  // The mask only covers the region of interest around the wrist. Outside it
  // nothing is known, so the twin geometry alone decides.
  float armCoverage() {
    if (uMaskEnabled < 0.5) return 1.0;
    // No fitted outline this frame: the tube is the best model of the arm
    // there is. Cutting it back to wherever the mask happens to reach made
    // the occluder flicker in length - down to nothing on some frames.
    if (uHasArm < 0.5) return 1.0;
    if (insideArmModel() > 0.5) return 1.0;
    vec2 uv = (maskUv() - uMaskRoi.xy) / uMaskRoi.zw;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
    // Taps are spaced in MASK texels, not screen pixels. The mask is several
    // times lower resolution than the frame, so screen-pixel offsets would all
    // land inside one texel and soften precisely nothing.
    vec2 o = uMaskTexel * 0.75;
    float m = texture2D(uMask, uv).r;
    m += texture2D(uMask, uv + vec2(o.x, 0.0)).r;
    m += texture2D(uMask, uv - vec2(o.x, 0.0)).r;
    m += texture2D(uMask, uv + vec2(0.0, o.y)).r;
    m += texture2D(uMask, uv - vec2(0.0, o.y)).r;
    return m / 5.0;
  }
`

/**
 * The occluder: an actual lofted mesh of the wrist twin, not an invisible
 * cylinder.
 *
 * It writes depth only, so a chain passing behind the arm is hidden by real
 * geometry, and it is trimmed to the segmentation silhouette so the edge is
 * pixel-accurate rather than approximately right.
 */
export class WristOccluder {
  constructor() {
    this.sectionCount = 9 // one extra ring toward the hand
    this.geometry = this._buildGeometry()

    this.maskTexture = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat)
    this.maskTexture.needsUpdate = true
    this._maskVersion = -1

    const shared = {
      uMask: { value: this.maskTexture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uMaskTexel: { value: new THREE.Vector2(1 / 256, 1 / 256) },
      uMaskEnabled: { value: 0 },
      uMaskRoi: { value: new THREE.Vector4(0, 0, 1, 1) },
      uHasArm: { value: 0 },
      uArmOrigin: { value: new THREE.Vector2() },
      uArmDir: { value: new THREE.Vector2(0, 1) },
      uArmLeft: { value: new THREE.Vector2() },
      uArmRight: { value: new THREE.Vector2() },
      uArmReach: { value: 0 },
      uArmBack: { value: 0 },
      uMirror: { value: 0 },
      uPresence: { value: 1 },
    }
    this.uniforms = shared

    this.depthMaterial = new THREE.ShaderMaterial({
      uniforms: shared,
      vertexShader: /* glsl */ `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${MASK_TRIM_GLSL}
        void main() {
          if (armCoverage() < 0.4) discard;
          // Normally colour is off entirely and this pass writes depth only.
          // With colour on for debugging it draws a flat tint: an opaque black
          // fill would hide the arm rather than reveal the twin.
          gl_FragColor = vec4(0.15, 0.75, 0.95, 1.0);
        }
      `,
      colorWrite: false,
      // Deliberately NOT transparent. three.js renders every transparent object
      // after every opaque one, and this pass has to write depth before the
      // jewellery is drawn or nothing gets occluded at all.
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    })

    this.depthMesh = new THREE.Mesh(this.geometry, this.depthMaterial)
    this.depthMesh.frustumCulled = false
    this.depthMesh.renderOrder = -10

    // The tube is built in arm space and placed by the arm's frame matrix,
    // the same matrix the chain physics runs in.
    this.depthMesh.matrixAutoUpdate = false

    this._positions = this.geometry.attributes.position.array
    /** Cross-section shape the vertices were last built for (s, a, b per section). */
    this._shape = new Float32Array(this.sectionCount * 3).fill(NaN)
    /** How many times the vertices have been (re)built; pose changes never add one. */
    this.rebuilds = 0
    this.frame = new THREE.Matrix4()
  }

  _buildGeometry() {
    const rings = this.sectionCount
    const verts = rings * RADIAL
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3), 3))

    const indices = []
    for (let r = 0; r < rings - 1; r++) {
      for (let i = 0; i < RADIAL; i++) {
        const j = (i + 1) % RADIAL
        const a = r * RADIAL + i
        const b = r * RADIAL + j
        const c = (r + 1) * RADIAL + i
        const d = (r + 1) * RADIAL + j
        indices.push(a, c, b, b, c, d)
      }
    }
    geo.setIndex(indices)
    geo.setDrawRange(0, indices.length)
    return geo
  }

  /**
   * Place the tube on the arm.
   *
   * The loft is built ONCE, in arm space (WristDigitalTwin.frameMatrix): a
   * straight elliptical tube round +Y. Per frame only its matrix changes, so
   * the pose can move the tube but never deform it. The vertices are rebuilt
   * only when the wrist's measured shape itself changes - while it is still
   * being measured, and never again once it is frozen.
   */
  update(twin) {
    if (!twin.valid) {
      this.depthMesh.visible = false
      return
    }
    this.depthMesh.visible = true

    if (this._shapeChanged(twin)) this._build()

    twin.frameMatrix(this.frame)
    this.depthMesh.matrix.copy(this.frame)
    this.depthMesh.matrixWorldNeedsUpdate = true
  }

  /** Has the measured cross-section moved by more than a hundredth of a mm? */
  _shapeChanged(twin) {
    const shape = this._shape
    let changed = false
    for (let r = 0; r < this.sectionCount; r++) {
      const s = r === 0 ? EXTRA_S : twin.crossSections[r - 1].s
      twin.sectionAt(Math.max(0, s), _section)
      const k = r * 3
      if (
        !(Math.abs(shape[k] - s) < 0.01) ||
        !(Math.abs(shape[k + 1] - _section.a) < 0.01) ||
        !(Math.abs(shape[k + 2] - _section.b) < 0.01)
      ) {
        shape[k] = s
        shape[k + 1] = _section.a
        shape[k + 2] = _section.b
        changed = true
      }
    }
    return changed
  }

  /** Loft the arm-space tube from the recorded shape. */
  _build() {
    const pos = this._positions
    const shape = this._shape
    let v = 0
    for (let r = 0; r < this.sectionCount; r++) {
      const s = shape[r * 3]
      let a = shape[r * 3 + 1]
      let b = shape[r * 3 + 2]
      if (s < 0) {
        // Toward the hand the arm narrows slightly into the wrist crease.
        a *= 0.98
        b *= 0.98
      }
      for (let i = 0; i < RADIAL; i++) {
        const phi = (i / RADIAL) * Math.PI * 2
        pos[v * 3] = Math.cos(phi) * a
        pos[v * 3 + 1] = s
        pos[v * 3 + 2] = Math.sin(phi) * b
        v++
      }
    }
    this.geometry.attributes.position.needsUpdate = true
    this.geometry.computeVertexNormals()
    this.geometry.computeBoundingSphere()
    this.rebuilds++
  }

  /** Upload the latest segmentation mask for silhouette trimming. */
  setMask(armMask, mirrored, viewportWidth, viewportHeight) {
    this.uniforms.uResolution.value.set(viewportWidth, viewportHeight)
    if (armMask) this.uniforms.uMaskTexel.value.set(1 / armMask.width, 1 / armMask.height)
    this.uniforms.uMirror.value = mirrored ? 1 : 0
    if (!armMask) {
      this.uniforms.uMaskEnabled.value = 0
      return
    }
    if (this._maskVersion !== armMask.version) {
      if (
        this.maskTexture.image.width !== armMask.width ||
        this.maskTexture.image.height !== armMask.height
      ) {
        this.maskTexture.dispose()
        this.maskTexture = new THREE.DataTexture(
          armMask.data, armMask.width, armMask.height, THREE.RedFormat,
        )
        this.maskTexture.unpackAlignment = 1
        this.maskTexture.minFilter = THREE.LinearFilter
        this.maskTexture.magFilter = THREE.LinearFilter
        this.uniforms.uMask.value = this.maskTexture
      } else {
        this.maskTexture.image.data = armMask.data
      }
      this.maskTexture.needsUpdate = true
      this._maskVersion = armMask.version
    }
    const r = armMask.roi
    if (r) this.uniforms.uMaskRoi.value.set(r.x, r.y, r.w, r.h)
    else this.uniforms.uMaskRoi.value.set(0, 0, 1, 1)
    this.uniforms.uMaskEnabled.value = 1
  }

  /**
   * The fitted arm outline (WristObserver armOverlay, display px). Inside it
   * the occluder is kept even where the mask has holes. null disables.
   */
  setArm(overlay) {
    const u = this.uniforms
    u.uHasArm.value = overlay ? 1 : 0
    if (!overlay) return
    u.uArmOrigin.value.set(overlay.x, overlay.y)
    u.uArmDir.value.set(overlay.dx, overlay.dy)
    u.uArmLeft.value.set(overlay.la, overlay.lb)
    u.uArmRight.value.set(overlay.ra, overlay.rb)
    u.uArmReach.value = overlay.reach
    u.uArmBack.value = overlay.back ?? 0
  }

  /** Show the occluder as a flat tint, without stopping it occluding. */
  setDebug(on) {
    this.depthMaterial.colorWrite = !!on
  }

  setPresence(p) {
    this.uniforms.uPresence.value = p
  }

  dispose() {
    this.geometry.dispose()
    this.depthMaterial.dispose()
    this.maskTexture.dispose()
  }
}

const _section = { a: 0, b: 0 }
