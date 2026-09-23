<script setup>
import { computed } from 'vue'

const props = defineProps({
  fits: { type: Array, default: () => [] },
  diagnostics: { type: Object, required: true },
  manualWrist: { type: Number, default: null },
})
const emit = defineEmits(['set-manual-wrist', 'recalibrate'])

const VERDICT_TONE = {
  too_small: 'bad',
  will_not_pass_hand: 'bad',
  snug: 'warn',
  comfortable: 'good',
  loose: 'warn',
  too_loose: 'bad',
}

const wrist = computed(() => props.diagnostics.circumferenceMm)

function onManual(event) {
  const value = Number(event.target.value)
  emit('set-manual-wrist', Number.isFinite(value) && value > 0 ? value : null)
}

function pct(v) {
  return `${Math.round((v ?? 0) * 100)}%`
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <h2>Fit</h2>
      <button class="link" @click="emit('recalibrate')">Re-measure</button>
    </header>

    <div class="measure">
      <div class="measure__row">
        <span>Wrist circumference</span>
        <strong>{{ wrist ? `${wrist.toFixed(0)} mm` : '—' }}</strong>
      </div>
      <div class="measure__row measure__row--sub">
        <span>{{ diagnostics.wristWidthMm }} × {{ diagnostics.wristDepthMm }} mm</span>
        <span :class="['lock', { 'lock--on': diagnostics.shapeLocked }]">
          {{ diagnostics.shapeLocked ? 'shape locked' : 'measuring…' }}
        </span>
      </div>

      <!-- The two confidences are genuinely different and we say so. -->
      <div class="conf">
        <div class="conf__item">
          <span>Visual fit</span>
          <div class="conf__bar"><div class="conf__fill" :style="{ width: pct(diagnostics.visualFitConfidence) }" /></div>
          <em>{{ pct(diagnostics.visualFitConfidence) }}</em>
        </div>
        <div class="conf__item">
          <span>Physical size</span>
          <div class="conf__bar"><div class="conf__fill conf__fill--size" :style="{ width: pct(diagnostics.physicalSizeConfidence) }" /></div>
          <em>{{ pct(diagnostics.physicalSizeConfidence) }}</em>
        </div>
      </div>

      <label class="manual">
        <span>Know your wrist size? Enter it for exact sizing.</span>
        <div class="manual__input">
          <input
            type="number"
            min="100"
            max="240"
            step="1"
            placeholder="mm"
            :value="manualWrist ?? ''"
            @change="onManual"
          />
          <span>mm</span>
        </div>
      </label>
    </div>

    <ul v-if="fits.length" class="fits">
      <li v-for="fit in fits" :key="fit.assetId" class="fit">
        <div class="fit__top">
          <span class="fit__name">{{ fit.name }}</span>
          <span :class="['badge', `badge--${VERDICT_TONE[fit.verdict]}`]">
            {{ fit.verdict.replace(/_/g, ' ') }}
          </span>
        </div>
        <p class="fit__msg">{{ fit.message }}</p>
        <div class="fit__numbers">
          <span>Piece {{ fit.braceletCircumferenceMm }} mm</span>
          <span>Slack {{ fit.slackMm >= 0 ? '+' : '' }}{{ fit.slackMm.toFixed(0) }} mm</span>
          <span>Sits {{ fit.restingOffsetMm.toFixed(0) }} mm up</span>
        </div>
        <p v-if="fit.verdict !== 'comfortable'" class="fit__rec">
          Recommended size ≈ {{ fit.recommendedCircumferenceMm }} mm
        </p>
      </li>
    </ul>
    <p v-else class="empty">Pick a piece from the catalogue.</p>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 10px; }

.panel__head { display: flex; align-items: baseline; justify-content: space-between; }
.panel__head h2 {
  margin: 0; font-size: 12px; letter-spacing: 0.09em;
  text-transform: uppercase; color: #9aa0a8; font-weight: 600;
}

.link {
  background: none; border: none; color: #c79a51;
  font-size: 11.5px; cursor: pointer; padding: 0;
}

.measure {
  padding: 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  display: flex; flex-direction: column; gap: 9px;
}

.measure__row { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; color: #d7dae0; }
.measure__row strong { font-size: 16px; color: #f1e3c8; font-variant-numeric: tabular-nums; }
.measure__row--sub { font-size: 11px; color: #7f858d; }

.lock { color: #7f858d; }
.lock--on { color: #7fb08a; }

.conf { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
.conf__item { display: grid; grid-template-columns: 78px 1fr 34px; align-items: center; gap: 8px; font-size: 11px; color: #8a9098; }
.conf__bar { height: 3px; border-radius: 2px; background: rgba(255, 255, 255, 0.1); overflow: hidden; }
.conf__fill { height: 100%; background: #7fb08a; transition: width 0.3s ease; }
.conf__fill--size { background: #c79a51; }
.conf__item em { font-style: normal; text-align: right; font-variant-numeric: tabular-nums; }

.manual { display: flex; flex-direction: column; gap: 6px; font-size: 11px; color: #7f858d; }
.manual__input { display: flex; align-items: center; gap: 6px; }
.manual__input input {
  width: 84px; padding: 6px 8px; border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.3); color: #e6e8ec; font-size: 13px;
}

.fits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }

.fit {
  padding: 11px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.fit__top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.fit__name { font-size: 13px; color: #e6e8ec; font-weight: 500; }

.badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 3px 7px; border-radius: 999px; white-space: nowrap;
}
.badge--good { background: rgba(127, 176, 138, 0.16); color: #8fc49b; }
.badge--warn { background: rgba(224, 163, 60, 0.16); color: #e0a33c; }
.badge--bad { background: rgba(214, 101, 96, 0.16); color: #d66560; }

.fit__msg { margin: 7px 0 8px; font-size: 12px; color: #a8aeb6; line-height: 1.45; }

.fit__numbers {
  display: flex; flex-wrap: wrap; gap: 10px;
  font-size: 11px; color: #7f858d; font-variant-numeric: tabular-nums;
}

.fit__rec { margin: 8px 0 0; font-size: 11.5px; color: #c79a51; }

.empty { font-size: 12px; color: #6a7078; margin: 0; }
</style>
