import { MaskRefiner } from './MaskRefiner.js'
import { SEG_CLASS } from './models.js'

/**
 * Arm segmentation, done where the arm is.
 *
 * WHAT CHANGED, AND WHY (measured against SAM reference masks on the recorded
 * clips; tools/eval reproduces every number):
 *
 *   Full-frame selfie model, the old input:   arm found in 66-82 % of frames,
 *                                             axis error 4-5 deg, width 6-9 %,
 *                                             width error 43-62 % edge-on.
 *   This:                                     arm found in 100 %, axis 1.9 deg,
 *                                             width 3.1 %.
 *
 * 1. WRIST CROP. The network is given a square crop around the wrist, 4.4 palm
 *    lengths across, instead of the whole frame. Its input is 256x256 either
 *    way, so the arm gets several times more network pixels. Tighter crops
 *    were tried and fail badly (the selfie model needs to see some body for
 *    context); 4.4 was the best of 2.4 / 3.2 / 4.4 / 5.6.
 * 2. SKIN ONLY. Only the body-skin confidence is used. Clothing is not
 *    segmented at all: where the arm's skin stops, measurement stops.
 * 3. PER-FRAME REFINEMENT. The network runs at ~12 Hz. Every camera frame,
 *    its last output is shifted by how far the wrist has moved since, and
 *    MaskRefiner fuses it with this person's skin colour and snaps it to the
 *    image edges (guided filter) at ~160 px over the region of interest, so
 *    the mask describes THIS frame at camera sharpness.
 *
 * Coordinates: everything here is in RAW video pixels (the camera's own
 * orientation, before any mirroring for display), matching MediaPipe.
 */

/** Network crop: this many palm lengths across, centred this far down the arm. */
const CROP_PALMS = 4.4
const CROP_BIAS = 0.35
/** Refinement region: palm lengths across, and its resolution in pixels. */
const ROI_PALMS = 3.2
const ROI_SIZE = 160
const NET_SIZE = 256
/** A network result older than this no longer describes the arm. */
const MAX_NET_AGE_MS = 600

export class ArmSegmenter {
  constructor() {
    this.refiner = new MaskRefiner()
    this.netCanvas = makeCanvas(NET_SIZE, NET_SIZE)
    this.netCtx = this.netCanvas.getContext('2d', { willReadFrequently: false })
    this.roiCanvas = makeCanvas(ROI_SIZE, ROI_SIZE)
    this.roiCtx = this.roiCanvas.getContext('2d', { willReadFrequently: true })

    /** Last network skin confidence, NET_SIZE^2, and where its crop was. */
    this.net = new Float32Array(NET_SIZE * NET_SIZE)
    this.netCrop = { x: 0, y: 0, size: 0 }
    this.netWrist = { x: 0, y: 0 }
    this.netTime = -Infinity
    this.hasNet = false

    this._prior = new Float32Array(ROI_SIZE * ROI_SIZE)
    this._prob = new Float32Array(ROI_SIZE * ROI_SIZE)
    /**
     * The refined arm mask, in the region of interest. `roi` is in normalised
     * raw video coords so renderers can place it.
     */
    this.armMask = null
    this._mask = {
      data: new Uint8Array(ROI_SIZE * ROI_SIZE),
      width: ROI_SIZE,
      height: ROI_SIZE,
      version: 0,
      roi: { x: 0, y: 0, w: 0, h: 0 },
    }
    this._roi = { x: 0, y: 0, size: 0 }
    this.videoWidth = 0
    this.videoHeight = 0
    this.stats = { refineMs: 0 }
  }

  reset() {
    this.hasNet = false
    this.armMask = null
  }

  /**
   * Hand geometry in raw video pixels, from MediaPipe's normalised landmarks.
   * @returns {{wx:number, wy:number, ax:number, ay:number, palm:number}|null}
   *          wrist, unit direction from palm to wrist (down the arm), palm length
   */
  static geometry(landmarks, vw, vh) {
    if (!landmarks || landmarks.length < 18) return null
    const x = (i) => landmarks[i].x * vw
    const y = (i) => landmarks[i].y * vh
    const cx = (x(0) + x(5) + x(9) + x(13) + x(17)) / 5
    const cy = (y(0) + y(5) + y(9) + y(13) + y(17)) / 5
    const d = Math.hypot(x(0) - cx, y(0) - cy)
    const palm = Math.hypot(x(9) - x(0), y(9) - y(0))
    if (!(d > 1) || !(palm > 8)) return null
    return { wx: x(0), wy: y(0), ax: (x(0) - cx) / d, ay: (y(0) - cy) / d, palm }
  }

  /** Run the network on the wrist crop. Call at the segmentation rate. */
  segment(segmenter, video, timestampMs, geom) {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!segmenter || !geom || !vw) return false
    const size = geom.palm * CROP_PALMS
    const cx = geom.wx + geom.ax * geom.palm * CROP_BIAS
    const cy = geom.wy + geom.ay * geom.palm * CROP_BIAS
    const crop = { x: cx - size / 2, y: cy - size / 2, size }

    const g = this.netCtx
    g.fillStyle = '#000'
    g.fillRect(0, 0, NET_SIZE, NET_SIZE)
    drawCrop(g, video, crop, vw, vh, NET_SIZE)

    let ok = false
    segmenter.segmentForVideo(this.netCanvas, timestampMs, (result) => {
      const conf = result.confidenceMasks?.[SEG_CLASS.BODY_SKIN]
      if (conf && conf.width === NET_SIZE && conf.height === NET_SIZE) {
        this.net.set(conf.getAsFloat32Array())
        ok = true
      } else if (conf) {
        resampleInto(conf.getAsFloat32Array(), conf.width, conf.height, this.net, NET_SIZE)
        ok = true
      }
      result.close?.()
    })
    if (ok) {
      this.netCrop = crop
      this.netWrist.x = geom.wx
      this.netWrist.y = geom.wy
      this.netTime = timestampMs
      this.hasNet = true
    }
    return ok
  }

  /**
   * Refine for the current camera frame. Call once per new video frame.
   * @returns {boolean} whether a mask is available for this frame
   */
  refine(video, timestampMs, geom) {
    const vw = video.videoWidth
    const vh = video.videoHeight
    this.videoWidth = vw
    this.videoHeight = vh
    if (!geom || !this.hasNet || timestampMs - this.netTime > MAX_NET_AGE_MS) {
      this.armMask = null
      return false
    }
    const t0 = performance.now()

    // Region of interest: wrist plus forearm, square, in raw video pixels.
    const size = geom.palm * ROI_PALMS
    const roi = this._roi
    roi.x = geom.wx + geom.ax * geom.palm * CROP_BIAS - size / 2
    roi.y = geom.wy + geom.ay * geom.palm * CROP_BIAS - size / 2
    roi.size = size

    const g = this.roiCtx
    g.clearRect(0, 0, ROI_SIZE, ROI_SIZE)
    drawCrop(g, video, roi, vw, vh, ROI_SIZE)
    let rgba
    try {
      rgba = g.getImageData(0, 0, ROI_SIZE, ROI_SIZE).data
    } catch {
      this.armMask = null
      return false
    }
    /** This frame's region-of-interest pixels (RGBA), e.g. for exposure checks. */
    this.lastRoiRgba = rgba

    // Network prior for each ROI pixel, motion-compensated: the arm has moved
    // with the wrist since the network looked at it.
    const shiftX = geom.wx - this.netWrist.x
    const shiftY = geom.wy - this.netWrist.y
    const crop = this.netCrop
    const scale = size / ROI_SIZE
    const toNet = NET_SIZE / crop.size
    const prior = this._prior
    for (let j = 0; j < ROI_SIZE; j++) {
      const vy = roi.y + (j + 0.5) * scale - shiftY
      const ny = (vy - crop.y) * toNet - 0.5
      for (let i = 0; i < ROI_SIZE; i++) {
        const vx = roi.x + (i + 0.5) * scale - shiftX
        const nx = (vx - crop.x) * toNet - 0.5
        prior[j * ROI_SIZE + i] = sampleBilinear(this.net, NET_SIZE, nx, ny)
      }
    }

    const prob = this.refiner.refine(rgba, 4, prior, ROI_SIZE, ROI_SIZE, this._prob)

    const m = this._mask
    for (let k = 0; k < prob.length; k++) m.data[k] = (prob[k] * 255 + 0.5) | 0
    // Pixels beyond the frame edge are unknown, not background.
    for (let j = 0; j < ROI_SIZE; j++) {
      const vy = roi.y + (j + 0.5) * scale
      for (let i = 0; i < ROI_SIZE; i++) {
        const vx = roi.x + (i + 0.5) * scale
        if (vx < 0 || vy < 0 || vx >= vw || vy >= vh) m.data[j * ROI_SIZE + i] = 0
      }
    }
    m.version++
    m.roi.x = roi.x / vw
    m.roi.y = roi.y / vh
    m.roi.w = size / vw
    m.roi.h = size / vh
    this.armMask = m
    this.stats.refineMs = performance.now() - t0
    return true
  }

  /**
   * Skin probability 0..255 at raw normalised video coords, bilinear.
   * -1 outside the frame or outside the region of interest: unknown, which
   * the arm profiler treats as "out of view" rather than "arm ends here".
   */
  sample(u, v) {
    if (!this.armMask || u < 0 || v < 0 || u > 1 || v > 1) return -1
    const r = this._roi
    const fx = ((u * this.videoWidth - r.x) / r.size) * ROI_SIZE - 0.5
    const fy = ((v * this.videoHeight - r.y) / r.size) * ROI_SIZE - 0.5
    if (fx < -0.5 || fy < -0.5 || fx > ROI_SIZE - 0.5 || fy > ROI_SIZE - 0.5) return -1
    return sampleBilinear(this._mask.data, ROI_SIZE, fx, fy)
  }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * Draw a square source region into a size x size canvas. The part of the
 * region beyond the frame is left as is (cleared by the caller), with the
 * visible part placed exactly where it belongs.
 */
function drawCrop(g, video, crop, vw, vh, size) {
  const sx0 = Math.max(0, crop.x)
  const sy0 = Math.max(0, crop.y)
  const sx1 = Math.min(vw, crop.x + crop.size)
  const sy1 = Math.min(vh, crop.y + crop.size)
  if (sx1 <= sx0 || sy1 <= sy0) return
  const k = size / crop.size
  g.drawImage(
    video,
    sx0, sy0, sx1 - sx0, sy1 - sy0,
    (sx0 - crop.x) * k, (sy0 - crop.y) * k, (sx1 - sx0) * k, (sy1 - sy0) * k,
  )
}

function sampleBilinear(data, n, fx, fy) {
  if (fx < -0.5 || fy < -0.5 || fx > n - 0.5 || fy > n - 0.5) return 0
  const x0 = fx < 0 ? 0 : fx | 0
  const y0 = fy < 0 ? 0 : fy | 0
  const x1 = x0 + 1 < n ? x0 + 1 : x0
  const y1 = y0 + 1 < n ? y0 + 1 : y0
  const ax = fx - x0 < 0 ? 0 : fx - x0 > 1 ? 1 : fx - x0
  const ay = fy - y0 < 0 ? 0 : fy - y0 > 1 ? 1 : fy - y0
  return (
    data[y0 * n + x0] * (1 - ax) * (1 - ay) +
    data[y0 * n + x1] * ax * (1 - ay) +
    data[y1 * n + x0] * (1 - ax) * ay +
    data[y1 * n + x1] * ax * ay
  )
}

function resampleInto(src, sw, sh, dst, n) {
  for (let j = 0; j < n; j++) {
    const sy = Math.min(sh - 1, ((j + 0.5) * sh) / n) | 0
    for (let i = 0; i < n; i++) {
      const sx = Math.min(sw - 1, ((i + 0.5) * sw) / n) | 0
      dst[j * n + i] = src[sy * sw + sx]
    }
  }
}
