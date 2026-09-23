import * as THREE from 'three'

/**
 * A single pinhole model shared by perception and the renderer.
 *
 * This is what guarantees the 3D jewellery lands exactly on the 2D arm: the
 * three.js camera is constructed from these same numbers, so anything we
 * back-project here re-projects to the identical pixel.
 *
 * World space: camera at the origin looking down -Z, +X right, +Y up,
 * units in millimetres, already in *display* space (mirroring applied).
 */
/**
 * Default lens when nothing better is known: 72 deg across the diagonal, the
 * middle of laptop webcams (65-78) and phone front cameras (70-80).
 *
 * Stated as a DIAGONAL angle because that is what the sensor has; the vertical
 * angle then depends on the frame's aspect ratio. The old default, 60 deg
 * vertical, is ~98 deg diagonal at 16:9 - wider than any normal webcam - which
 * put the wrist too close to the camera and exaggerated the bracelet's
 * perspective.
 */
export const DEFAULT_DIAGONAL_FOV_DEG = 72

const FOV_CACHE_PREFIX = 'vto.fov.v1'

export class CameraModel {
  /**
   * @param {{fovYDeg?:number, diagonalFovDeg?:number}} options fovYDeg pins
   *        the vertical angle outright; otherwise it follows the diagonal
   *        angle and the frame's aspect ratio.
   */
  constructor({ fovYDeg, diagonalFovDeg = DEFAULT_DIAGONAL_FOV_DEG } = {}) {
    this.width = 1280
    this.height = 720
    this.mirrored = true
    this.fixedFovY = Number.isFinite(fovYDeg) ? fovYDeg : null
    this.diagonalFovDeg = diagonalFovDeg
    /** Where the lens angle came from: 'default' | 'fixed' | 'track' | 'cache'. */
    this.fovSource = this.fixedFovY ? 'fixed' : 'default'
    this.fovYDeg = this._deriveFovY()
  }

  setResolution(width, height, mirrored) {
    this.width = width
    this.height = height
    this.mirrored = mirrored
    this.fovYDeg = this._deriveFovY()
  }

  /**
   * Adopt the best available lens angle for this camera, in order: what the
   * browser reports for the track (rare, mostly Android Chrome), a value
   * cached for this device, else the default. After the vto-bracelets
   * intrinsics resolver.
   *
   * @param {MediaTrackSettings|object|null} settings track.getSettings()
   * @param {Storage|null} storage
   */
  resolveLens(settings, storage = safeStorage()) {
    if (this.fixedFovY) return this.fovSource
    const reported = diagonalFromSettings(settings, this.width, this.height)
    if (reported) {
      this.diagonalFovDeg = reported
      this.fovSource = 'track'
    } else {
      const cached = readNumber(storage, cacheKey(settings))
      if (cached > 30 && cached < 130) {
        this.diagonalFovDeg = cached
        this.fovSource = 'cache'
      }
    }
    this.fovYDeg = this._deriveFovY()
    return this.fovSource
  }

  /** Remember a lens angle for this device, e.g. one the user calibrated. */
  rememberLens(settings, diagonalFovDeg, storage = safeStorage()) {
    if (!(diagonalFovDeg > 30 && diagonalFovDeg < 130)) return false
    this.diagonalFovDeg = diagonalFovDeg
    this.fovSource = 'cache'
    this.fovYDeg = this._deriveFovY()
    try {
      storage?.setItem(cacheKey(settings), String(diagonalFovDeg))
      return true
    } catch {
      return false
    }
  }

  _deriveFovY() {
    if (this.fixedFovY) return this.fixedFovY
    const diag = Math.hypot(this.width, this.height)
    const t = Math.tan(THREE.MathUtils.degToRad(this.diagonalFovDeg) * 0.5) * (this.height / diag)
    return THREE.MathUtils.radToDeg(2 * Math.atan(t))
  }

  /** Focal length in pixels. */
  get focalPx() {
    return (0.5 * this.height) / Math.tan(THREE.MathUtils.degToRad(this.fovYDeg) * 0.5)
  }

  get aspect() {
    return this.width / this.height
  }

  /** Normalised MediaPipe image coords -> display pixel coords. */
  toDisplayPx(u, v, out = { x: 0, y: 0 }) {
    out.x = (this.mirrored ? 1 - u : u) * this.width
    out.y = v * this.height
    return out
  }

  /** Display pixel + metric depth (mm, positive in front) -> world point. */
  unproject(px, py, depthMm, out = new THREE.Vector3()) {
    const f = this.focalPx
    out.x = ((px - this.width * 0.5) * depthMm) / f
    out.y = (-(py - this.height * 0.5) * depthMm) / f
    out.z = -depthMm
    return out
  }

  /** World point -> display pixel coords. */
  project(point, out = { x: 0, y: 0 }) {
    const f = this.focalPx
    const depth = Math.max(1e-3, -point.z)
    out.x = (point.x * f) / depth + this.width * 0.5
    out.y = (-point.y * f) / depth + this.height * 0.5
    return out
  }

  /** Millimetres per pixel at a given depth. */
  mmPerPxAt(depthMm) {
    return depthMm / this.focalPx
  }

  applyToThreeCamera(camera) {
    camera.fov = this.fovYDeg
    camera.aspect = this.aspect
    camera.near = 10
    camera.far = 20000
    camera.position.set(0, 0, 0)
    camera.quaternion.identity()
    camera.updateProjectionMatrix()
  }
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // private mode, or Node
  }
}

function readNumber(storage, key) {
  try {
    return Number(storage?.getItem(key))
  } catch {
    return NaN
  }
}

function cacheKey(settings) {
  const id = settings?.deviceId || 'default'
  return `${FOV_CACHE_PREFIX}:${id}:${settings?.width ?? 0}x${settings?.height ?? 0}`
}

/** Diagonal FOV in degrees from whatever lens fields the browser exposes, or null. */
function diagonalFromSettings(settings, width, height) {
  if (!settings || !(width > 0) || !(height > 0)) return null
  const diag = Math.hypot(width, height)
  const toDiag = (focalPx) => THREE.MathUtils.radToDeg(2 * Math.atan(diag / 2 / focalPx))
  const h = settings.horizontalFieldOfView ?? settings.horizontalFov ?? settings.fieldOfView ?? settings.fov
  if (Number.isFinite(h) && h > 0) {
    const rad = h > Math.PI + 0.05 ? THREE.MathUtils.degToRad(h) : h
    if (rad > 0.3 && rad < 2.6) return toDiag(width / 2 / Math.tan(rad / 2))
  }
  const fx = settings.focalLengthX ?? settings.focalLength
  if (Number.isFinite(fx) && fx > 0) return toDiag(fx)
  return null
}
