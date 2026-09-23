<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { VTOEngine } from './vto/VTOEngine.js'
import { CATALOG, getBracelet } from './vto/assets/catalog.js'
import VtoStage from './components/VtoStage.vue'
import CatalogPanel from './components/CatalogPanel.vue'
import FitPanel from './components/FitPanel.vue'
import DiagnosticsPanel from './components/DiagnosticsPanel.vue'

const stage = ref(null)
const engine = shallowRef(null)

const status = ref('idle') // idle | starting | running | error
const errorMessage = ref('')
const selected = ref([])
const manualWrist = ref(null)

const calibration = reactive({ active: true, coverage: 0, locked: false, prompt: '' })
const diagnostics = reactive({
  fps: 0, state: 'LOST', handHz: 0, segHz: 0, handMs: 0, segMs: 0, presence: 0,
  wristWidthMm: 0, wristDepthMm: 0, circumferenceMm: 0, shapeLocked: false,
  visualFitConfidence: 0, physicalSizeConfidence: 0,
  jitterPx: 0, jitterDeg: 0, breathingPct: 0, sleeveLimitMm: Infinity,
  rollDeg: 0, dorsalAgreement: 0, angularSpeedDeg: 0,
  reprojectionPx: 0, forearmCorrectionDeg: 0, forearmFromSilhouette: false, refineMs: 0, maskActive: false,
})
const options = reactive({
  contactShadows: true,
  lightEstimation: true,
  showOccluder: false,
  landmarkView: 'off',
  showWristFrame: false,
  showSegmentation: false,
  showWalls: false,
  realisticPhysics: false,
})
const fits = ref([])

let pollId = null

async function start() {
  if (status.value === 'starting' || status.value === 'running') return
  status.value = 'starting'
  errorMessage.value = ''
  try {
    const canvas = stage.value.canvas
    const vto = new VTOEngine(canvas, { quality: 'high' })
    await vto.start({ facingMode: 'user' })
    Object.assign(vto.options, options)
    engine.value = vto
    // Dev builds only: lets the headless smoke test (tools/eval/live-smoke.mjs)
    // read live diagnostics. Stripped from production builds.
    if (import.meta.env.DEV) window.__vto = vto
    if (selected.value.length === 0) selected.value = [CATALOG[0].id]
    syncStack()
    status.value = 'running'
    pollId = setInterval(poll, 120)
  } catch (err) {
    console.error(err)
    status.value = 'error'
    errorMessage.value =
      err?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access and try again.'
        : (err?.message ?? String(err))
  }
}

function poll() {
  const vto = engine.value
  if (!vto) return
  Object.assign(diagnostics, vto.diagnostics)
  Object.assign(calibration, vto.calibration)
  fits.value = vto.instances.map((inst) => ({ ...inst.fit, name: inst.asset.name }))
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

function setOption({ key, value }) {
  options[key] = value
  if (engine.value) engine.value.options[key] = value
}

onMounted(() => {
  // Camera access needs a user gesture on most browsers, so we wait for one.
})

onBeforeUnmount(() => {
  if (pollId) clearInterval(pollId)
  engine.value?.dispose()
})
</script>

<template>
  <div class="app">
    <header class="app__bar">
      <div class="brand">
        <span class="brand__mark" />
        <span class="brand__name">MakeMeTryOn</span>
        <span class="brand__sub">Bracelet Fitting Engine</span>
      </div>
      <div class="app__actions">
        <button v-if="status === 'running'" class="ghost" @click="engine.flipCamera()">Flip camera</button>
      </div>
    </header>

    <main class="app__body">
      <VtoStage
        ref="stage"
        :calibration="calibration"
        :state="diagnostics.state"
        :presence="diagnostics.presence"
        @skip-calibration="engine?.skipCalibration()"
      >
        <div v-if="status !== 'running'" class="gate">
          <div class="gate__card">
            <h1>Try bracelets on, at their real size.</h1>
            <p>
              We build a metric model of your wrist from the camera, then fit each piece
              at its manufactured dimensions — no resizing the jewellery to your arm.
            </p>
            <button class="primary" :disabled="status === 'starting'" @click="start">
              {{ status === 'starting' ? 'Starting camera…' : 'Start camera' }}
            </button>
            <p v-if="errorMessage" class="gate__error">{{ errorMessage }}</p>
            <p class="gate__note">Video never leaves your device. All processing runs locally.</p>
          </div>
        </div>
      </VtoStage>

      <aside class="app__side">
        <CatalogPanel :catalog="CATALOG" :selected="selected" @toggle="toggle" />
        <FitPanel
          :fits="fits"
          :diagnostics="diagnostics"
          :manual-wrist="manualWrist"
          @set-manual-wrist="setManualWrist"
          @recalibrate="engine?.recalibrate()"
        />
        <DiagnosticsPanel :diagnostics="diagnostics" :options="options" @update:option="setOption" />
      </aside>
    </main>
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0b0c0f;
  color: #e6e8ec;
}

.app__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.brand { display: flex; align-items: center; gap: 9px; }

.brand__mark {
  width: 17px; height: 17px; border-radius: 50%;
  background: linear-gradient(140deg, #f2cf86, #b8853a);
  box-shadow: inset -2px -3px 5px rgba(0, 0, 0, 0.35);
}

.brand__name { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; }
.brand__sub { font-size: 11.5px; color: #6f757d; margin-left: 3px; }

.ghost {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #c9ced5; font-size: 12px;
  padding: 6px 12px; border-radius: 7px; cursor: pointer;
}
.ghost:hover { background: rgba(255, 255, 255, 0.09); }

.app__body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 14px;
  padding: 14px;
}

.app__side {
  width: 320px;
  flex: none;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-right: 4px;
}

.gate {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 50% 40%, #16181d, #08090b);
  padding: 24px;
}

.gate__card { max-width: 420px; text-align: center; }
.gate__card h1 { margin: 0 0 12px; font-size: 25px; line-height: 1.25; font-weight: 600; }
.gate__card p { margin: 0 0 18px; font-size: 13.5px; line-height: 1.6; color: #969ca4; }

.primary {
  background: linear-gradient(140deg, #f2cf86, #c79a51);
  border: none; color: #1a1206;
  font-size: 14px; font-weight: 600;
  padding: 11px 26px; border-radius: 9px; cursor: pointer;
}
.primary:disabled { opacity: 0.6; cursor: default; }

.gate__error { color: #d66560; font-size: 12.5px; margin-top: 14px; }
.gate__note { font-size: 11px; color: #5e646c; margin-top: 16px; }

@media (max-width: 900px) {
  .app__body { flex-direction: column; }
  .app__side { width: auto; }
}
</style>
