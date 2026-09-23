/**
 * Turns a coarse skin probability into an accurate arm mask, per frame, inside
 * a small region of interest around the wrist.
 *
 * WHY
 * The segmentation network sees a 256x256 thumbnail of the whole frame, so an
 * arm 50 px wide on screen is ~10 network pixels wide. Its boundary is right
 * to within a few pixels at best, and a few pixels on each side of a wrist is
 * 5-10 % of its width - exactly the number the fit engine sells against.
 * Scored against SAM reference masks on recorded clips, boundary F1 at 2 px
 * was ~0.57. The network is right about WHERE the arm is; it is wrong about
 * where its EDGE is. The image itself knows where the edge is.
 *
 * WHAT
 *   1. Colour evidence. From pixels the network is confident about - deep
 *      inside the arm, well outside it - learn this person's skin and this
 *      background under this light, as two chromaticity+brightness
 *      histograms, and score every ROI pixel by likelihood ratio.
 *   2. Fusion in log-odds: network prior + colour evidence.
 *   3. Guided filter (He, Sun & Tang): an edge-preserving smoother that
 *      transfers the structure of the camera image into the probability map,
 *      so the 0.5 contour moves onto the real image edge. It is O(N) with box
 *      filters and is what production video-call segmentation uses to upgrade
 *      low-resolution masks.
 *
 * Everything is plain typed arrays so the same code runs in the browser and
 * in the Node evaluation harness (tools/eval).
 */

const BINS = 24
const LUMA_BINS = 4
const HIST = BINS * BINS * LUMA_BINS
const EPS = 1e-6

export const DEFAULT_REFINE = {
  /** Network probability above/below which a pixel trains skin/background. */
  confidentSkin: 0.85,
  confidentBackground: 0.15,
  /** Weight of colour log-odds against network log-odds. */
  colourWeight: 0.6,
  networkWeight: 1.0,
  /**
   * Guided filter radius in pixels (at a ~200 px ROI), and regularisation
   * (guide in 0..1). Chosen on the recorded clips: r3 / 1e-3.
   */
  radius: 3,
  eps: 1e-3,
  /**
   * Full RGB guide. Scored no better than the luma guide on the recorded
   * clips and costs twice as much, so off by default.
   */
  colourGuide: false,
  /**
   * Grey-level closing radius (px) applied last: fills holes that dark hair
   * and shading punch in forearm skin without moving the outer edge. 0 = off.
   */
  closeRadius: 0,
}

export class MaskRefiner {
  constructor(options = {}) {
    this.options = { ...DEFAULT_REFINE, ...options }
    this.skin = new Float32Array(HIST)
    this.bg = new Float32Array(HIST)
    this._buf = {}
  }

  _f32(name, n) {
    const b = this._buf[name]
    if (b && b.length >= n) return b
    return (this._buf[name] = new Float32Array(n))
  }

  /**
   * @param {Uint8Array|Uint8ClampedArray} rgb interleaved RGB or RGBA
   * @param {number} channels 3 or 4
   * @param {Float32Array} prob network skin probability 0..1, same w*h
   * @param {number} w
   * @param {number} h
   * @param {Float32Array} [out] refined probability 0..1
   * @returns {Float32Array}
   */
  refine(rgb, channels, prob, w, h, out = new Float32Array(w * h)) {
    const o = this.options
    const n = w * h

    // --- 1. Colour model from confident pixels ------------------------------
    const skin = this.skin
    const bg = this.bg
    skin.fill(0)
    bg.fill(0)
    const bins = this._binsBuf(n)
    let nSkin = 0
    let nBg = 0
    for (let i = 0, p = 0; i < n; i++, p += channels) {
      const bin = binOf(rgb[p], rgb[p + 1], rgb[p + 2])
      bins[i] = bin
      const q = prob[i]
      if (q >= o.confidentSkin) { skin[bin]++; nSkin++ }
      else if (q <= o.confidentBackground) { bg[bin]++; nBg++ }
    }
    const fused = this._f32('fused', n)
    const useColour = nSkin > 30 && nBg > 30 && o.colourWeight > 0
    // Colour log-likelihood ratio per BIN, not per pixel: 2304 logs instead
    // of one per pixel. Densities carry a small prior so unseen colours say
    // nothing.
    const colourLr = this._colourLr || (this._colourLr = new Float32Array(HIST))
    if (useColour) {
      const ks = 1 / (nSkin + HIST * 0.05)
      const kb = 1 / (nBg + HIST * 0.05)
      for (let b = 0; b < HIST; b++) {
        colourLr[b] = o.colourWeight * Math.log(((skin[b] + 0.05) * ks) / ((bg[b] + 0.05) * kb))
      }
    }
    const netLogit = networkLogitTable(o.networkWeight)
    for (let i = 0; i < n; i++) {
      const q = prob[i]
      let logit = netLogit[q <= 0 ? 0 : q >= 1 ? LOGIT_STEPS : (q * LOGIT_STEPS + 0.5) | 0]
      if (useColour) logit += colourLr[bins[i]]
      fused[i] = 1 / (1 + Math.exp(-logit))
    }

    // --- 2. Guided filter ---------------------------------------------------
    if (o.radius <= 0) {
      out.set(fused.subarray(0, n))
      return out
    }
    if (o.colourGuide) this._guidedColour(rgb, channels, fused, w, h, out)
    else this._guidedGray(rgb, channels, fused, w, h, out)
    for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, out[i]))
    if (o.closeRadius > 0) {
      const t = this._f32('closeTmp', n)
      const u = this._f32('closeTmp2', n)
      extremeFilter(out, w, h, o.closeRadius, u, t, true)  // dilate
      extremeFilter(u, w, h, o.closeRadius, out, t, false) // erode
    }
    return out
  }

  _binsBuf(n) {
    if (!this._bins || this._bins.length < n) this._bins = new Uint16Array(n)
    return this._bins
  }

  /** Single-channel guided filter with the luma as guide. */
  _guidedGray(rgb, ch, p, w, h, out) {
    const n = w * h
    const r = this.options.radius
    const eps = this.options.eps
    const I = this._f32('I', n)
    for (let i = 0, k = 0; i < n; i++, k += ch) I[i] = (0.299 * rgb[k] + 0.587 * rgb[k + 1] + 0.114 * rgb[k + 2]) / 255
    const Ip = this._f32('Ip', n)
    const II = this._f32('II', n)
    for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i] }
    const mI = boxFilter(I, w, h, r, this._f32('mI', n), this._f32('t0', n))
    const mp = boxFilter(p, w, h, r, this._f32('mp', n), this._f32('t0', n))
    const mIp = boxFilter(Ip, w, h, r, this._f32('mIp', n), this._f32('t0', n))
    const mII = boxFilter(II, w, h, r, this._f32('mII', n), this._f32('t0', n))
    const a = this._f32('a', n)
    const b = this._f32('b', n)
    for (let i = 0; i < n; i++) {
      const cov = mIp[i] - mI[i] * mp[i]
      const v = mII[i] - mI[i] * mI[i]
      a[i] = cov / (v + eps)
      b[i] = mp[i] - a[i] * mI[i]
    }
    const ma = boxFilter(a, w, h, r, this._f32('ma', n), this._f32('t0', n))
    const mb = boxFilter(b, w, h, r, this._f32('mb', n), this._f32('t0', n))
    for (let i = 0; i < n; i++) out[i] = ma[i] * I[i] + mb[i]
    return out
  }

  /** Colour-guided filter: a 3x3 covariance per pixel, so hue edges count too. */
  _guidedColour(rgb, ch, p, w, h, out) {
    const n = w * h
    const r = this.options.radius
    const eps = this.options.eps
    const f = (name) => this._f32(name, n)
    const R = f('R')
    const G = f('G')
    const B = f('B')
    for (let i = 0, k = 0; i < n; i++, k += ch) {
      R[i] = rgb[k] / 255
      G[i] = rgb[k + 1] / 255
      B[i] = rgb[k + 2] / 255
    }
    const t = f('t0')
    const box = (src, name) => boxFilter(src, w, h, r, f(name), t)
    const prod = (x, y, name) => {
      const d = f(name)
      for (let i = 0; i < n; i++) d[i] = x[i] * y[i]
      return d
    }
    const mR = box(R, 'mR')
    const mG = box(G, 'mG')
    const mB = box(B, 'mB')
    const mp = box(p, 'mp')
    const mRp = box(prod(R, p, 'Rp'), 'mRp')
    const mGp = box(prod(G, p, 'Gp'), 'mGp')
    const mBp = box(prod(B, p, 'Bp'), 'mBp')
    const vRR = box(prod(R, R, 'RR'), 'vRR')
    const vRG = box(prod(R, G, 'RG'), 'vRG')
    const vRB = box(prod(R, B, 'RB'), 'vRB')
    const vGG = box(prod(G, G, 'GG'), 'vGG')
    const vGB = box(prod(G, B, 'GB'), 'vGB')
    const vBB = box(prod(B, B, 'BB'), 'vBB')
    const aR = f('aR')
    const aG = f('aG')
    const aB = f('aB')
    const b = f('b')
    for (let i = 0; i < n; i++) {
      const cR = mRp[i] - mR[i] * mp[i]
      const cG = mGp[i] - mG[i] * mp[i]
      const cB = mBp[i] - mB[i] * mp[i]
      const rr = vRR[i] - mR[i] * mR[i] + eps
      const rg = vRG[i] - mR[i] * mG[i]
      const rb = vRB[i] - mR[i] * mB[i]
      const gg = vGG[i] - mG[i] * mG[i] + eps
      const gb = vGB[i] - mG[i] * mB[i]
      const bb = vBB[i] - mB[i] * mB[i] + eps
      // Inverse of the symmetric 3x3 covariance.
      const i00 = gg * bb - gb * gb
      const i01 = gb * rb - rg * bb
      const i02 = rg * gb - gg * rb
      const i11 = rr * bb - rb * rb
      const i12 = rb * rg - rr * gb
      const i22 = rr * gg - rg * rg
      const det = rr * i00 + rg * i01 + rb * i02
      const inv = Math.abs(det) > 1e-12 ? 1 / det : 0
      aR[i] = (i00 * cR + i01 * cG + i02 * cB) * inv
      aG[i] = (i01 * cR + i11 * cG + i12 * cB) * inv
      aB[i] = (i02 * cR + i12 * cG + i22 * cB) * inv
      b[i] = mp[i] - aR[i] * mR[i] - aG[i] * mG[i] - aB[i] * mB[i]
    }
    const maR = box(aR, 'maR')
    const maG = box(aG, 'maG')
    const maB = box(aB, 'maB')
    const mb = box(b, 'mb')
    for (let i = 0; i < n; i++) out[i] = maR[i] * R[i] + maG[i] * G[i] + maB[i] * B[i] + mb[i]
    return out
  }
}

/**
 * Chromaticity (rg) plus a coarse brightness band. Chromaticity alone divides
 * out shading, which is right for skin; the brightness band stops a pale wall
 * and a lit forearm of similar hue from sharing a bin.
 */
function binOf(r, g, b) {
  const s = r + g + b
  if (s < 30) return HIST - 1
  const rn = Math.min(BINS - 1, ((r / s) * BINS * 1.5) | 0)
  const gn = Math.min(BINS - 1, ((g / s) * BINS * 1.5) | 0)
  const l = Math.min(LUMA_BINS - 1, ((s / 766) * LUMA_BINS) | 0)
  return (l * BINS + gn) * BINS + rn
}

const LOGIT_STEPS = 1024
const _logitTables = new Map()
/** log(q / (1 - q)) * weight, tabulated over q in [0, 1]. */
function networkLogitTable(weight) {
  let t = _logitTables.get(weight)
  if (t) return t
  t = new Float32Array(LOGIT_STEPS + 1)
  for (let k = 0; k <= LOGIT_STEPS; k++) {
    const q = Math.min(1 - 1e-4, Math.max(1e-4, k / LOGIT_STEPS))
    t[k] = weight * Math.log(q / (1 - q))
  }
  _logitTables.set(weight, t)
  return t
}

/**
 * Separable max (dilate) or min (erode) over a (2r+1)^2 square. O(N r); r is
 * a few pixels here, so the simple form is fine.
 */
function extremeFilter(src, w, h, r, out, tmp, isMax) {
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let m = src[row + x]
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        const v = src[row + k]
        if (isMax ? v > m : v < m) m = v
      }
      tmp[row + x] = m
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = tmp[y * w + x]
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        const v = tmp[k * w + x]
        if (isMax ? v > m : v < m) m = v
      }
      out[y * w + x] = m
    }
  }
  return out
}

/** Mean over a (2r+1)^2 window, clamped at the borders. O(N) via running sums. */
export function boxFilter(src, w, h, r, out, tmp) {
  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    let count = 0
    for (let x = 0; x <= Math.min(r, w - 1); x++) { acc += src[row + x]; count++ }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / count
      const add = x + r + 1
      const sub = x - r
      if (add < w) { acc += src[row + add]; count++ }
      if (sub >= 0) { acc -= src[row + sub]; count-- }
    }
  }
  // Vertical pass.
  for (let x = 0; x < w; x++) {
    let acc = 0
    let count = 0
    for (let y = 0; y <= Math.min(r, h - 1); y++) { acc += tmp[y * w + x]; count++ }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / count
      const add = y + r + 1
      const sub = y - r
      if (add < h) { acc += tmp[add * w + x]; count++ }
      if (sub >= 0) { acc -= tmp[sub * w + x]; count-- }
    }
  }
  return out
}

export const __test__ = { binOf, EPS }
