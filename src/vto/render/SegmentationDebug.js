import * as THREE from 'three'

/**
 * Debug view of the segmentation mask.
 *
 * The mask is the least visible and most consequential input in the pipeline:
 * it decides where the wrist is measured, where measurement stops at a sleeve,
 * and where the occluder is trimmed. When a bracelet sits wrong, the mask is
 * usually why, and until you can see it you are guessing.
 *
 * Drawn as a full-screen overlay in its own orthographic pass so it composites
 * over the finished frame without touching the 3D scene's depth.
 *
 * Shows the refined skin mask over its region of interest (blue frame).
 * Inside the arm the measurement actually used it is green (amber where
 * uncertain); skin the network saw but the measurement ignored - face, neck,
 * the hand itself - is grey. The white lines are the fitted arm outlines.
 */
export class SegmentationDebug {
  constructor() {
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    this.uniforms = {
      uMask: { value: null },
      uMirror: { value: 0 },
      uOpacity: { value: 0.42 },
      uHasMask: { value: 0 },
      uRoi: { value: new THREE.Vector4(0, 0, 1, 1) },
      // Measured arm corridor, display px: origin, direction, outlines, reach.
      uHasArm: { value: 0 },
      uArmOrigin: { value: new THREE.Vector2() },
      uArmDir: { value: new THREE.Vector2(0, 1) },
      uArmLeft: { value: new THREE.Vector2() },
      uArmRight: { value: new THREE.Vector2() },
      uArmReach: { value: 0 },
      uArmBack: { value: 0 },
      uViewport: { value: new THREE.Vector2(1, 1) },
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D uMask;
        uniform float uMirror;
        uniform float uOpacity;
        uniform float uHasMask;
        uniform vec4 uRoi;
        uniform float uHasArm;
        uniform vec2 uArmOrigin;
        uniform vec2 uArmDir;
        uniform vec2 uArmLeft;
        uniform vec2 uArmRight;
        uniform float uArmReach;
        uniform float uArmBack;
        uniform vec2 uViewport;

        void main() {
          if (uHasMask < 0.5) discard;
          vec2 uv = vUv;
          // The mask lives in raw video coordinates; the canvas is display space.
          if (uMirror > 0.5) uv.x = 1.0 - uv.x;
          // Mask row 0 is the top of the image and DataTexture does not flipY,
          // while vUv.y is 0 at the bottom of the screen. See WristOccluder.
          uv.y = 1.0 - uv.y;
          vec2 r = (uv - uRoi.xy) / uRoi.zw;
          if (r.x < 0.0 || r.y < 0.0 || r.x > 1.0 || r.y > 1.0) discard;
          float edge = min(min(r.x, 1.0 - r.x), min(r.y, 1.0 - r.y));
          if (edge < 0.006) {
            gl_FragColor = vec4(0.45, 0.65, 1.0, 0.8);
            return;
          }
          float p = texture2D(uMask, r).r;

          // Where this pixel sits relative to the measured arm (display px).
          float armMask = 0.0;
          float outline = 0.0;
          if (uHasArm > 0.5) {
            vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uViewport - uArmOrigin;
            vec2 perp = vec2(-uArmDir.y, uArmDir.x);
            float s = dot(px, uArmDir);
            float v = dot(px, perp);
            float left = uArmLeft.x + uArmLeft.y * s;
            float right = uArmRight.x + uArmRight.y * s;
            if (s > -uArmBack && s < uArmReach) {
              armMask = step(left - 1.5, v) * step(v, right + 1.5);
              outline = max(1.0 - abs(v - left), 1.0 - abs(v - right));
            }
          }
          if (outline > 0.0 && uHasArm > 0.5) {
            gl_FragColor = vec4(1.0, 1.0, 1.0, 0.85 * outline);
            return;
          }
          if (p < 0.35) discard;
          vec3 c = mix(vec3(0.95, 0.70, 0.20), vec3(0.25, 0.95, 0.45), smoothstep(0.45, 0.75, p));
          // Skin the measurement did not use.
          if (uHasArm > 0.5 && armMask < 0.5) c = vec3(0.55, 0.58, 0.62);
          gl_FragColor = vec4(c, uOpacity * smoothstep(0.35, 0.6, p));
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
    this.enabled = false
  }

  /**
   * Shares the occluder's mask texture rather than uploading a second copy.
   * @param {{roi:{x:number,y:number,w:number,h:number}}|null} armMask
   */
  setMask(texture, armMask, mirrored) {
    this.uniforms.uMask.value = texture
    this.uniforms.uHasMask.value = armMask ? 1 : 0
    this.uniforms.uMirror.value = mirrored ? 1 : 0
    if (armMask?.roi) this.uniforms.uRoi.value.set(armMask.roi.x, armMask.roi.y, armMask.roi.w, armMask.roi.h)
  }

  /**
   * The arm corridor the measurement used (WristObserver armOverlay), in
   * display pixels of a viewport this size. null hides it.
   */
  setArm(overlay, viewportWidth, viewportHeight) {
    const u = this.uniforms
    u.uHasArm.value = overlay ? 1 : 0
    u.uViewport.value.set(viewportWidth, viewportHeight)
    if (!overlay) return
    u.uArmOrigin.value.set(overlay.x, overlay.y)
    u.uArmDir.value.set(overlay.dx, overlay.dy)
    u.uArmLeft.value.set(overlay.la, overlay.lb)
    u.uArmRight.value.set(overlay.ra, overlay.rb)
    u.uArmReach.value = overlay.reach
    u.uArmBack.value = overlay.back ?? 0
  }

  render(renderer) {
    if (!this.enabled) return
    if (!this.uniforms.uHasMask.value) return
    renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.quad.geometry.dispose()
    this.material.dispose()
  }
}
