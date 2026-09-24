import * as THREE from 'three'

const SAMPLE_W = 64
const SAMPLE_H = 36
const ENV_W = 128
const ENV_H = 64

/**
 * Lighting reconstruction from the camera image.
 *
 * Jewellery exposes bad AR lighting instantly: if the highlight on the gold
 * runs the opposite way to the highlight on the skin next to it, the illusion is
 * gone regardless of how good the shader is.
 *
 * This is deliberately not full HDR reconstruction. It recovers four things —
 * key direction, key intensity, ambient level and colour temperature — plus a
 * low-resolution local environment that includes the wearer's own skin, which is
 * what gives metal its warm bounce near the wrist.
 */
export class LightEstimator {
  constructor(renderer) {
    this.renderer = renderer
    this.sampleCanvas = document.createElement('canvas')
    this.sampleCanvas.width = SAMPLE_W
    this.sampleCanvas.height = SAMPLE_H
    this.sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true })

    this.envCanvas = document.createElement('canvas')
    this.envCanvas.width = ENV_W
    this.envCanvas.height = ENV_H
    this.envCtx = this.envCanvas.getContext('2d')

    this.envTexture = new THREE.CanvasTexture(this.envCanvas)
    this.envTexture.mapping = THREE.EquirectangularReflectionMapping
    this.envTexture.colorSpace = THREE.SRGBColorSpace

    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.pmrem.compileEquirectangularShader()
    this.environment = null
    /** The render target behind `environment`. Disposing the texture alone
     *  leaves the target allocated, which leaks a few MB every rebuild. */
    this._envTarget = null

    this.keyDirection = new THREE.Vector3(0.4, 0.8, 0.5).normalize()
    this.keyIntensity = 1.6
    this.ambientIntensity = 0.7
    this.colorTemperature = new THREE.Color(1, 1, 1)
    this.exposure = 1

    this.envIntervalMs = 420
    this._lastEnvUpdate = -Infinity
    /** getImageData is a CPU readback; lighting does not change at 60 Hz. */
    this.sampleIntervalMs = 1000 / 12
    this._lastSample = -Infinity
    this.enabled = true
    this.skinColor = new THREE.Color(0.85, 0.68, 0.58)
  }

  /**
   * @param {{image: CanvasImageSource, width: number, height: number}} frame  the camera frame (CameraStream.takeFrame)
   * @param {{x:number,y:number,r:number}|null} wristRegion  normalised crop of the wrist
   */
  update(frame, wristRegion, nowMs, mirrored) {
    if (!this.enabled || !frame.width) return
    if (nowMs - this._lastSample < this.sampleIntervalMs) return
    this._lastSample = nowMs

    this.sampleCtx.drawImage(frame.image, 0, 0, SAMPLE_W, SAMPLE_H)
    let data
    try {
      data = this.sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data
    } catch {
      return // tainted canvas; skip silently rather than break the frame
    }

    let sumL = 0
    let sumR = 0
    let sumG = 0
    let sumB = 0
    let wx = 0
    let wy = 0
    let wsum = 0
    let maxL = 0

    for (let y = 0; y < SAMPLE_H; y++) {
      for (let x = 0; x < SAMPLE_W; x++) {
        const i = (y * SAMPLE_W + x) * 4
        const r = data[i] / 255
        const g = data[i + 1] / 255
        const b = data[i + 2] / 255
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
        sumL += l
        sumR += r
        sumG += g
        sumB += b
        if (l > maxL) maxL = l
        // Weight toward the bright end: the key light is where the highlights are.
        const w = l * l * l
        wx += x * w
        wy += y * w
        wsum += w
      }
    }

    const n = SAMPLE_W * SAMPLE_H
    const meanL = sumL / n
    const meanR = sumR / n
    const meanG = sumG / n
    const meanB = sumB / n

    if (wsum > 1e-5) {
      // Brightness centroid, in normalised image coords, converted to a light
      // direction. Depth is assumed: a monocular frame cannot tell us how far
      // in front the light is, and guessing wrong is more wrong than assuming.
      let cx = (wx / wsum / SAMPLE_W) * 2 - 1
      const cy = 1 - (wy / wsum / SAMPLE_H) * 2
      if (mirrored) cx = -cx
      this.keyDirection.set(cx, cy, 0.85).normalize()
    }

    // Grey-world white balance gives us the cast to match, not to remove.
    const grey = Math.max(1e-4, (meanR + meanG + meanB) / 3)
    this.colorTemperature.setRGB(meanR / grey, meanG / grey, meanB / grey)

    // Contrast between the brightest region and the average tells us how
    // directional the scene is: flat light => almost no key.
    const contrast = Math.max(0, maxL - meanL)
    this.keyIntensity = THREE.MathUtils.clamp(0.55 + contrast * 3.2, 0.4, 3.2)
    this.ambientIntensity = THREE.MathUtils.clamp(0.25 + meanL * 1.5, 0.25, 1.6)
    this.exposure = THREE.MathUtils.clamp(0.85 + (0.45 - meanL) * 0.5, 0.7, 1.25)

    if (nowMs - this._lastEnvUpdate > this.envIntervalMs) {
      this._buildEnvironment(frame, wristRegion, data, meanR, meanG, meanB)
      this._lastEnvUpdate = nowMs
    }
  }

  /**
   * Builds a crude equirectangular environment from the frame: sky above,
   * ground below, and a warm lobe of the wearer's own skin where the wrist is.
   * Cheap, but it is the difference between gold that reflects a studio and gold
   * that reflects the room the user is actually standing in.
   */
  _buildEnvironment(frame, wristRegion, data, meanR, meanG, meanB) {
    const ctx = this.envCtx

    // Average the top and bottom thirds of the frame separately.
    const band = (y0, y1) => {
      let r = 0, g = 0, b = 0, c = 0
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < SAMPLE_W; x++) {
          const i = (y * SAMPLE_W + x) * 4
          r += data[i]; g += data[i + 1]; b += data[i + 2]; c++
        }
      }
      return `rgb(${(r / c) | 0}, ${(g / c) | 0}, ${(b / c) | 0})`
    }

    const grad = ctx.createLinearGradient(0, 0, 0, ENV_H)
    grad.addColorStop(0, band(0, Math.floor(SAMPLE_H / 3)))
    grad.addColorStop(0.5, band(Math.floor(SAMPLE_H / 3), Math.floor((2 * SAMPLE_H) / 3)))
    grad.addColorStop(1, band(Math.floor((2 * SAMPLE_H) / 3), SAMPLE_H))
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, ENV_W, ENV_H)

    // The camera itself is a bright source in most indoor setups (the screen).
    ctx.globalAlpha = 0.35
    const camGrad = ctx.createRadialGradient(ENV_W * 0.5, ENV_H * 0.45, 2, ENV_W * 0.5, ENV_H * 0.45, ENV_W * 0.28)
    camGrad.addColorStop(0, `rgba(255,255,255,${THREE.MathUtils.clamp(this.keyIntensity * 0.3, 0.1, 0.8)})`)
    camGrad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = camGrad
    ctx.fillRect(0, 0, ENV_W, ENV_H)
    ctx.globalAlpha = 1

    // Local skin bounce: sample the actual wrist crop and smear it into the
    // lower-front of the environment, where a bracelet would see it.
    if (wristRegion && frame.width) {
      const px = wristRegion.x * frame.width
      const py = wristRegion.y * frame.height
      const pr = Math.max(8, wristRegion.r * frame.width)
      ctx.save()
      ctx.globalAlpha = 0.55
      ctx.filter = 'blur(6px)'
      ctx.drawImage(
        frame.image,
        Math.max(0, px - pr), Math.max(0, py - pr), pr * 2, pr * 2,
        ENV_W * 0.28, ENV_H * 0.58, ENV_W * 0.44, ENV_H * 0.42,
      )
      ctx.restore()
    }

    this.envTexture.needsUpdate = true
    const previous = this._envTarget
    this._envTarget = this.pmrem.fromEquirectangular(this.envTexture)
    this.environment = this._envTarget.texture
    previous?.dispose()
  }

  applyTo(scene, keyLight, ambientLight, renderer) {
    if (!this.enabled) return
    keyLight.position.copy(this.keyDirection).multiplyScalar(1000)
    keyLight.intensity = this.keyIntensity
    keyLight.color.copy(this.colorTemperature)
    ambientLight.intensity = this.ambientIntensity
    ambientLight.color.copy(this.colorTemperature)
    renderer.toneMappingExposure = this.exposure
    if (this.environment) scene.environment = this.environment
  }

  dispose() {
    this.pmrem.dispose()
    this.envTexture.dispose()
    this._envTarget?.dispose()
  }
}
