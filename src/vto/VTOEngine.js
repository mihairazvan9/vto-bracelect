import * as THREE from 'three'
import { CameraStream } from './camera/CameraStream.js'
import { CameraModel } from './camera/CameraModel.js'
import { PerceptionSystem } from './perception/PerceptionSystem.js'
import { WristObserver, palmFromScale } from './wrist/WristObserver.js'
import { WristTracker } from './wrist/WristTracker.js'
import { FREEZE_FRAMES } from './wrist/GeometrySolver.js'
import { FitSolver } from './fit/FitSolver.js'
import { RigidSolver } from './physics/RigidSolver.js'
import { XPBDChainSolver } from './physics/XPBDChainSolver.js'
import { BraceletMesh } from './render/jewelryMeshes.js'
import { WristOccluder } from './render/WristOccluder.js'
import { LightEstimator } from './render/LightEstimator.js'
import { SkeletonDebug } from './render/SkeletonDebug.js'
import { SegmentationDebug } from './render/SegmentationDebug.js'
import { LandmarkSourceBuilder } from './wrist/LandmarkSources.js'
import { HAND_CONNECTIONS } from './perception/models.js'
import { WristFrameDebug } from './render/WristFrameDebug.js'
import { WallsDebug } from './render/WallsDebug.js'
import { BraceletCategory } from './assets/schema.js'
import { DEFAULT_LIVELINESS } from './physics/tuning.js'
import { TrackingState } from './core/TrackingState.js'
import { clamp } from './core/mathUtils.js'

const MAX_RENDER_WIDTH = 1280
/** How long a fitted arm outline is kept through frames that produced none. */
const ARM_OUTLINE_HOLD_MS = 150
/**
 * This device's memory of the wearer's wrist (see GeometrySolver.adoptRemembered):
 * MediaPipe's raw palm reading and the wrist's shape relative to the palm,
 * averaged over at most this many sessions, so one unlucky session cannot
 * redefine a person. The shape ratios are measurements; the millimetres
 * follow from the palm (palmFromScale), which tightens as sessions add up.
 * v1 stored millimetres read at MediaPipe's own scale - 119 mm for one
 * session of a hand that read 154 mm in the next - and is not carried over.
 */
const WRIST_MEMORY_KEY = 'mmto.wrist.v2'
const WRIST_MEMORY_SESSIONS = 5
/** Good palm frames a session with a remembered wrist reads before adding them to the memory. */
const PALM_MEMORY_SAMPLES = 30


/**
 * The VTO engine.
 *
 * Pipeline per frame:
 *   camera -> perception (budgeted) -> wrist observation -> temporal twin
 *          -> fit -> physics -> render (occlusion, contact, lighting)
 *
 * The render loop deliberately runs free of the detector rate: the twin
 * extrapolates, so jewellery is redrawn at display rate even when perception is
 * only managing 25 Hz.
 */
export class VTOEngine {
  constructor(canvas, { fovYDeg, quality = 'high' } = {}) {
    this.canvas = canvas
    this.quality = quality

    this.stream = new CameraStream()
    this.cameraModel = new CameraModel({ fovYDeg })
    this.perception = new PerceptionSystem()
    this.observer = new WristObserver(this.cameraModel)
    this.sources = new LandmarkSourceBuilder()
    this.tracker = new WristTracker(this.cameraModel)
    this.fitSolver = new FitSolver()

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality === 'high',
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(1) // we match video pixels exactly
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.autoClear = false

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(this.cameraModel.fovYDeg, 16 / 9, 10, 20000)

    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.6)
    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.35)
    this.fillLight.position.set(-300, -200, 600)
    this.ambient = new THREE.AmbientLight(0xffffff, 0.7)
    this.scene.add(this.keyLight, this.fillLight, this.ambient)

    this.jewelryRoot = new THREE.Group()
    this.scene.add(this.jewelryRoot)

    this.occluder = new WristOccluder()
    this.scene.add(this.occluder.depthMesh)

    this.lighting = new LightEstimator(this.renderer)

    // Two views of the same hand. The 3D set is what survived the translation
    // solve; the 2D set is the raw detector output, lifted to a common depth so
    // it lands on exactly the pixels MediaPipe reported. Showing both is how you
    // see what the solve is adding - concentric dots mean it is behaving.
    this.handDebug = new SkeletonDebug({ count: 21, connections: HAND_CONNECTIONS })
    this.hand2DDebug = new SkeletonDebug({
      count: 21,
      connections: HAND_CONNECTIONS,
      solveColor: 0xffffff,
      otherColor: 0xc8d0d8,
      lineColor: 0xe4ebf2,
      radius: 2.3, // smaller, so in "both" it nests inside the 3D marker
    })
    this.hand2DDebug.group.renderOrder = 110
    this.scene.add(this.handDebug.group, this.hand2DDebug.group)
    /** Raw 2D landmarks unprojected to the solved wrist depth. */
    this.landmarks2D = Array.from({ length: 21 }, () => new THREE.Vector3())
    this.has2D = false
    this.segmentationDebug = new SegmentationDebug()
    /** Last observed landmark set, kept for the debug overlay between detections. */
    this.lastLandmarks3D = null
    this.lastLandmarkCount = 0

    this.wristFrameDebug = new WristFrameDebug()
    this.scene.add(this.wristFrameDebug.group)
    this.wallsDebug = new WallsDebug()
    this.scene.add(this.wallsDebug.group)
    /** Snapshot of the raw, unfiltered rotation observation, for the overlay. */
    this.rawFrame = {
      valid: false,
      x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(),
      origin: new THREE.Vector3(),
      palmWrist: new THREE.Vector3(), palmIndex: new THREE.Vector3(), palmPinky: new THREE.Vector3(),
      thumb: new THREE.Vector3(),
      rollDeg: 0, dorsalAgreement: 0, reprojectionPx: 0,
      forearmCorrectionDeg: 0, forearmFromSilhouette: false,
      wristFlexDeg: 0, wristDeviationDeg: 0, armMotion: 0, silhouetteConfidence: 0,
    }

    this._setupBackground()

    /** @type {Array<{asset:object,fit:object,mesh:BraceletMesh,rigid:RigidSolver|null,chain:XPBDChainSolver|null}>} */
    this.instances = []

    this.calibration = {
      active: true,
      coverage: 0,
      locked: false,
      prompt: 'Hold your wrist in view and slowly turn it',
    }

    this.diagnostics = {
      fps: 0,
      state: TrackingState.LOST,
      handHz: 0,
      segHz: 0,
      handMs: 0,
      segMs: 0,
      presence: 0,
      wristKnown: false,
      wristWidthMm: 0,
      wristDepthMm: 0,
      circumferenceMm: 0,
      shapeLocked: false,
      /** The wrist shape came from this device's memory of earlier sessions. */
      wristRemembered: false,
      visualFitConfidence: 0,
      physicalSizeConfidence: 0,
      jitterPx: 0,
      jitterDeg: 0,
      breathingPct: 0,
      sleeveLimitMm: Infinity,
      rollDeg: 0,
      dorsalAgreement: 0,
      angularSpeedDeg: 0,
      reprojectionPx: 0,
      forearmCorrectionDeg: 0,
      forearmFromSilhouette: false,
      wristFlexDeg: 0,
      wristDeviationDeg: 0,
      armMotion: 0,
      silhouetteConfidence: 0,
      refineMs: 0,
      maskActive: false,
      /** Frames per second the camera actually delivers (0 = unknown). */
      cameraFps: 0,
    }

    this.options = {
      showOccluder: false,
      /** 'off' | '2d' | '3d' | 'both' */
      landmarkView: 'off',
      showWristFrame: false,
      showSegmentation: false,
      /** Draw the invisible physics walls that keep the bracelet on the arm. */
      showWalls: false,
      /**
       * How alive the jewellery is, 0 (calm) .. 1 (lively): how much of the
       * arm's motion reaches it and how fast that dies away (physics/tuning.js).
       */
      physicsLiveliness: DEFAULT_LIVELINESS,
      lightEstimation: true,
    }

    this._running = false
    this._lastFrame = 0
    this._fpsAccum = []
    this._onFrame = this._onFrame.bind(this)
    this._debug = null
    this._lastRevision = -1
    /** When the video frame currently on screen arrived; the pose is rendered for it. */
    this._displayTime = 0
    this._solveIndices = []
    /** A CaptureSession recording test clips, or null (dev tool). */
    this.capture = null
    this._lastFrameTime = -Infinity
  }

  async start(constraints) {
    await this.stream.start(constraints)
    await this.perception.init()
    this._syncResolution()
    this._resolveLens()
    this._recallWrist()
    this._running = true
    this._lastFrame = performance.now()
    requestAnimationFrame(this._onFrame)
    return this
  }

  async flipCamera() {
    await this.stream.flip()
    this._syncResolution()
    this._resolveLens()
    this.observer.reset()
    this.tracker.reset()
    this._recallWrist()
    this.instances.forEach((i) => {
      i.rigid?.reset()
      i.chain?.reset()
    })
  }

  /** Pick up the lens angle for the active camera, if anything better is known. */
  _resolveLens() {
    const track = this.stream.stream?.getVideoTracks?.()[0]
    const settings = track?.getSettings?.() ?? null
    this.cameraModel.setResolution(this._renderW, this._renderH, this.stream.mirrored)
    this.cameraModel.resolveLens(settings)
    this.cameraModel.applyToThreeCamera(this.camera)
    this.diagnostics.fovSource = this.cameraModel.fovSource
    this.diagnostics.fovYDeg = +this.cameraModel.fovYDeg.toFixed(1)
  }

  stop() {
    this._running = false
    this.stream.stop()
  }

  // ---------------------------------------------------------------- catalogue

  setStack(assets) {
    // Dispose anything no longer wanted.
    const keep = new Set(assets.map((a) => a.id))
    this.instances = this.instances.filter((inst) => {
      if (keep.has(inst.asset.id)) return true
      this.jewelryRoot.remove(inst.mesh.group)
      inst.mesh.dispose()
      return false
    })

    for (const asset of assets) {
      if (this.instances.some((i) => i.asset.id === asset.id)) continue
      const fit = this.fitSolver.evaluate(asset, this.tracker.twin)
      const mesh = new BraceletMesh(asset, fit, this.quality)
      if (this.lighting.environment) mesh.setEnvironment(this.lighting.environment)
      this.jewelryRoot.add(mesh.group)
      const articulated =
        asset.category !== BraceletCategory.RIGID_BANGLE && asset.category !== BraceletCategory.OPEN_CUFF
      this.instances.push({
        asset,
        fit,
        mesh,
        rigid: articulated ? null : new RigidSolver(),
        chain: articulated ? new XPBDChainSolver() : null,
      })
    }

    // Preserve the order the user picked them in — that is the stack order.
    this.instances.sort((a, b) => assets.indexOf(a.asset) - assets.indexOf(b.asset))
  }

  /** Override the wrist measurement with a real tape measurement. */
  setManualWristCircumference(mm) {
    this.tracker.geometry.setManualCircumference(mm)
  }

  /** Measure the wrist afresh - and forget what this device remembered about it. */
  recalibrate() {
    try {
      localStorage.removeItem(WRIST_MEMORY_KEY)
    } catch {
      // storage unavailable: nothing was remembered either
    }
    this.observer.setRememberedPalm(null)
    this.tracker.geometry.reset()
    this._wristSaved = false
    this.calibration.active = true
    this.calibration.locked = false
  }

  /** Start from the wrist this device measured before, if any. */
  _recallWrist() {
    const memory = readWristMemory()
    if (!memory) return
    this.observer.setRememberedPalm(memory.palmRawMm, memory.sessions)
    const palm = palmFromScale(memory.palmRawMm, memory.sessions)
    const shape = { widthMm: memory.widthPerPalm * palm, depthMm: memory.depthPerPalm * palm }
    if (this.tracker.geometry.adoptRemembered(shape)) this.calibration.active = false
  }

  /**
   * Fold this session into this device's memory, once: a running mean over
   * the last WRIST_MEMORY_SESSIONS sessions. A session that measured the
   * wrist adds its shape and palm; one that started from the memory adds its
   * palm reading only (its shape was never measured). Returns whether this
   * session is done with the memory.
   */
  _rememberWrist() {
    const g = this.tracker.geometry
    const scale = this.observer.palmScale
    if (g.manualCircumferenceMm || !scale.locked) return false
    const prev = readWristMemory()
    if (g.remembered && (!prev || scale.samples < PALM_MEMORY_SAMPLES)) return !prev
    const n = Math.min(prev?.sessions ?? 0, WRIST_MEMORY_SESSIONS - 1)
    const mix = (a, b) => (prev ? (a * n + b) / (n + 1) : b)
    const memory = {
      // Geometric mean: the reading's error is a scale factor.
      palmRawMm: +Math.exp(mix(Math.log(prev?.palmRawMm), Math.log(scale.rawMm))).toFixed(1),
      widthPerPalm: g.remembered ? prev.widthPerPalm : +mix(prev?.widthPerPalm, g.widthMm / scale.mm).toFixed(4),
      depthPerPalm: g.remembered ? prev.depthPerPalm : +mix(prev?.depthPerPalm, g.depthMm / scale.mm).toFixed(4),
      sessions: n + 1,
      at: new Date().toISOString(),
    }
    try {
      localStorage.setItem(WRIST_MEMORY_KEY, JSON.stringify(memory))
    } catch {
      // storage unavailable (private window): the session simply is not remembered
    }
    return true
  }

  skipCalibration() {
    this.calibration.active = false
  }

  // ------------------------------------------------------------------- loop

  _onFrame(now) {
    if (!this._running) return
    requestAnimationFrame(this._onFrame)

    const dt = clamp((now - this._lastFrame) / 1000, 1 / 240, 1 / 15)
    this._lastFrame = now

    if (!this.stream.ready) return
    this._syncResolution()

    // --- Perception (budgeted, may do nothing this frame) ------------------
    if (this.stream.hasNewFrame()) {
      const frameTime = this._frameTime(now)
      this._displayTime = frameTime
      this.perception.process(this.stream.video, frameTime)
      // Refine the arm mask first: the observation below reads the silhouette
      // through it, so it has to describe THIS frame, not the network's last.
      this.perception.refineArm(this.stream.video, frameTime)

      // Re-solve whenever either detector produced something new, not just the
      // hand: in pose-only mode the hand never updates at all.
      let observation = null
      if (this.perception.revision !== this._lastRevision) {
        this._lastRevision = this.perception.revision
        const source = this.sources.build(this.perception.hands, this.cameraModel)
        observation = this.observer.observe(source, this.perception, frameTime)
        if (observation) {
          this.tracker.ingest(observation)
          this.lastLandmarks3D = observation.landmarks3D
          this.lastLandmarkCount = observation.landmarkCount
          this._solveIndices = source.solve.map((p) => p.i)
          this._lift2DLandmarks(observation)
          this._snapshotRawFrame(observation)
          // Keep the last outline through a brief gap (a frame whose mask gave
          // no fit) instead of dropping it; after ARM_OUTLINE_HOLD_MS it would
          // describe an arm that has moved, and is let go.
          if (observation.armOverlay) {
            this._armOverlay = { ...observation.armOverlay }
            this._armOverlayTime = now
          } else if (now - (this._armOverlayTime ?? -Infinity) > ARM_OUTLINE_HOLD_MS) {
            this._armOverlay = null
          }
        }
      }

      // Guided recording (dev tool, src/vto/capture): one sample for every
      // camera frame the hand detector ran on, with what it and the arm
      // segmentation made of that frame.
      if (this.capture && this.perception.handTimestamp === frameTime) {
        this.capture.onFrame(this._captureSample(frameTime, observation))
      }
    }

    // --- Twin (predicted to *now*, not to the last detection) --------------
    const twin = this.tracker.update(now, dt, this._displayTime)
    const presence = this.tracker.presence

    this._updateCalibration()

    // --- Fit + physics ------------------------------------------------------
    // A wrist size just became known (first measurement, or after Re-measure):
    // seat every piece afresh on it rather than on whatever arm it last saw.
    const sizeKnown = this.tracker.geometry.sizeKnown
    if (sizeKnown && !this._sizeWasKnown) {
      for (const inst of this.instances) {
        inst.rigid?.reset()
        inst.chain?.reset()
      }
    }
    this._sizeWasKnown = sizeKnown
    if (twin.valid) {
      this._solveStack(twin, dt)
    }

    // --- Lighting -----------------------------------------------------------
    if (this.options.lightEstimation) {
      this.lighting.enabled = true
      this.lighting.update(this.stream.video, this._wristRegion(twin), now, this.stream.mirrored)
      this.lighting.applyTo(this.scene, this.keyLight, this.ambient, this.renderer)
      if (this.lighting.environment) {
        for (const inst of this.instances) inst.mesh.setEnvironment(this.lighting.environment)
      }
    } else {
      this.lighting.enabled = false
    }

    // --- Occlusion ----------------------------------------------------------
    this.occluder.update(twin)
    this.occluder.setMask(
      this.perception.armMask,
      this.stream.mirrored,
      this.renderer.domElement.width,
      this.renderer.domElement.height,
    )
    this.occluder.setArm(twin.valid ? this._armOverlay : null)
    this.occluder.setPresence(presence)
    this.occluder.setDebug(this.options.showOccluder)

    for (const inst of this.instances) inst.mesh.setPresence(presence)

    // Drawn from the last observation rather than the predicted pose: this is
    // meant to show what the detector actually reported.
    const view = this.options.landmarkView
    const showAny = view !== 'off' && twin.valid
    this.handDebug.setSolveIndices(this._solveIndices)
    this.handDebug.update(
      this.lastLandmarks3D,
      showAny && (view === '3d' || view === 'both'),
      Math.min(21, this.lastLandmarkCount),
    )
    this.hand2DDebug.setSolveIndices(this._solveIndices)
    this.hand2DDebug.update(
      this.landmarks2D,
      showAny && this.has2D && (view === '2d' || view === 'both'),
      21,
    )
    this.wristFrameDebug.update(twin, this.rawFrame, this.options.showWristFrame)
    this.wallsDebug.update(twin, this.instances, this.options.showWalls)

    this.segmentationDebug.enabled = this.options.showSegmentation
    this.segmentationDebug.setMask(
      this.occluder.maskTexture,
      this.perception.armMask,
      this.stream.mirrored,
    )
    this.segmentationDebug.setArm(
      twin.valid ? this._armOverlay : null,
      this.renderer.domElement.width,
      this.renderer.domElement.height,
    )

    // --- Render -------------------------------------------------------------
    this.renderer.clear(true, true, false)
    this.renderer.render(this.bgScene, this.bgCamera)
    this.renderer.clearDepth()
    this.renderer.render(this.scene, this.camera)
    this.segmentationDebug.render(this.renderer)

    this._updateDiagnostics(now, dt, twin, presence)
  }

  _solveStack(twin, dt) {
    // Stacking: each piece gets its own band of forearm so they sit side by side
    // instead of intersecting, then the chains collide with their neighbours.
    let cursor = 0
    const neighbours = []
    const physics = { liveliness: this.options.physicsLiveliness }

    for (let i = 0; i < this.instances.length; i++) {
      const inst = this.instances[i]
      const width = Math.max(inst.asset.stockRadiusMm * 2, inst.asset.links?.widthMm ?? 0)
      const bias = i === 0 ? 0 : cursor
      cursor += width + 1.6

      inst.fit = this.fitSolver.evaluate(inst.asset, twin, bias)

      if (inst.rigid) {
        inst.rigid.solve(inst.asset, inst.fit, twin, dt, neighbours, physics)
        inst.mesh.applyRigid(inst.rigid, inst.fit)
        neighbours.push({
          center: inst.rigid.position,
          axis: twin.forearmAxis,
          radiusA: inst.fit.ringA,
          radiusB: inst.fit.ringB,
          stockRadiusMm: inst.asset.stockRadiusMm,
        })
      } else {
        inst.chain.solve(inst.asset, inst.fit, twin, dt, neighbours, physics)
        inst.mesh.applyChain(inst.chain)
        neighbours.push({
          center: twin.pointAt(inst.fit.restingOffsetMm, new THREE.Vector3()),
          axis: twin.forearmAxis,
          radiusA: inst.fit.ringA,
          radiusB: inst.fit.ringB,
          stockRadiusMm: inst.asset.stockRadiusMm,
        })
      }
    }
  }

  /**
   * Copy the raw rotation evidence out of the observation.
   *
   * The observer reuses its vectors between frames, and the overlay needs to
   * hold the last observation while the tracker keeps predicting past it, so
   * this has to be a copy rather than a reference.
   */
  /**
   * Lift the raw 2D image landmarks into the scene.
   *
   * They all go to one depth - the solved wrist depth - so unprojecting and
   * re-projecting is an identity: each marker lands on exactly the pixel
   * MediaPipe reported, and every marker is the same on-screen size as its 3D
   * counterpart. Any visible gap between the two sets is therefore real
   * disagreement between the detector and the solve, not a drawing artefact.
   */
  _lift2DLandmarks(observation) {
    const px = observation.landmarksPx
    const depth = observation.depthMm
    if (!px || !(depth > 0)) {
      this.has2D = false
      return
    }
    const n = Math.min(21, px.length)
    for (let i = 0; i < n; i++) {
      this.cameraModel.unproject(px[i].x, px[i].y, depth, this.landmarks2D[i])
    }
    this.has2D = n === 21
  }

  /**
   * The time of the camera frame being processed, ms: when the camera captured
   * it, where the browser reports that (same clock as `now`), else the render
   * loop's time. Everything downstream - detector timestamps, the filters'
   * dt, the pose's display time - runs on it, so velocities are measured over
   * the camera's real frame spacing rather than the render loop's jitter.
   * Kept strictly increasing: MediaPipe rejects a timestamp that goes back.
   */
  _frameTime(now) {
    let t = now
    if (this.stream.frameTimeSource === 'capture') {
      const capture = this.stream.frameTimeMs(now)
      // Sanity: a capture time from the future, or from long ago, is not on our clock.
      if (capture <= now && now - capture < 500) t = capture
    }
    if (t <= this._lastFrameTime) t = this._lastFrameTime + 0.01
    this._lastFrameTime = t
    return t
  }

  /** What a CaptureSession gets per recorded frame. Valid only during the call. */
  _captureSample(frameTime, observation) {
    return {
      now: frameTime,
      captureTimeMs: frameTime,
      video: this.stream.video,
      hands: this.perception.hands,
      armMask: this.perception.armMask,
      roiRgba: this.perception.arm.lastRoiRgba,
      observation,
      tracker: this.tracker,
      cam: this.cameraModel,
    }
  }

  _snapshotRawFrame(observation) {
    const f = this.rawFrame
    f.x.copy(observation.basis.x)
    f.y.copy(observation.basis.y)
    f.z.copy(observation.basis.z)
    f.origin.copy(observation.creasePoint)
    // Indices differ between the hand and pose sources, so follow the key the
    // observation reports rather than assuming hand numbering.
    const lm = observation.landmarks3D
    const k = observation.key
    f.palmWrist.copy(lm[k.wrist])
    f.palmIndex.copy(lm[k.index])
    f.palmPinky.copy(lm[k.pinky])
    f.thumb.copy(lm[k.thumb])
    f.rollDeg = THREE.MathUtils.radToDeg(observation.rollTheta)
    f.dorsalAgreement = observation.dorsalAgreement
    f.reprojectionPx = observation.reprojectionPx ?? 0
    f.forearmCorrectionDeg = observation.forearmCorrectionDeg ?? 0
    f.forearmFromSilhouette = !!observation.forearmFromSilhouette
    f.wristFlexDeg = observation.wristFlexDeg ?? 0
    f.wristDeviationDeg = observation.wristDeviationDeg ?? 0
    f.armMotion = observation.armMotion ?? 0
    f.silhouetteConfidence = observation.silhouetteConfidence ?? 0
    f.valid = true
  }

  _updateCalibration() {
    const g = this.tracker.geometry
    // Progress is whichever finishes first: a wrist turn (best - it measures
    // depth), or enough steady frames for the measure-once freeze.
    const steady = Math.min(1, g.goodFrames / FREEZE_FRAMES)
    this.calibration.coverage = Math.max(g.coverage, steady)
    this.calibration.locked = g.locked
    // Segment less once the wrist is measured. Replayed on the recordings, the
    // arm network every ~150 ms (with the per-frame refinement tracking the arm
    // in between) placed the arm as well as every frame did; only once it ran
    // less than ~3x a second did direction and width errors grow, and run once
    // then tracked by colour alone the arm drifted off (README). So: 12 Hz while
    // measuring, 6 Hz while tracking a measured wrist, back to 12 Hz while the
    // arm moves fast or its silhouette is weak.
    const fast = this.tracker.velocity.length() > 300 || this.tracker.omega.length() > 3
    const weak = this.rawFrame.valid && this.rawFrame.silhouetteConfidence < 0.2
    const segHz = !g.locked || fast || weak ? 12 : 6
    if (segHz !== this._segHz) {
      this._segHz = segHz
      this.perception.setBudget({ segHz })
    }
    if (g.locked && !this._wristSaved) this._wristSaved = this._rememberWrist()
    if (g.locked) {
      this.calibration.active = false
    } else if (this.calibration.active) {
      this.calibration.prompt =
        this.calibration.coverage < 0.25
          ? 'Hold your wrist in view — measuring it once'
          : this.calibration.coverage < 0.7
            ? 'Measuring your wrist — a slow turn helps'
            : 'Almost there'
    }
  }

  _wristRegion(twin) {
    if (!twin.valid) return null
    const p = this.cameraModel.project(twin.center, { x: 0, y: 0 })
    const radiusPx = twin.wristWidthMm / this.cameraModel.mmPerPxAt(Math.max(1, -twin.center.z))
    let u = p.x / this.cameraModel.width
    if (this.stream.mirrored) u = 1 - u // back into raw video coords
    return {
      x: clamp(u, 0, 1),
      y: clamp(p.y / this.cameraModel.height, 0, 1),
      r: clamp(radiusPx / this.cameraModel.width, 0.02, 0.4),
    }
  }

  _updateDiagnostics(now, dt, twin, presence) {
    this._fpsAccum.push(dt)
    if (this._fpsAccum.length > 40) this._fpsAccum.shift()
    const avg = this._fpsAccum.reduce((a, b) => a + b, 0) / this._fpsAccum.length

    const d = this.diagnostics
    d.fps = Math.round(1 / Math.max(1e-4, avg))
    d.state = this.tracker.state
    d.presence = presence
    d.handHz = Math.round(this.perception.stats.handHz)
    d.segHz = Math.round(this.perception.stats.segHz)
    d.handMs = +this.perception.stats.handMs.toFixed(1)
    d.segMs = +this.perception.stats.segMs.toFixed(1)
    // No size is reported until one is known: the solver's placeholder wrist
    // is not the user's.
    const known = this.tracker.geometry.sizeKnown
    d.wristKnown = known
    d.wristWidthMm = known ? +twin.wristWidthMm.toFixed(1) : 0
    d.wristDepthMm = known ? +twin.wristDepthMm.toFixed(1) : 0
    d.circumferenceMm = known ? +twin.circumferenceMm.toFixed(1) : 0
    d.shapeLocked = twin.shapeLocked
    d.wristRemembered = !!this.tracker.geometry.remembered
    d.sleeveLimitMm = twin.sleeveLimitMm
    d.rollDeg = Math.round(this.rawFrame.rollDeg)
    d.dorsalAgreement = +this.rawFrame.dorsalAgreement.toFixed(2)
    d.angularSpeedDeg = Math.round(THREE.MathUtils.radToDeg(this.tracker.omega.length()))
    d.reprojectionPx = +(this.rawFrame.reprojectionPx ?? 0).toFixed(2)
    d.forearmCorrectionDeg = +(this.rawFrame.forearmCorrectionDeg ?? 0).toFixed(1)
    d.forearmFromSilhouette = !!this.rawFrame.forearmFromSilhouette
    d.wristFlexDeg = Math.round(this.rawFrame.wristFlexDeg)
    d.wristDeviationDeg = Math.round(this.rawFrame.wristDeviationDeg)
    d.armMotion = +this.rawFrame.armMotion.toFixed(2)
    d.silhouetteConfidence = +this.rawFrame.silhouetteConfidence.toFixed(2)
    d.refineMs = +this.perception.stats.refineMs.toFixed(2)
    d.maskActive = !!this.perception.armMask
    d.cameraFps = Math.round(this.stream.cameraFps)
    d.jitterPx = +this.tracker.metrics.positionJitterPx.mean.toFixed(2)
    d.jitterDeg = +this.tracker.metrics.rotationJitterDeg.mean.toFixed(2)
    d.breathingPct = +this.tracker.metrics.scaleBreathingPct.mean.toFixed(2)
    const first = this.instances[0]
    d.visualFitConfidence = first ? first.fit.visualFitConfidence : 0
    d.physicalSizeConfidence = first ? first.fit.physicalSizeConfidence : 0
  }

  // ------------------------------------------------------------- plumbing

  _setupBackground() {
    this.videoTexture = new THREE.VideoTexture(this.stream.video)
    this.videoTexture.colorSpace = THREE.SRGBColorSpace
    this.videoTexture.minFilter = THREE.LinearFilter
    this.videoTexture.generateMipmaps = false

    this.bgScene = new THREE.Scene()
    this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1)
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      // toneMapped:false keeps the camera image exactly as the sensor gave it;
      // tone mapping is for the jewellery we add, not for the user's face.
      new THREE.MeshBasicMaterial({ map: this.videoTexture, toneMapped: false, depthTest: false, depthWrite: false }),
    )
    quad.frustumCulled = false
    this.bgScene.add(quad)
    this.bgQuad = quad
  }

  _syncResolution() {
    const vw = this.stream.width
    const vh = this.stream.height
    if (!vw || !vh) return
    const scale = Math.min(1, MAX_RENDER_WIDTH / vw)
    const w = Math.round(vw * scale)
    const h = Math.round(vh * scale)
    if (this._renderW === w && this._renderH === h && this._mirror === this.stream.mirrored) return

    this._renderW = w
    this._renderH = h
    this._mirror = this.stream.mirrored

    this.renderer.setSize(w, h, false)
    this.cameraModel.setResolution(w, h, this.stream.mirrored)
    this.cameraModel.applyToThreeCamera(this.camera)

    // Mirror the background texture rather than the scene, so lighting and
    // face-culling stay correct in a right-handed world.
    this.videoTexture.wrapS = THREE.RepeatWrapping
    this.videoTexture.repeat.x = this.stream.mirrored ? -1 : 1
    this.videoTexture.offset.x = this.stream.mirrored ? 1 : 0
    this.videoTexture.needsUpdate = true
  }

  dispose() {
    this.stop()
    this.capture?.dispose()
    this.perception.close()
    this.instances.forEach((i) => i.mesh.dispose())
    this.handDebug.dispose()
    this.hand2DDebug.dispose()
    this.segmentationDebug.dispose()
    this.wristFrameDebug.dispose()
    this.wallsDebug.dispose()
    this.occluder.dispose()
    this.lighting.dispose()
    this.videoTexture.dispose()
    this.bgQuad.geometry.dispose()
    this.bgQuad.material.dispose()
    this.renderer.dispose()
  }
}

/** The remembered wrist, or null when there is none or storage is unavailable. */
function readWristMemory() {
  try {
    const m = JSON.parse(localStorage.getItem(WRIST_MEMORY_KEY) ?? 'null')
    return m && m.palmRawMm > 40 && m.palmRawMm < 160 && m.widthPerPalm > 0.3 && m.depthPerPalm > 0.2 && m.sessions >= 1 ? m : null
  } catch {
    return null
  }
}
