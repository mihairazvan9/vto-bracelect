import * as THREE from 'three'
import { CaptureCoach } from './CaptureCoach.js'
import { SCENARIOS, getScenario } from './scenarios.js'
import { makeClipId, writeClip } from './ClipWriter.js'

const DEG = 180 / Math.PI

/** Framing must hold this long before the countdown starts, s. */
const SETTLE_S = 0.8
/** Countdown; its frames are recorded too (warm-up for the replay), s. */
const COUNTDOWN_S = 2.4
/**
 * A take needs at least this much recording after the countdown, s. At 3 s a
 * brisk swing or depth move finished in ~30 frames: too little to measure.
 */
const MIN_RECORD_S = 6
/**
 * Below this many recorded frames per second the clip no longer shows what
 * the tracker does at camera rate. Recorded anyway, but flagged.
 */
const MIN_GOOD_FPS = 24
/** Recording continues this long after the requirement is met, s. */
const TAIL_S = 0.6
/** Hand gone this long ends the take. Brief dropouts are kept: they are real. */
const MAX_HAND_GAP_S = 0.7
/** Framing broken this long ends the take. */
const MAX_BAD_FRAMING_S = 2
/** How long a failure message stays up before the take is retried, s. */
const RETRY_DELAY_S = 1.8
/** Frames the JPEGs are written at: the video, scaled to this width at most. */
const ANALYSIS_MAX_W = 960
const JPEG_QUALITY = 0.85

/** "Still" for the requirements: the tracker's own filtered motion. */
const STILL_MM_S = 50
const STILL_RAD_S = 0.45

const _q = new THREE.Quaternion()
const _qi = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _px0 = { x: 0, y: 0 }
const _px1 = { x: 0, y: 0 }

/**
 * Guided recording of test clips from the live camera.
 *
 * Attach to a running engine (engine.capture = session). The engine hands it
 * one sample per camera frame the hand detector ran on; the session coaches
 * the framing, runs a take through settle -> countdown -> record, checks that
 * the take actually contains the motion its scenario asks for, and writes it
 * to fixtures/ (ClipWriter). Frames are only kept from takes that complete -
 * a take that loses the hand or the framing is thrown away and retried.
 */
export class CaptureSession {
  constructor(engine) {
    this.engine = engine
    this.coach = new CaptureCoach()
    /** idle | framing | countdown | recording | saving | failed | done */
    this.status = 'idle'
    this.scenario = null
    /** Scenario id -> { state: 'done'|'skipped', clipId, frames, seconds, savedTo } */
    this.results = {}
    this.queue = []
    this.message = ''
    this.rateNote = ''
    this._frames = []
    this._sampleTimes = []
    this._perf = { recordedFps: [], cameraFps: [] }
    this._canvas = null
    this._budget = null
    this._lastEval = null
    this.view = this._emptyView()
  }

  // ------------------------------------------------------------------ control

  /** Record every scenario not done yet, in order (or just `ids`). */
  start(ids = null) {
    this.queue = (ids ?? SCENARIOS.filter((s) => !this.results[s.id]).map((s) => s.id)).slice()
    this._raiseBudget()
    this._next()
  }

  /** Record one scenario again. */
  redo(id) {
    delete this.results[id]
    this.queue = [id]
    this._raiseBudget()
    this._next()
  }

  skip() {
    if (!this.scenario) return
    this.results[this.scenario.id] = { state: 'skipped' }
    this._next()
  }

  stop() {
    this.queue = []
    this.scenario = null
    this._frames = []
    this.status = 'idle'
    this.message = ''
    this._restoreBudget()
    this._publish(null)
  }

  dispose() {
    this.stop()
    if (this.engine.capture === this) this.engine.capture = null
  }

  _next() {
    this._resetTake()
    const id = this.queue.shift()
    this.scenario = id ? getScenario(id) : null
    if (!this.scenario) {
      this.status = 'done'
      this.message = 'All takes recorded. Run `npm run bench` to measure them.'
      this._restoreBudget()
      this._publish(null)
      return
    }
    this._enter('framing')
  }

  _enter(status) {
    this.status = status
    this._since = null
    if (status === 'framing') {
      this._resetTake()
      this._okSince = null
      this.message = ''
      const depthTake = this.scenario.need.kind === 'depth'
      this.coach.palmMax = depthTake ? 0.55 : 0.38
      this.coach.palmMin = depthTake ? 0.1 : 0.14
    }
    this._publish(this._lastEval)
  }

  /**
   * Every camera frame should reach the hand detector while recording, or the
   * clip has gaps the live app would not. Restored when capture ends.
   */
  _raiseBudget() {
    const p = this.engine.perception
    if (this._budget) return
    this._budget = { hand: p.handIntervalMs, frame: p.frameBudgetMs }
    p.setBudget({ handHz: 60 })
    p.frameBudgetMs = Math.max(p.frameBudgetMs, 34)
  }

  _restoreBudget() {
    if (!this._budget) return
    const p = this.engine.perception
    p.handIntervalMs = this._budget.hand
    p.frameBudgetMs = this._budget.frame
    this._budget = null
  }

  // ------------------------------------------------------------ per frame

  /** @param {object} sample VTOEngine._captureSample */
  onFrame(sample) {
    if (!this.scenario || this.status === 'saving' || this.status === 'done' || this.status === 'idle') return
    const t = sample.captureTimeMs / 1000
    const judged = this.coach.evaluate(sample)
    this._rateCheck(judged, sample.captureTimeMs)
    this._lastEval = judged
    if (this._since === null) this._since = t

    if (this.status === 'failed') {
      if (t - this._since >= RETRY_DELAY_S) this._enter('framing')
      this._publish(judged)
      return
    }

    if (this.status === 'framing') {
      this._okSince = judged.ok ? (this._okSince ?? t) : null
      if (this._okSince !== null && t - this._okSince >= SETTLE_S) {
        this._enter('countdown')
        this._since = t
        this._record(sample, judged)
      }
      this._publish(judged)
      return
    }

    // countdown or recording: every frame goes into the take.
    this._record(sample, judged)
    this._track(judged, t)

    if (this._handGapS > MAX_HAND_GAP_S) return this._fail('Lost your hand - let\'s go again')
    if (this._badFramingS > MAX_BAD_FRAMING_S) return this._fail(judged.instruction ?? 'Framing lost - let\'s go again')

    if (this.status === 'countdown') {
      if (t - this._since >= COUNTDOWN_S) {
        this.status = 'recording'
        this._recordStart = t
        this._progress = this._newProgress()
      }
      this._publish(judged)
      return
    }

    // recording
    this._measure(sample, judged, t)
    const elapsed = t - this._recordStart
    const met = this._progress.value >= 1
    if (met && this._metAt === undefined) this._metAt = t
    if (met && elapsed >= MIN_RECORD_S && t - this._metAt >= TAIL_S) {
      this._finish()
      return
    }
    if (!met && elapsed >= this.scenario.maxS) {
      return this._fail(this._progress.shortfall ?? 'Not enough of the movement - let\'s go again')
    }
    this._publish(judged)
  }

  /**
   * How many frames per second actually reach the recording, and if too few,
   * whose fault it is: a camera that slowed itself down (dim light) or a
   * computer that cannot process every frame. Adds a soft check; never blocks.
   */
  _rateCheck(judged, tMs) {
    const times = this._sampleTimes
    times.push(tMs)
    while (times.length > 16) times.shift()
    this.rateNote = ''
    if (times.length < 8) return
    const fps = ((times.length - 1) * 1000) / Math.max(1, times[times.length - 1] - times[0])
    const cameraFps = this.engine.stream.cameraFps
    this._perf.recordedFps.push(fps)
    if (cameraFps > 0) this._perf.cameraFps.push(cameraFps)
    const ok = fps >= MIN_GOOD_FPS
    judged.checks.push({ id: 'rate', label: `${Math.round(fps)} fps`, ok, soft: true })
    if (ok) return
    this.rateNote = cameraFps > 0 && cameraFps < MIN_GOOD_FPS
      ? `The camera is sending only ${Math.round(cameraFps)} fps - usually low light. More light brings it back to 30.`
      : `Only ${Math.round(fps)} of ${Math.round(cameraFps) || '?'} camera fps are processed - the computer is busy. Close other tabs and apps.`
  }

  _track(judged, t) {
    const dt = this._lastT === undefined ? 0 : Math.min(0.2, Math.max(0, t - this._lastT))
    this._lastT = t
    this._handGapS = judged.hand ? 0 : (this._handGapS ?? 0) + dt
    this._badFramingS = judged.ok || !judged.hand ? 0 : (this._badFramingS ?? 0) + dt
    this._dt = dt
  }

  _fail(message) {
    this._resetTake()
    this.status = 'failed'
    this.message = message
    this._since = null
    this._publish(this._lastEval)
  }

  /** Forget everything about the take in progress. */
  _resetTake() {
    this._frames = []
    this._perf = { recordedFps: [], cameraFps: [] }
    this._sampleTimes.length = 0
    this._lastT = undefined
    this._handGapS = 0
    this._badFramingS = 0
    this._metAt = undefined
    this._progress = null
  }

  // ------------------------------------------------------------- recording

  _record(sample, judged) {
    const video = sample.video
    const vw = video.videoWidth
    const vh = video.videoHeight
    const scale = Math.min(1, ANALYSIS_MAX_W / vw)
    const aw = Math.round(vw * scale)
    const ah = Math.round(vh * scale)
    if (!this._canvas || this._canvas.width !== aw || this._canvas.height !== ah) {
      this._canvas = new OffscreenCanvas(aw, ah)
      this._ctx = this._canvas.getContext('2d')
    }
    // The RAW frame (no mirroring, no jewellery): exactly what MediaPipe saw.
    this._ctx.drawImage(video, 0, 0, aw, ah)
    const jpeg = this._canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })

    const hands = sample.hands
    const lm = hands?.landmarks?.[0]
    const wlm = hands?.worldLandmarks?.[0]
    const hd = hands?.handedness?.[0]?.[0] ?? hands?.handednesses?.[0]?.[0]
    const mask = sample.armMask
    const prev = this._frames[this._frames.length - 1]
    const tMs = sample.captureTimeMs
    this._frames.push({
      tMs,
      dtMs: prev ? clampDt(tMs - prev.tMs) : 33,
      jpeg,
      landmarks: lm ? lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })) : null,
      worldLandmarks: wlm ? wlm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })) : null,
      handedness: hd ? { label: hd.categoryName, score: hd.score } : null,
      armMask: mask ? { data: mask.data.slice(), width: mask.width, height: mask.height, roi: { ...mask.roi } } : null,
      framing: judged.ok,
      hand: judged.hand,
      phase: this.status,
    })
    this._videoSize = { vw, vh, aw, ah }
  }

  async _finish() {
    const scenario = this.scenario
    const frames = this._frames
    const result = this._progress.summary()
    const perf = this._perfSummary()
    this._resetTake()
    this.status = 'saving'
    this.message = 'Saving...'
    this._publish(this._lastEval)

    const cam = this.engine.cameraModel
    const clipId = makeClipId(scenario.id)
    const first = frames[0].tMs
    const take = {
      clipId,
      frames,
      videoWidth: this._videoSize.vw,
      videoHeight: this._videoSize.vh,
      analysisWidth: this._videoSize.aw,
      analysisHeight: this._videoSize.ah,
      meta: {
        version: 1,
        clipId,
        scenario: scenario.id,
        title: scenario.title,
        instruction: scenario.instruction,
        requirement: scenario.need,
        result,
        recordedAt: new Date().toISOString(),
        fovYDeg: cam.fovYDeg,
        fovSource: cam.fovSource,
        mirroredPreview: cam.mirrored,
        timeSource: this.engine.stream.frameTimeSource,
        /** Conditions of the take: a 15 fps clip measures something else than a 30 fps one. */
        performance: perf,
        frames: frames.length,
        durationS: (frames[frames.length - 1].tMs - first) / 1000,
        /** Index of the first frame after the countdown: before it is warm-up. */
        recordStartFrame: Math.max(0, frames.findIndex((f) => f.phase === 'recording')),
        frameTimesMs: frames.map((f) => +(f.tMs - first).toFixed(2)),
        framingOk: frames.map((f) => (f.framing ? 1 : 0)),
        handFound: frames.map((f) => (f.hand ? 1 : 0)),
      },
    }
    try {
      const saved = await writeClip(take)
      this.results[scenario.id] = {
        state: 'done',
        clipId,
        frames: frames.length,
        seconds: +take.meta.durationS.toFixed(1),
        savedTo: saved.savedTo,
        downloaded: saved.downloaded,
        mb: +(saved.bytes / 1e6).toFixed(1),
      }
      this.message = saved.downloaded
        ? `Downloaded ${clipId} - move the files into fixtures/${clipId}/ (drop the "${clipId}__" prefix)`
        : `Saved ${saved.savedTo}`
    } catch (err) {
      console.error('[capture] save failed', err)
      this.message = `Could not save: ${err.message ?? err}`
      this.results[scenario.id] = { state: 'error', message: this.message }
    }
    if (this.status === 'saving') this._next()
  }

  _perfSummary() {
    const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : null)
    const d = this.engine.diagnostics
    return {
      recordedFps: mean(this._perf.recordedFps),
      cameraFps: mean(this._perf.cameraFps),
      track: this.engine.stream.trackSettings,
      renderFps: d.fps,
      handMs: d.handMs,
      segHz: d.segHz,
      segMs: d.segMs,
      refineMs: d.refineMs,
    }
  }

  // ----------------------------------------------------------- requirements

  _newProgress() {
    const need = this.scenario.need
    const p = {
      value: 0,
      text: '',
      shortfall: null,
      hint: null,
      summary: () => ({ value: +p.value.toFixed(2), text: p.text }),
      // running state
      still: 0,
      twist: 0, twistMin: 0, twistMax: 0, reversed: false, lastQ: null,
      bendRef: null, bendMax: 0, bendReturned: false,
      swingRef: null, swingMin: 0, swingMax: 0,
      depthMin: Infinity, depthMax: 0,
      shaken: false, peak: 0, hold: 0,
      side: 0, sleeve: 0, time: 0,
    }
    p.need = need
    return p
  }

  _measure(sample, judged, t) {
    const p = this._progress
    const need = p.need
    const obs = sample.observation
    const tr = sample.tracker
    const dt = this._dt
    const usable = judged.hand && !!obs
    const speed = tr.velocity.length()
    const spin = tr.omega.length()
    const still = speed < STILL_MM_S && spin < STILL_RAD_S
    p.hint = null

    switch (need.kind) {
      case 'still': {
        if (usable && still) p.still += dt
        else if (usable) p.hint = 'Hold still'
        p.value = p.still / need.seconds
        p.text = `Still for ${p.still.toFixed(1)} of ${need.seconds} s`
        p.shortfall = 'Too much movement - hold your arm still'
        break
      }
      case 'twist': {
        // Roll about the forearm, accumulated frame to frame (unwrapped).
        if (usable) {
          if (p.lastQ) {
            _qi.copy(p.lastQ).invert()
            _q.copy(_qi).multiply(tr.quaternion) // delta in the arm's own frame
            if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w)
            const step = 2 * Math.atan2(_q.y, _q.w) * DEG
            if (Math.abs(step) < 45) p.twist += step
          }
          p.lastQ = (p.lastQ ?? new THREE.Quaternion()).copy(tr.quaternion)
          p.twistMin = Math.min(p.twistMin, p.twist)
          p.twistMax = Math.max(p.twistMax, p.twist)
          const range = p.twistMax - p.twistMin
          // A change of direction: back 25 deg from an extreme after a real turn.
          if (range > 40 && (p.twistMax - p.twist > 25 || p.twist - p.twistMin > 25) &&
            p.twist > p.twistMin + 1 && p.twist < p.twistMax - 1) p.reversed = true
        }
        const range = p.twistMax - p.twistMin
        p.value = Math.min(1, range / need.degrees) * (p.reversed ? 1 : 0.85)
        p.text = `Turned ${Math.round(range)} of ${need.degrees} deg${p.reversed ? ', and back' : ''}`
        p.hint = range < need.degrees ? 'Keep turning - further' : !p.reversed ? 'Now turn back' : null
        p.shortfall = range < need.degrees ? 'Turn further - palm fully up, then down' : 'Turn back the other way too'
        break
      }
      case 'bend': {
        if (usable) {
          const axis = obs.handBasis.y
          if (!p.bendRef) p.bendRef = axis.clone()
          const a = p.bendRef.angleTo(axis) * DEG
          p.bendMax = Math.max(p.bendMax, a)
          if (p.bendMax >= need.degrees && a < need.degrees * 0.4) p.bendReturned = true
          if (speed > 160) p.hint = 'Keep your forearm still - bend only the wrist'
        }
        p.value = Math.min(1, p.bendMax / need.degrees) * (p.bendReturned ? 1 : 0.85)
        p.text = `Bent ${Math.round(p.bendMax)} of ${need.degrees} deg${p.bendReturned ? ', and back' : ''}`
        if (!p.hint) p.hint = p.bendMax < need.degrees ? 'Bend further' : !p.bendReturned ? 'Now back to straight' : null
        p.shortfall = 'Bend the wrist further up and down'
        break
      }
      case 'swing': {
        if (usable) {
          const cam = sample.cam
          cam.project(obs.creasePoint, _px0)
          cam.project(_v.copy(obs.creasePoint).addScaledVector(obs.basis.y, 80), _px1)
          const ang = Math.atan2(_px1.y - _px0.y, _px1.x - _px0.x) * DEG
          if (p.swingRef === null) p.swingRef = ang
          const rel = wrapDeg(ang - p.swingRef)
          p.swingMin = Math.min(p.swingMin, rel)
          p.swingMax = Math.max(p.swingMax, rel)
        }
        const range = p.swingMax - p.swingMin
        p.value = Math.min(1, range / need.degrees)
        p.text = `Swept ${Math.round(range)} of ${need.degrees} deg`
        p.hint = range < need.degrees ? 'Wider - swing further both ways' : null
        p.shortfall = 'Swing the forearm wider'
        break
      }
      case 'depth': {
        if (usable) {
          const d = -tr.position.z
          if (d > 50) {
            p.depthMin = Math.min(p.depthMin, d)
            p.depthMax = Math.max(p.depthMax, d)
          }
        }
        const ratio = p.depthMin < Infinity ? p.depthMax / p.depthMin : 1
        p.value = Math.min(1, Math.log(ratio) / Math.log(need.ratio))
        p.text = `Distance range ${ratio.toFixed(2)}x of ${need.ratio}x`
        p.hint = p.value < 1 ? 'Closer... and further' : null
        p.shortfall = 'Move closer and further - a bigger change'
        break
      }
      case 'flick': {
        // A shake is a back-and-forth: fast motion that reverses at least
        // twice. One fast frame is not one - the tracker's own start-up jump
        // once counted as the shake, and the clip ended mid-shake.
        const settled = tr.presence >= 0.99 && t - this._recordStart > 0.5
        if (usable && settled) {
          p.peak = Math.max(p.peak, speed)
          if (!p.shaken && speed >= need.speedMmS * 0.5) {
            if (p.lastDir && tr.velocity.dot(p.lastDir) < 0) p.reversals = (p.reversals ?? 0) + 1
            p.lastDir = (p.lastDir ?? new THREE.Vector3()).copy(tr.velocity)
          }
          if (!p.shaken && p.peak >= need.speedMmS && (p.reversals ?? 0) >= 2) p.shaken = true
          if (p.shaken) p.hold = still ? p.hold + dt : 0
        }
        p.value = p.shaken ? 0.35 + 0.65 * Math.min(1, p.hold / need.holdS) : Math.min(0.3, (p.peak / need.speedMmS) * 0.3)
        p.text = p.shaken ? `Holding still ${p.hold.toFixed(1)} of ${need.holdS} s` : `Shake: ${p.reversals ?? 0} of 2 back-and-forths`
        p.hint = p.shaken ? (still ? 'Hold perfectly still' : 'Now hold still') : 'Shake your wrist quickly'
        p.shortfall = p.shaken ? 'Hold still longer after the shake' : 'Shake faster'
        break
      }
      case 'sideOn': {
        if (usable && obs.rollTheta * DEG >= need.minRollDeg) p.side += dt
        else if (usable) p.hint = 'Turn further - thumb toward the camera'
        p.value = p.side / need.seconds
        p.text = `Side-on for ${p.side.toFixed(1)} of ${need.seconds} s`
        p.shortfall = 'Turn the hand fully sideways and hold'
        break
      }
      case 'sleeve': {
        if (usable && Number.isFinite(obs.sleeveLimitMm) && obs.sleeveLimitMm < 90) p.sleeve += dt
        else if (usable) p.hint = 'Sleeve not seen yet - pull it further down the forearm'
        p.value = p.sleeve / need.seconds
        p.text = `Sleeve seen for ${p.sleeve.toFixed(1)} of ${need.seconds} s`
        p.shortfall = 'The sleeve was not detected - pull it closer to the wrist'
        break
      }
      default: {
        if (usable && judged.ok) p.time += dt
        p.value = p.time / need.seconds
        p.text = `${p.time.toFixed(1)} of ${need.seconds} s`
        p.shortfall = 'Keep the arm in view longer'
      }
    }
    p.value = Math.max(0, Math.min(1, p.value))
  }

  // ------------------------------------------------------------------- view

  _emptyView() {
    return {
      active: false, status: 'idle', scenarioId: null, title: '', instruction: '', why: '',
      prompt: null, arrow: null, checks: [], progress: 0, progressText: '', countdown: 0,
      frames: 0, message: '', rateNote: '', results: {},
    }
  }

  /** A plain snapshot for the UI (polled; never reactive-bound to the engine loop). */
  _publish(judged) {
    const v = this.view
    const s = this.scenario
    v.active = this.status !== 'idle'
    v.status = this.status
    v.scenarioId = s?.id ?? null
    v.title = s?.title ?? ''
    v.instruction = s?.instruction ?? ''
    v.why = s?.why ?? ''
    v.checks = judged?.checks ?? []
    v.frames = this._frames.length
    v.message = this.message
    v.rateNote = this.rateNote
    v.results = { ...this.results }
    v.progress = this.status === 'recording' ? this._progress?.value ?? 0 : 0
    v.progressText = this.status === 'recording' ? this._progress?.text ?? '' : ''
    v.countdown = this.status === 'countdown' && this._since !== null && this._lastT !== undefined
      ? Math.max(1, Math.ceil(COUNTDOWN_S - (this._lastT - this._since)))
      : 0

    // One thing to do: a framing fix beats the motion prompt, which beats a nudge.
    let prompt = null
    let arrow = null
    if (this.status === 'framing') {
      prompt = judged?.ok ? 'Hold it there...' : judged?.instruction ?? 'Show your hand and forearm'
      arrow = judged?.ok ? null : judged?.arrow ?? null
    } else if (this.status === 'countdown' || this.status === 'recording') {
      if (judged && !judged.ok && judged.instruction) {
        prompt = judged.instruction
        arrow = judged.arrow
      } else if (this.status === 'recording') {
        prompt = this._progress?.hint ?? null
      }
    }
    v.prompt = prompt
    v.arrow = arrow
  }

  snapshot() {
    return this.view
  }
}

function clampDt(ms) {
  return Math.max(1, Math.min(65535, Math.round(ms)))
}

function wrapDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180
}
