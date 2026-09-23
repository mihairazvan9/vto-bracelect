import { clamp, fitEllipseFromSilhouettes, ellipseCircumference, RunningStat } from '../core/mathUtils.js'

const BIN_COUNT = 12 // roll bins across 0..90 degrees

/**
 * Measure once, then freeze. After this many good frames (a measured wrist
 * section, a confident pose, the metric scale already locked) the shape is
 * frozen whether or not the user has turned their wrist: ~1.5 s of data. From
 * then on only the pose changes, until the user asks to re-measure.
 */
export const FREEZE_FRAMES = 45
/**
 * Width : depth of an adult wrist, used when only one view has been seen - a
 * single roll angle cannot separate the two (see the class comment).
 */
const PRIOR_ASPECT = 1.3
/** Freeze gate: width readings needed, and their largest relative spread. */
const FREEZE_MIN_READINGS = 30
const FREEZE_MAX_SPREAD = 0.1 // interquartile range / median
const SINGLE_VIEW_WINDOW = 60
const REFERENCE_S = 18 // mm from the crease: the middle of the bracelet zone

/**
 * Recovers the wrist cross-section from multiple viewing angles.
 *
 * A single front-on frame cannot separate wrist width from wrist depth: a wide
 * flat wrist and a narrow deep one project to the same silhouette. Rotating the
 * wrist changes which axis we see, and the ellipse fit resolves both.
 *
 * Once the fit is good, the shape is locked. Wrist shape does not change during
 * a session; only pose does. Freezing it removes almost all of the scale
 * breathing that makes AR jewellery look fake.
 */
export class GeometrySolver {
  constructor() {
    /** @type {Array<{theta:number,radius:number,weight:number}|null>} */
    this.bins = new Array(BIN_COUNT).fill(null)
    this.profileRatios = null
    this.profileCounts = null

    this.widthMm = 52
    this.depthMm = 38
    this.circumferenceMm = 160
    this.aspect = 52 / 38

    this.locked = false
    this.geometryConfidence = 0
    this.fitResidual = 1
    this.coverage = 0
    this.sampleCount = 0

    this.widthStability = new RunningStat(45)
    /** Width estimates from single views, assuming PRIOR_ASPECT. */
    this._singleView = []
    this.goodFrames = 0
    /** User-supplied ground truth beats any monocular estimate. */
    this.manualCircumferenceMm = null
  }

  reset() {
    this.bins.fill(null)
    this.profileRatios = null
    this.profileCounts = null
    this.locked = false
    this.geometryConfidence = 0
    this.coverage = 0
    this.sampleCount = 0
    this.widthStability.clear()
    this._singleView.length = 0
    this.goodFrames = 0
  }

  unlock() {
    this.locked = false
  }

  /** Override the estimate with a tape-measured circumference. */
  setManualCircumference(mm) {
    this.manualCircumferenceMm = mm && mm > 80 && mm < 260 ? mm : null
    if (this.manualCircumferenceMm) this._applyCircumference(this.manualCircumferenceMm)
  }

  /**
   * Feed one observation. Returns true when the shape estimate changed.
   */
  ingest(observation) {
    if (!observation || observation.poseConfidence < 0.35) return false

    // Frozen: nothing about the arm's SHAPE changes any more - not its
    // cross-section, not how it widens up the arm. Only the pose moves.
    if (this.locked) return false

    const ref = this._referenceSample(observation)
    if (!ref) return false

    this._accumulateProfile(observation, ref.halfWidthMm)

    // Bin by roll so a user holding still at one angle cannot dominate the fit.
    const theta = clamp(observation.rollTheta, 0, Math.PI / 2)
    const bin = Math.min(BIN_COUNT - 1, Math.floor((theta / (Math.PI / 2)) * BIN_COUNT))
    const weight = ref.confidence * observation.poseConfidence
    const existing = this.bins[bin]
    if (!existing || weight > existing.weight) {
      this.bins[bin] = { theta, radius: ref.halfWidthMm, weight }
    }

    const samples = this.bins.filter(Boolean)
    this.sampleCount = samples.length
    this.coverage = this._coverage(samples)

    // Single-view estimate: the half-width seen at this roll, read with a
    // typical wrist aspect. Better than never measuring the wrist at all -
    // without a wrist turn the ellipse fit below never runs, and the shape used
    // to sit at the built-in default for the whole session.
    const measured = ref.measured && ref.confidence > 0.2
    if (measured) {
      const c = Math.cos(theta)
      const sn = Math.sin(theta)
      const a = ref.halfWidthMm / Math.sqrt(c * c + (sn * sn) / (PRIOR_ASPECT * PRIOR_ASPECT))
      this._singleView.push(a)
      if (this._singleView.length > SINGLE_VIEW_WINDOW) this._singleView.shift()
      if (observation.poseConfidence > 0.5) {
        if (observation.scaleLocked !== false) this.goodFrames++
        // The palm may never face the camera (a side-on session), so the
        // metric scale may never lock; freeze anyway, just later.
        else this.goodFrames += 0.5
      }
    }

    const fit = fitEllipseFromSilhouettes(samples)
    this.widthStability.push(ref.halfWidthMm * 2)

    if (!fit) {
      this.geometryConfidence = clamp(this.coverage * 0.4, 0, 0.4)
      if (this._singleView.length >= 8) {
        const sorted = Float64Array.from(this._singleView).sort()
        const a = sorted[sorted.length >> 1]
        this.widthMm += (2 * a - this.widthMm) * 0.25
        this.depthMm = this.widthMm / PRIOR_ASPECT
        this.aspect = PRIOR_ASPECT
        this.circumferenceMm = ellipseCircumference(this.widthMm / 2, this.depthMm / 2)
        if (this.manualCircumferenceMm) this._applyCircumference(this.manualCircumferenceMm)
        this.geometryConfidence = Math.max(this.geometryConfidence, clamp(0.3 + this._singleView.length / 200, 0, 0.5))
      }
      this._maybeFreeze()
      return false
    }

    this.fitResidual = fit.residual
    const residualScore = clamp(1 - fit.residual / 0.18, 0, 1)
    const jitterScore = clamp(1 - this.widthStability.std / 6, 0, 1)
    this.geometryConfidence = clamp(
      this.coverage * 0.45 + residualScore * 0.35 + jitterScore * 0.2,
      0,
      1,
    )

    // The fit gives semi-axes; a is the radial (width) axis by construction.
    const width = fit.a * 2
    const depth = fit.b * 2
    // Physically implausible aspect ratios mean the fit latched onto noise.
    const aspect = width / Math.max(1e-3, depth)
    if (aspect < 1.02 || aspect > 2.3) {
      this.geometryConfidence *= 0.4
      return false
    }

    const blend = this.geometryConfidence > 0.6 ? 0.25 : 0.1
    this.widthMm += (width - this.widthMm) * blend
    this.depthMm += (depth - this.depthMm) * blend
    this.aspect = this.widthMm / this.depthMm
    this.circumferenceMm = ellipseCircumference(this.widthMm / 2, this.depthMm / 2)

    if (this.manualCircumferenceMm) this._applyCircumference(this.manualCircumferenceMm)

    if (this.geometryConfidence > 0.78 && this.coverage > 0.55 && this.sampleCount >= 5) {
      this.locked = true
    }
    this._maybeFreeze()
    return true
  }

  /**
   * Freeze only once the measurement has SETTLED: enough good frames, enough
   * width readings, readings that agree with each other, and a shape estimate
   * that has converged onto them. Freezing on time alone would lock in
   * whatever the first unsettled frames said - for the rest of the session.
   */
  _maybeFreeze() {
    if (this.locked || this.goodFrames < FREEZE_FRAMES || this._singleView.length < FREEZE_MIN_READINGS) return
    const sorted = Float64Array.from(this._singleView).sort()
    const n = sorted.length
    const med = sorted[n >> 1]
    // Interquartile range, not the median absolute deviation: readings split
    // between two values half-and-half have a MAD of zero, and would freeze.
    const spread = (sorted[Math.floor(n * 0.75)] - sorted[Math.floor(n * 0.25)]) / med
    const converged = Math.abs(this.widthMm - 2 * med) / (2 * med) < 0.03
    if (spread <= FREEZE_MAX_SPREAD && (converged || this.coverage > 0.55)) this.locked = true
  }

  _applyCircumference(mm) {
    // Keep the measured aspect ratio, scale to the known circumference.
    const scale = mm / Math.max(1e-3, this.circumferenceMm)
    this.widthMm *= scale
    this.depthMm *= scale
    this.circumferenceMm = mm
  }

  /**
   * Coverage rewards angular *spread*, not sample count: twelve samples from
   * one angle tell us nothing the first one did not.
   */
  _coverage(samples) {
    if (samples.length < 2) return 0
    const thetas = samples.map((s) => s.theta).sort((a, b) => a - b)
    const span = thetas[thetas.length - 1] - thetas[0]
    const filled = samples.length / BIN_COUNT
    // A full separation of width from depth needs roughly 50 degrees of roll.
    const spanScore = clamp(span / (Math.PI * 0.28), 0, 1)
    return clamp(spanScore * 0.7 + filled * 0.3, 0, 1)
  }

  _referenceSample(observation) {
    let best = null
    let bestDist = Infinity
    for (const entry of observation.profile) {
      if (!entry.measured) continue
      const d = Math.abs(entry.s - REFERENCE_S)
      if (d < bestDist) {
        bestDist = d
        best = entry
      }
    }
    if (best && bestDist <= 22) return best
    // No mask measurement: still usable for the anthropometric prior, but never
    // strong enough to justify locking a shape.
    const prior = observation.profile.find((e) => e.s === 0)
    return prior ? { ...prior, confidence: 0.18 } : null
  }

  /**
   * Average the shape of the radius profile over time. The absolute scale comes
   * from the ellipse fit; this just records how the forearm tapers.
   */
  _accumulateProfile(observation, refHalfWidth) {
    const n = observation.profile.length
    if (!this.profileRatios) {
      this.profileRatios = new Float32Array(n)
      this.profileCounts = new Float32Array(n)
    }
    for (let i = 0; i < n; i++) {
      const entry = observation.profile[i]
      if (!entry.measured) continue
      const ratio = entry.halfWidthMm / Math.max(1e-3, refHalfWidth)
      if (ratio < 0.5 || ratio > 2.2) continue
      const c = this.profileCounts[i]
      const w = Math.min(1, entry.confidence)
      this.profileRatios[i] = (this.profileRatios[i] * c + ratio * w) / (c + w)
      this.profileCounts[i] = Math.min(60, c + w)
    }
  }

  /** Taper ratio at profile index i, relative to the reference section. */
  ratioAt(i, fallback) {
    if (!this.profileRatios || this.profileCounts[i] < 1.5) return fallback
    return this.profileRatios[i]
  }

  /**
   * Visual fit confidence and physical size confidence are genuinely different
   * things and conflating them is how VTO products end up over-promising.
   * The first says the bracelet sits on the arm correctly; the second says the
   * millimetres are right.
   */
  get sizingConfidence() {
    if (this.manualCircumferenceMm) return 0.97
    // Monocular scale rests on MediaPipe world landmarks, which are a learned
    // prior, not a measurement instrument. Cap accordingly.
    return clamp(this.geometryConfidence * 0.8, 0, 0.8)
  }
}
