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
 * What an adult wrist can be, relative to itself and to the hand: width over
 * depth (adult wrists run ~1.2-1.5), and width over the wrist-to-knuckle span
 * (0.65-0.79 on the SAM reference masks of the recordings, see WristObserver).
 * Without these the multi-view fit, fed a few noisy roll bins, produced an
 * 81 x 45 mm wrist on one recording and a 190 mm circumference on another.
 */
const ASPECT_MIN = 1.1
const ASPECT_MAX = 1.6
const WIDTH_PER_PALM_MIN = 0.55
const WIDTH_PER_PALM_MAX = 0.85

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

    /**
     * The shape as MEASURED, in the observations' own millimetres. Everything
     * inside the solver (blending, the plausibility bounds, the freeze test)
     * works on these; the published widthMm / depthMm below are these scaled
     * to a tape-measured circumference when there is one. Mixing the two once
     * kept a wrist with a manual size from ever freezing.
     */
    this._w = 52
    this._d = 38
    /**
     * Whether the shape has been measured yet (this session, or remembered
     * from one). Until then widthMm / depthMm are only a placeholder to build
     * geometry with: never shown, sized against or worn (see sizeKnown).
     */
    this.measured = false
    this.widthMm = 52
    this.depthMm = 38
    this.circumferenceMm = ellipseCircumference(26, 19)
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
    this.remembered = false
    this.measured = false
    this.geometryConfidence = 0
    this.coverage = 0
    this.sampleCount = 0
    this.widthStability.clear()
    this._singleView.length = 0
    this.goodFrames = 0
  }

  /**
   * Start from this person's wrist as measured in earlier sessions on this
   * device (see VTOEngine's wrist memory): the shape is set and frozen at
   * once. Monocular scale differs by up to +-25 % between sessions of the
   * same hand on the recordings - consistent within a session, never across
   * - so remembering is what makes a returning person the same size every
   * time. reset() ("Re-measure") measures afresh.
   * @returns {boolean} whether the memory was usable
   */
  adoptRemembered({ widthMm, depthMm } = {}) {
    if (!(widthMm > 25 && widthMm < 90 && depthMm > 18 && depthMm < 70)) return false
    this._w = widthMm
    this._d = depthMm
    this.measured = true
    this._publish()
    this.geometryConfidence = 0.75
    this.coverage = 1
    this.locked = true
    this.remembered = true
    return true
  }

  unlock() {
    this.locked = false
  }

  /** A real wrist size is known: measured, remembered, or typed in. No placeholder is ever used as one. */
  get sizeKnown() {
    return this.measured || !!this.manualCircumferenceMm
  }

  /** Override the estimate with a tape-measured circumference. */
  setManualCircumference(mm) {
    this.manualCircumferenceMm = mm && mm > 80 && mm < 260 ? mm : null
    this._publish()
  }

  /**
   * Feed one observation. Returns true when the shape estimate changed.
   */
  ingest(observation) {
    if (!observation || observation.poseConfidence < 0.35) return false
    if (observation.palmLengthMm > 0) this._palmMm = observation.palmLengthMm

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

    let fit = fitEllipseFromSilhouettes(samples)
    this.widthStability.push(ref.halfWidthMm * 2)
    // Physically implausible aspect ratios mean the fit latched onto noise:
    // fall back on the single-view estimate rather than on nothing (which
    // left the built-in default shape standing for the whole session).
    if (fit) {
      const fitAspect = fit.a / Math.max(1e-3, fit.b)
      if (fitAspect < 1.02 || fitAspect > 1.9) fit = null
    }

    if (!fit) {
      this.geometryConfidence = clamp(this.coverage * 0.4, 0, 0.4)
      if (this._singleView.length >= 8) {
        const sorted = Float64Array.from(this._singleView).sort()
        const a = sorted[sorted.length >> 1]
        // The first reading replaces the placeholder; later ones refine it.
        this._w = this.measured ? this._w + (2 * a - this._w) * 0.25 : 2 * a
        this.measured = true
        this._d = this._w / PRIOR_ASPECT
        this._plausible()
        this._publish()
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
    const blend = this.geometryConfidence > 0.6 ? 0.25 : 0.1
    this._w = this.measured ? this._w + (width - this._w) * blend : width
    this._d = this.measured ? this._d + (depth - this._d) * blend : depth
    this.measured = true
    this._plausible()
    this._publish()

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
    const converged = Math.abs(this._w - 2 * med) / (2 * med) < 0.03
    if (spread <= FREEZE_MAX_SPREAD && (converged || this.coverage > 0.55)) this.locked = true
  }

  /** Keep the shape inside what an adult wrist can be (see ASPECT_MIN and friends). */
  _plausible() {
    const palm = this._palmMm
    if (palm > 0) this._w = clamp(this._w, palm * WIDTH_PER_PALM_MIN, palm * WIDTH_PER_PALM_MAX)
    this._d = clamp(this._d, this._w / ASPECT_MAX, this._w / ASPECT_MIN)
  }

  /** The measured shape, scaled to the tape-measured circumference if there is one (aspect kept). */
  _publish() {
    const measured = ellipseCircumference(this._w / 2, this._d / 2)
    const k = this.manualCircumferenceMm ? this.manualCircumferenceMm / Math.max(1e-3, measured) : 1
    this.widthMm = this._w * k
    this.depthMm = this._d * k
    this.aspect = this._w / this._d
    this.circumferenceMm = measured * k
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
