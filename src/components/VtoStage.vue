<script setup>
import { ref } from 'vue'

const canvas = ref(null)
defineExpose({ canvas })

defineProps({
  calibration: { type: Object, required: true },
  state: { type: String, default: 'LOST' },
  presence: { type: Number, default: 0 },
})
defineEmits(['skip-calibration'])
</script>

<template>
  <div class="stage">
    <canvas ref="canvas" class="stage__canvas" />
    <slot />

    <!-- Confidence-aware UI: never a hard "not detected", always a reason. -->
    <transition name="fade">
      <div v-if="state === 'LOST'" class="stage__hint">
        <span class="dot dot--lost" />
        Show your wrist to the camera
      </div>
      <div v-else-if="state === 'DEGRADED'" class="stage__hint">
        <span class="dot dot--degraded" />
        Tracking is weak — more light or a slower movement will help
      </div>
    </transition>

    <transition name="fade">
      <div v-if="calibration.active && state !== 'LOST'" class="calib">
        <div class="calib__prompt">{{ calibration.prompt }}</div>
        <div class="calib__bar">
          <div class="calib__fill" :style="{ width: `${Math.round(calibration.coverage * 100)}%` }" />
        </div>
        <div class="calib__sub">
          Turning your wrist is what lets us measure its depth, not just its width.
        </div>
        <button class="calib__skip" @click="$emit('skip-calibration')">Skip</button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  background: #07080a;
  border-radius: 14px;
  overflow: hidden;
  display: flex;
}

.stage__canvas {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.stage__hint {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border-radius: 999px;
  background: rgba(10, 12, 16, 0.78);
  backdrop-filter: blur(10px);
  color: #e8eaee;
  font-size: 13px;
  white-space: nowrap;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.dot--lost { background: #8b9099; }
.dot--degraded { background: #e0a33c; }

.calib {
  position: absolute;
  left: 50%;
  top: 22px;
  transform: translateX(-50%);
  width: min(380px, calc(100% - 32px));
  padding: 14px 16px 12px;
  border-radius: 12px;
  background: rgba(10, 12, 16, 0.8);
  backdrop-filter: blur(12px);
  color: #eef0f3;
  text-align: center;
}

.calib__prompt { font-size: 14px; font-weight: 500; }

.calib__bar {
  margin: 10px 0 8px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}

.calib__fill {
  height: 100%;
  background: linear-gradient(90deg, #d8a44e, #f2cf86);
  transition: width 0.25s ease;
}

.calib__sub { font-size: 11.5px; opacity: 0.6; line-height: 1.4; }

.calib__skip {
  margin-top: 10px;
  background: none;
  border: none;
  color: #9aa0a8;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.25s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
