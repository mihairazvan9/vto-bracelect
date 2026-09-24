<script setup>
import { defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { VTOEngine } from './vto/VTOEngine.js'
import { CATALOG, getBracelet } from './vto/assets/catalog.js'
import { DEFAULT_LIVELINESS } from './vto/physics/tuning.js'
import VtoStage from './components/VtoStage.vue'
import { ControlGui } from './gui/ControlGui.js'
/**
 * The test-clip recorder is a development tool: it writes into fixtures/
 * through the dev server. Loaded lazily behind DEV, so a production build
 * drops it entirely.
 */
const DEV = import.meta.env.DEV
const CaptureOverlay = DEV ? defineAsyncComponent(() => import('./components/CaptureOverlay.vue')) : null

/**
 * The screen is the camera, full width and height; everything else - camera,
 * bracelets, fit, settings, debug views, engine numbers - lives in one lil-gui
 * panel over it (gui/ControlGui.js). The only other thing ever drawn over the
 * video is the clip recorder's coaching, while it records.
 */
const stage = ref(null)
const engine = shallowRef(null)

const status = ref('idle') // idle | starting | running | error
const errorMessage = ref('')
/** The piece worn at start: the Heirloom Charm Bracelet, 188 mm. */
const DEFAULT_PIECE = 'charm-heirloom'
const selected = ref([DEFAULT_PIECE])
const manualWrist = ref(null)
const options = reactive({
  lightEstimation: true,
  showOccluder: false,
  landmarkView: 'off',
  showWristFrame: false,
  showSegmentation: false,
  showWalls: false,
  physicsLiveliness: DEFAULT_LIVELINESS,
  frameLock: true,
  preferFrameRate: false,
  rawPose: false,
})

const capturing = ref(false)
const captureView = reactive({ active: false, status: 'idle', checks: [], results: {} })
let captureSession = null
let capturePollId = null

let gui = null
let pollId = null

async function start() {
  if (status.value === 'starting' || status.value === 'running') return
  status.value = 'starting'
  errorMessage.value = ''
  try {
    const canvas = stage.value.canvas
    const vto = new VTOEngine(canvas, { quality: 'high' })
    await vto.start({ facingMode: 'environment' })
    Object.assign(vto.options, options)
    engine.value = vto
    // Dev builds only: lets the headless smoke test (tools/eval/live-smoke.mjs)
    // read live diagnostics. Stripped from production builds.
    if (import.meta.env.DEV) window.__vto = vto
    syncStack()
    status.value = 'running'
  } catch (err) {
    console.error(err)
    status.value = 'error'
    errorMessage.value =
      err?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access and try again.'
        : (err?.message ?? String(err))
  }
}

function syncStack() {
  engine.value?.setStack(selected.value.map(getBracelet).filter(Boolean))
}

function toggle(id) {
  const idx = selected.value.indexOf(id)
  if (idx >= 0) selected.value.splice(idx, 1)
  else selected.value.push(id)
  syncStack()
}

function setManualWrist(mm) {
  manualWrist.value = mm
  engine.value?.setManualWristCircumference(mm)
}

function setOption(key, value) {
  options[key] = value
  if (engine.value) engine.value.options[key] = value
}

async function openCapture() {
  if (!DEV || !engine.value || captureSession) return
  const { CaptureSession } = await import('./vto/capture/CaptureSession.js')
  if (!engine.value || captureSession) return
  captureSession = new CaptureSession(engine.value)
  engine.value.capture = captureSession
  capturing.value = true
  Object.assign(captureView, captureSession.snapshot())
  capturePollId = setInterval(() => Object.assign(captureView, captureSession.snapshot()), 60)
}

function closeCapture() {
  if (capturePollId) clearInterval(capturePollId)
  capturePollId = null
  captureSession?.dispose()
  captureSession = null
  capturing.value = false
}

onMounted(() => {
  gui = new ControlGui({
    catalog: CATALOG,
    options,
    getEngine: () => engine.value,
    status: () => status.value,
    error: () => errorMessage.value,
    start,
    flip: () => engine.value?.flipCamera(),
    selected: () => selected.value,
    toggle,
    manualWrist: () => manualWrist.value,
    setManualWrist,
    setOption,
    // No verdicts against a wrist that has not been measured yet.
    fits: () => (engine.value?.diagnostics.wristKnown
      ? engine.value.instances.map((inst) => ({ ...inst.fit, name: inst.asset.name }))
      : []),
    capture: DEV
      ? {
          isOpen: () => capturing.value,
          open: openCapture,
          close: closeCapture,
          view: () => captureView,
          start: () => captureSession?.start(),
          redo: (id) => captureSession?.redo(id),
          skip: () => captureSession?.skip(),
          stop: () => captureSession?.stop(),
        }
      : null,
  })
  pollId = setInterval(() => gui.refresh(), 120)
  // The camera starts straight away: the browser asks for permission (a
  // camera does not need a click to start, only the permission). The panel's
  // "Start camera" stays for a retry after a refusal or an error.
  start()
})

onBeforeUnmount(() => {
  if (pollId) clearInterval(pollId)
  gui?.destroy()
  closeCapture()
  engine.value?.dispose()
})
</script>

<template>
  <VtoStage ref="stage">
    <CaptureOverlay v-if="capturing" :view="captureView" />
  </VtoStage>
</template>
