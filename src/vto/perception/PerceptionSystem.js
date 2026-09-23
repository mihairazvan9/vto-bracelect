import { FilesetResolver, HandLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision'
import { DEFAULT_MODEL_CONFIG } from './models.js'
import { ArmSegmenter } from './ArmSegmenter.js'

/**
 * The fast tracking / input layer.
 *
 * Deliberately thin: it produces raw observations only (landmarks, masks) and
 * makes no decision about where a bracelet goes. Everything downstream consumes
 * these observations through the wrist solver.
 *
 * Hand tracking and segmentation run on independent budgets because they have
 * very different costs and very different rates of change: the hand moves every
 * frame, the arm silhouette does not.
 */
export class PerceptionSystem {
  constructor(config = {}) {
    this.config = { ...DEFAULT_MODEL_CONFIG, ...config }
    this.handLandmarker = null
    this.segmenter = null
    this.ready = false

    // Independent budgets: hand landmarks move every frame; the arm network
    // runs slower because the per-frame refinement carries it in between.
    this.handIntervalMs = 1000 / 30
    this.segIntervalMs = 1000 / 12
    this.lastHandTime = -Infinity
    this.lastSegTime = -Infinity
    /** Per-frame detection budget. Anything left over belongs to the renderer. */
    this.frameBudgetMs = 14

    this.hands = null
    this.handTimestamp = 0
    this.videoWidth = 0
    this.videoHeight = 0
    /** Bumped whenever a new hand result lands, so the engine knows to re-solve. */
    this.revision = 0

    /** Wrist-crop segmentation + per-frame refinement. */
    this.arm = new ArmSegmenter()
    /** Hand geometry in raw video pixels, from the latest landmarks. */
    this.handGeometry = null

    this.stats = { handMs: 0, segMs: 0, handHz: 0, segHz: 0, refineMs: 0 }
    this._handHzStat = []
    this._segHzStat = []
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(this.config.wasmPath)

    this.handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: this.config.handLandmarker,
        delegate: this.config.delegate,
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })

    try {
      this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: this.config.segmenter,
          delegate: this.config.delegate,
        },
        runningMode: 'VIDEO',
        // Soft skin confidence, not a hard category map: the refinement needs
        // the network's uncertainty to know where to look for the edge.
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      })
    } catch (err) {
      // Segmentation is a quality upgrade, not a hard dependency: without it the
      // wrist solver runs on landmarks and the joint model alone.
      console.warn('[VTO] segmentation unavailable, running landmark-only', err)
      this.segmenter = null
    }

    this.ready = true
    return this
  }

  setBudget({ handHz, segHz }) {
    if (handHz) this.handIntervalMs = 1000 / handHz
    if (segHz) this.segIntervalMs = 1000 / segHz
  }

  /**
   * Run whatever is due, within a time budget.
   *
   * Stages are only eligible on a new video frame, so the total detection rate
   * is capped by the camera. Running just ONE stage per frame therefore caps
   * hand + segmentation together at the camera rate, and since they want 40
   * slots a second between them they starve each other — segmentation was
   * landing at 3 Hz. Draining every due stage while the budget lasts lets both
   * hit their target rate, and the budget still protects the render loop.
   */
  process(video, timestampMs) {
    if (!this.ready) return
    this.videoWidth = video.videoWidth
    this.videoHeight = video.videoHeight
    const start = performance.now()

    for (let i = 0; i < 2; i++) {
      const stage = this._pickStage(timestampMs)
      if (!stage) break
      this._runStage(stage, video, timestampMs)
      if (performance.now() - start >= this.frameBudgetMs) break
    }
  }

  /**
   * Which stage is most overdue. A fixed priority order would let the cheapest
   * stage starve the others whenever the frame rate dips.
   */
  _pickStage(timestampMs) {
    const overdue = (last, interval) => (timestampMs - last) / interval

    let stage = null
    let worst = 1

    const handRatio = overdue(this.lastHandTime, this.handIntervalMs)
    if (handRatio >= worst) {
      worst = handRatio
      stage = 'hand'
    }
    // The arm network looks at the wrist crop, so it has nothing to do until
    // there is a hand to crop around.
    if (this.segmenter && this.handGeometry) {
      const r = overdue(this.lastSegTime, this.segIntervalMs)
      if (r >= worst) {
        worst = r
        stage = 'seg'
      }
    }
    return stage
  }

  _runStage(stage, video, timestampMs) {
    if (stage === 'hand') {
      const t0 = performance.now()
      try {
        this.hands = this.handLandmarker.detectForVideo(video, timestampMs)
        this.handTimestamp = timestampMs
        this.handGeometry = ArmSegmenter.geometry(this.hands?.landmarks?.[0], video.videoWidth, video.videoHeight)
        if (!this.handGeometry) this.arm.reset()
        this.revision++
      } catch (err) {
        console.warn('[VTO] hand detection failed', err)
      }
      this.stats.handMs = performance.now() - t0
      this._tickRate(this._handHzStat, timestampMs, 'handHz')
      this.lastHandTime = timestampMs
      return
    }

    if (stage === 'seg') {
      const t0 = performance.now()
      try {
        this.arm.segment(this.segmenter, video, timestampMs, this.handGeometry)
      } catch (err) {
        console.warn('[VTO] segmentation failed', err)
      }
      this.stats.segMs = performance.now() - t0
      this._tickRate(this._segHzStat, timestampMs, 'segHz')
      this.lastSegTime = timestampMs
    }
  }

  _tickRate(buffer, t, key) {
    buffer.push(t)
    while (buffer.length > 12) buffer.shift()
    if (buffer.length > 1) {
      const span = buffer[buffer.length - 1] - buffer[0]
      this.stats[key] = span > 0 ? ((buffer.length - 1) * 1000) / span : 0
    }
  }

  /**
   * Refine the arm mask for the current camera frame. Call once per new video
   * frame, after process(): cheap (~2-3 ms), and it is what keeps the mask
   * describing THIS frame while the network runs at a lower rate.
   */
  refineArm(video, timestampMs) {
    this.arm.refine(video, timestampMs, this.handGeometry)
    this.stats.refineMs = this.arm.stats.refineMs
  }

  /**
   * The refined arm mask ({data, width, height, version, roi}) or null. Covers
   * the region of interest around the wrist only.
   */
  get armMask() {
    return this.arm.armMask
  }

  /**
   * Arm skin probability 0..255 at raw normalised video coords, or -1 where
   * nothing is known (outside the frame or the region of interest).
   */
  sampleMask(u, v) {
    return this.arm.sample(u, v)
  }

  close() {
    this.handLandmarker?.close()
    this.segmenter?.close()
    this.ready = false
  }
}
