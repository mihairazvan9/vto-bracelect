import GUI from 'lil-gui'
import { SCENARIOS } from '../vto/capture/scenarios.js'

const CATEGORY_LABEL = {
  rigid_bangle: 'bangle',
  open_cuff: 'cuff',
  tennis_bracelet: 'tennis',
  chain: 'chain',
  charm_bracelet: 'charm',
}

/** Webcams halve their frame rate in dim light; say so once it has lasted, and let go with margin. */
const LOW_FPS = 20
const RECOVERED_FPS = 24
const LOW_FPS_AFTER_MS = 2000

/**
 * The whole interface, in one lil-gui panel over the full-screen camera:
 * camera, guidance, bracelets, fit, settings, debug views, engine numbers,
 * frame time and (dev) the clip recorder.
 *
 * Imperative on purpose: lil-gui owns its DOM. `refresh()` pulls the current
 * state (called on a timer by the app); what changes shape - fit verdicts,
 * frame-time stages, recorder scenarios - is rebuilt only when it changes.
 *
 * @param {object} host what the app lets the panel read and do:
 *   catalog, options, getEngine(), status(), error(), start(), flip(),
 *   selected(), toggle(id), manualWrist(), setManualWrist(mm|null),
 *   setOption(key, value), fits(),
 *   capture: null | { isOpen(), open(), close(), view(), start(), redo(id), skip(), stop() }
 */
export class ControlGui {
  constructor(host) {
    this.host = host
    this.gui = new GUI({ title: 'MakeMeTryOn' })
    this.gui.domElement.classList.add('control-gui')
    /** Read-only values shown in the panel (strings, updated by refresh). */
    this.view = {}
    this._lowSince = null
    this._lowLight = false

    this._buildCamera()
    this._buildGuidance()
    this._buildBracelets()
    this._buildFit()
    this._buildSettings()
    this._buildDebug()
    this._buildEngine()
    this._buildProfile()
    if (host.capture) this._buildCapture()
    // Closed at start, so it covers nothing but its title bar; a click on the
    // title opens it.
    this.gui.close()
    this.refresh()
  }

  destroy() {
    this.gui.destroy()
  }

  // ------------------------------------------------------------------ build

  /** A read-only line: label and a value refresh() keeps current. */
  _show(folder, key, label) {
    this.view[key] = ''
    const c = folder.add(this.view, key).name(label).disable()
    c.domElement.classList.add('control-gui__value')
    return c
  }

  _buildCamera() {
    const f = this.gui.addFolder('Camera')
    this._show(f, 'status', 'Status')
    this.actions = {
      start: () => this.host.start(),
      flip: () => this.host.flip(),
      recalibrate: () => this.host.getEngine()?.recalibrate(),
      skipCalibration: () => this.host.getEngine()?.skipCalibration(),
      toggleCapture: () => (this.host.capture.isOpen() ? this.host.capture.close() : this.host.capture.open()),
    }
    this._startButton = f.add(this.actions, 'start').name('Start camera')
    this._flipButton = f.add(this.actions, 'flip').name('Flip camera')
  }

  _buildGuidance() {
    const f = this.gui.addFolder('Guidance')
    this._show(f, 'hint', 'Now')
    this._show(f, 'measuring', 'Measuring')
    this._skipButton = f.add(this.actions, 'skipCalibration').name('Skip measuring')
  }

  _buildBracelets() {
    const f = this.gui.addFolder('Bracelets (stack order)')
    this.pieces = {}
    this._pieceControls = this.host.catalog.map((item) => {
      this.pieces[item.id] = this.host.selected().includes(item.id)
      const c = f.add(this.pieces, item.id).onChange(() => this.host.toggle(item.id))
      c._item = item
      return c
    })
  }

  _buildFit() {
    const f = this.gui.addFolder('Fit')
    this._show(f, 'wrist', 'Wrist')
    this._show(f, 'wristShape', 'Shape')
    this._show(f, 'wristSource', 'Source')
    this._show(f, 'visualFit', 'Visual fit')
    this._show(f, 'physicalSize', 'Physical size')
    this.manual = { mm: this.host.manualWrist() ?? 0 }
    f.add(this.manual, 'mm', 0, 240, 1)
      .name('Your wrist, mm (0 = measure)')
      .onFinishChange((mm) => this.host.setManualWrist(mm >= 100 ? mm : null))
    f.add(this.actions, 'recalibrate').name('Re-measure')
    this._fitFolder = f.addFolder('Pieces')
    this._fitKey = ''
  }

  _buildSettings() {
    const f = this.gui.addFolder('Settings')
    const o = this.host.options
    const bind = (key, label) => f.add(o, key).name(label).onChange((v) => this.host.setOption(key, v))
    if (o.frameLock === undefined) o.frameLock = true
    bind('frameLock', 'Lock drawing to camera')
    bind('preferFrameRate', 'Keep fps in dim light (darker)')
    this._show(f, 'exposure', 'Camera exposure')
    bind('rawPose', 'Raw pose (no smoothing)')
    bind('lightEstimation', 'Camera light estimation')
    f.add(o, 'physicsLiveliness', 0, 1, 0.05)
      .name('Physics: calm ↔ lively')
      .onChange((v) => this.host.setOption('physicsLiveliness', v))
  }

  _buildDebug() {
    const f = this.gui.addFolder('Debug views')
    const o = this.host.options
    const bind = (key, label) => f.add(o, key).name(label).onChange((v) => this.host.setOption(key, v))
    bind('showOccluder', 'Wrist occluder')
    bind('showSegmentation', 'Segmentation mask')
    bind('showWristFrame', 'Wrist frame (rotation)')
    bind('showWalls', 'Invisible walls')
    f.add(o, 'landmarkView', { Off: 'off', '2D raw': '2d', '3D solved': '3d', Both: 'both' })
      .name('Hand landmarks')
      .onChange((v) => this.host.setOption('landmarkView', v))
    const r = f.addFolder('Rotation solve')
    this._show(r, 'roll', 'Roll vs camera')
    this._show(r, 'dorsal', 'Dorsal agreement')
    this._show(r, 'forearmFrom', 'Forearm axis from')
    this._show(r, 'joint', 'Wrist flex / dev.')
    this._show(r, 'motion', 'Hand motion read as')
    this._show(r, 'reprojection', 'Reprojection')
    this._show(r, 'angular', 'Angular speed')
    this._show(r, 'sleeve', 'Sleeve')
    r.close()
    f.close()
  }

  _buildEngine() {
    const f = this.gui.addFolder('Engine')
    this._show(f, 'fps', 'Drawn / camera fps')
    this._show(f, 'cameraMode', 'Camera mode')
    this._show(f, 'frame', 'Frame · latency')
    this._show(f, 'tracking', 'Tracking')
    this._show(f, 'hands', 'Hands')
    this._show(f, 'segmentation', 'Segmentation')
    this._show(f, 'jitterPx', 'Position jitter (≤ 2 px)')
    this._show(f, 'jitterDeg', 'Rotation jitter (≤ 1°)')
    this._show(f, 'breathing', 'Scale breathing (≤ 1 %)')
    f.close()
  }

  _buildProfile() {
    this._profileFolder = this.gui.addFolder('Frame time, ms (mean · p95)')
    this._profileRows = new Map()
    this._profileFolder.close()
  }

  _buildCapture() {
    const f = this.gui.addFolder('Record test clips (dev)')
    this._captureToggle = f.add(this.actions, 'toggleCapture').name('Open recorder')
    this._show(f, 'captureStatus', 'Recorder')
    this.captureActions = {
      start: () => this.host.capture.start(),
      skip: () => this.host.capture.skip(),
      stop: () => this.host.capture.stop(),
    }
    this._captureControls = [
      f.add(this.captureActions, 'start').name('Record (remaining)'),
      f.add(this.captureActions, 'skip').name('Skip this one'),
      f.add(this.captureActions, 'stop').name('Stop'),
    ]
    this._scenarioFolder = f.addFolder('Scenarios')
    this._scenarioKey = ''
    f.close()
  }

  // ---------------------------------------------------------------- refresh

  refresh() {
    const h = this.host
    const v = this.view
    const status = h.status()
    const running = status === 'running'
    const e = h.getEngine()
    const d = e?.diagnostics ?? {}

    // --- Camera --------------------------------------------------------------
    v.status = status === 'error' ? `error: ${h.error()}` : status === 'starting' ? 'starting…' : running ? 'running' : 'off - press Start camera'
    this._startButton.show(!running)
    // The panel starts closed; a camera that failed must not stay hidden in it.
    if (status === 'error' && this._lastStatus !== 'error') this.gui.open()
    this._lastStatus = status
    this._startButton.enable(status !== 'starting')
    this._flipButton.show(running)

    // --- Guidance (what used to be drawn over the video) ---------------------
    const fps = d.cameraFps ?? 0
    const now = performance.now()
    if (fps > 0 && fps < LOW_FPS) {
      this._lowSince ??= now
      if (now - this._lowSince > LOW_FPS_AFTER_MS) this._lowLight = true
    } else {
      this._lowSince = null
      if (fps >= RECOVERED_FPS) this._lowLight = false
    }
    v.hint = !running ? '—'
      : d.state === 'LOST' ? 'Show your wrist to the camera'
        : d.state === 'DEGRADED' ? 'Tracking is weak - more light or slower movement'
          : this._lowLight ? 'More light will make this smoother'
            : 'Tracking'
    const cal = e?.calibration
    const measuring = running && cal?.active && d.state !== 'LOST'
    v.measuring = measuring ? `${Math.round((cal.coverage ?? 0) * 100)} % - ${cal.prompt}` : cal?.locked ? 'done' : '—'
    this._skipButton.show(!!measuring)

    // --- Bracelets -----------------------------------------------------------
    const selected = h.selected()
    for (const c of this._pieceControls) {
      const item = c._item
      const i = selected.indexOf(item.id)
      this.pieces[item.id] = i >= 0
      c.name(`${i >= 0 ? `${i + 1}. ` : ''}${item.name} - ${CATEGORY_LABEL[item.category] ?? item.category}, ${item.innerCircumferenceMm} mm`)
    }

    // --- Fit -----------------------------------------------------------------
    const known = !!d.wristKnown
    v.wrist = known ? `${Math.round(d.circumferenceMm)} mm` : '—'
    v.wristShape = known ? `${d.wristWidthMm} × ${d.wristDepthMm} mm` : 'not measured yet'
    v.wristSource = h.manualWrist() ? 'your measurement' : d.wristRemembered ? 'remembered' : d.shapeLocked ? 'shape locked' : 'measuring…'
    v.visualFit = `${Math.round((d.visualFitConfidence ?? 0) * 100)} %`
    v.physicalSize = `${Math.round((d.physicalSizeConfidence ?? 0) * 100)} %`
    this._refreshFits(h.fits())

    // --- Settings / debug ----------------------------------------------------
    v.exposure = { auto: 'automatic', capped: 'capped at one frame', unsupported: 'camera does not allow it' }[d.cameraExposure] ?? '—'
    v.roll = `${d.rollDeg ?? 0}° (0 = back of hand)`
    v.dorsal = String(d.dorsalAgreement ?? 0)
    v.forearmFrom = d.forearmFromSilhouette ? `arm silhouette (${d.silhouetteConfidence})` : 'joint model'
    v.joint = `${d.wristFlexDeg ?? 0}° / ${d.wristDeviationDeg ?? 0}°`
    v.motion = `${(d.armMotion ?? 0) > 0.5 ? 'arm moving' : 'wrist bending'} (${d.armMotion ?? 0})`
    v.reprojection = `${d.reprojectionPx ?? 0} px`
    v.angular = `${d.angularSpeedDeg ?? 0}°/s`
    v.sleeve = d.sleeveLimitMm !== undefined && d.sleeveLimitMm !== Infinity ? `${Math.round(d.sleeveLimitMm)} mm up the forearm` : 'none'

    // --- Engine --------------------------------------------------------------
    v.fps = `${d.fps ?? 0} · ${d.cameraFps || '?'}`
    v.cameraMode = d.cameraMode || '—'
    v.frame = `${d.frameMs ?? 0} ms · ${d.latencyMs ? `${d.latencyMs} ms` : '?'}`
    v.tracking = d.state ?? '—'
    v.hands = `${d.handHz ?? 0} Hz · ${d.handMs ?? 0} ms`
    v.segmentation = `${d.segHz ?? 0} Hz · ${d.segMs ?? 0} ms`
    v.jitterPx = `${d.jitterPx ?? 0} px`
    v.jitterDeg = `${d.jitterDeg ?? 0}°`
    v.breathing = `${d.breathingPct ?? 0} %`
    this._refreshProfile(d.profile ?? {})

    // --- Recorder ------------------------------------------------------------
    if (h.capture) this._refreshCapture()

    for (const c of this.gui.controllersRecursive()) c.updateDisplay()
  }

  /** One line per selected piece: its verdict, the message on hover. Rebuilt when they change. */
  _refreshFits(fits) {
    const key = fits.map((f) => `${f.name}:${f.verdict}:${f.message}`).join('|')
    if (key === this._fitKey) return
    this._fitKey = key
    for (const c of [...this._fitFolder.controllers]) c.destroy()
    this.fitView = {}
    for (const [i, fit] of fits.entries()) {
      this.fitView[i] = `${fit.verdict.replace(/_/g, ' ')} - ${fit.message}`
      const c = this._fitFolder.add(this.fitView, String(i)).name(fit.name).disable()
      c.domElement.title = fit.message
      c.domElement.classList.add('control-gui__value')
    }
  }

  _refreshProfile(profile) {
    for (const [stage, s] of Object.entries(profile)) {
      let row = this._profileRows.get(stage)
      if (!row) {
        const obj = { value: '' }
        const c = this._profileFolder.add(obj, 'value').name(stage).disable()
        c.domElement.classList.add('control-gui__value')
        row = { obj, c }
        this._profileRows.set(stage, row)
      }
      row.obj.value = `${s.mean} · ${s.p95}`
    }
  }

  _refreshCapture() {
    const cap = this.host.capture
    const open = cap.isOpen()
    this._captureToggle.name(open ? 'Close recorder (back to try-on)' : 'Open recorder')
    const view = open ? cap.view() : null
    const idle = !view?.active || view.status === 'done'
    this.view.captureStatus = !open ? 'closed' : view.status === 'done' ? view.message || 'done' : view.active ? `${view.status}: ${view.title ?? ''}` : 'ready'
    this._captureControls[0].show(open && idle)
    this._captureControls[1].show(open && !idle)
    this._captureControls[2].show(open && !idle)
    this._captureControls[1].enable(view?.status !== 'saving')
    this._captureControls[2].enable(view?.status !== 'saving')

    const results = view?.results ?? {}
    const key = open ? `${idle}|${SCENARIOS.map((s) => results[s.id]?.state ?? '-').join(',')}` : 'closed'
    if (key === this._scenarioKey) return
    this._scenarioKey = key
    for (const c of [...this._scenarioFolder.controllers]) c.destroy()
    this._scenarioFolder.show(open)
    if (!open) return
    this.scenarioActions = {}
    for (const s of SCENARIOS) {
      const r = results[s.id]
      const mark = { done: '✓', skipped: '–', error: '!' }[r?.state] ?? '○'
      const detail = r?.state === 'done' ? ` ${r.seconds} s, ${r.frames} frames` : r?.state === 'error' ? ` ${r.message}` : ''
      this.scenarioActions[s.id] = () => cap.redo(s.id)
      const c = this._scenarioFolder.add(this.scenarioActions, s.id).name(`${mark} ${s.title}${s.optional ? ' (optional)' : ''}${detail} - ${r ? 'redo' : 'record'}`)
      c.domElement.title = s.why ?? ''
      c.enable(idle)
    }
  }
}
