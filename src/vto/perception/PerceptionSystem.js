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
    // The hand runs on every camera frame up to 60 fps: a frame it skips is
    // drawn with a predicted pose, which is exactly where the bracelet stops
    // sticking to the arm. (At 30 Hz, a 60 fps camera had every other frame
    // predicted.)
    this.handIntervalMs = 1000 / 60
    this.segIntervalMs = 1000 / 12
    this.lastHandTime = -Infinity
    this.lastSegTime = -Infinity
    /**
     * Per-camera-frame detection budget, ms. The hand always runs when due;
     * the arm network joins it only if its recent cost still fits. At 14 ms
     * the network (15-23 ms at 720p) regularly took the hand's slot and the
     * hand was detected at 18 Hz off a 30 fps camera; at 28 ms hand (~11 ms)
     * plus network (~20 ms) did not fit and the network fell to 6 Hz. A
     * camera frame lasts 33 ms, and the jewellery only changes when one
     * arrives, so spending most of it on detection costs at most a repeated
     * display frame.
     */
    this.frameBudgetMs = 32
    /** Recent cost of each stage, ms (for the budget decision). */
    this._segCost = 18

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
   * Run whatever is due on this camera frame.
   *
   * The hand goes first whenever it is due: it IS the pose, and every frame
   * it misses is a frame the bracelet is predicted instead of measured. The
   * arm network runs after it, when its recent cost still fits the frame's
   * budget - or regardless, once it is two intervals late, so it can never
   * be starved outright (a stale mask is refused downstream anyway).
   *
   * @param {{image: TexImageSource, width: number, height: number}} frame
   *        one camera frame (CameraStream.takeFrame); every stage reads it
   *
   * (Picking the most overdue stage instead let the network, due less often
   * but always "more overdue" when it was, take the hand's frame: on a 30 fps
   * camera the hand ran at 18 Hz.)
   */
  process(frame, timestampMs) {
    if (!this.ready) return
    this.videoWidth = frame.width
    this.videoHeight = frame.height
    const start = performance.now()

    if (timestampMs - this.lastHandTime >= this.handIntervalMs * 0.8) {
      this._runStage('hand', frame, timestampMs)
    }
    // The arm network looks at the wrist crop, so it has nothing to do until
    // there is a hand to crop around.
    if (!this.segmenter || !this.handGeometry) return
    const overdue = (timestampMs - this.lastSegTime) / this.segIntervalMs
    if (overdue < 1) return
    const spent = performance.now() - start
    if (overdue >= 2 || spent + this._segCost <= this.frameBudgetMs) {
      this._runStage('seg', frame, timestampMs)
    }
  }

  _runStage(stage, frame, timestampMs) {
    if (stage === 'hand') {
      const t0 = performance.now()
      try {
        this.hands = this.handLandmarker.detectForVideo(frame.image, timestampMs)
        this.handTimestamp = timestampMs
        this.handGeometry = ArmSegmenter.geometry(this.hands?.landmarks?.[0], frame.width, frame.height)
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
        this.arm.segment(this.segmenter, frame, timestampMs, this.handGeometry)
      } catch (err) {
        console.warn('[VTO] segmentation failed', err)
      }
      this.stats.segMs = performance.now() - t0
      this._segCost += (this.stats.segMs - this._segCost) * 0.3
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
  refineArm(frame, timestampMs) {
    this.arm.refine(frame, timestampMs, this.handGeometry)
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
