<script setup>
import { computed } from 'vue'

const props = defineProps({
  view: { type: Object, required: true },
})

const ARROW_TURN = { right: 0, down: 90, left: 180, up: 270 }
const turn = computed(() => ARROW_TURN[props.view.arrow])
const zoom = computed(() => (props.view.arrow === 'closer' || props.view.arrow === 'further' ? props.view.arrow : null))
const recording = computed(() => props.view.status === 'recording')
</script>

<template>
  <div v-if="view.active" class="cap">
    <div class="cap__card">
      <div class="cap__title">
        <span v-if="recording" class="rec"><i />REC</span>
        <span v-else-if="view.status === 'countdown'" class="rec rec--soon"><i />Get ready</span>
        {{ view.title }}
      </div>
      <div class="cap__instruction">{{ view.instruction }}</div>
      <div v-if="recording" class="cap__bar">
        <div class="cap__fill" :style="{ width: `${Math.round(view.progress * 100)}%` }" />
      </div>
      <div v-if="recording" class="cap__metric">{{ view.progressText }}</div>
    </div>

    <div v-if="view.countdown" :key="view.countdown" class="cap__count">{{ view.countdown }}</div>

    <div v-if="turn !== undefined" class="cap__arrow" :style="{ '--turn': `${turn}deg` }">
      <svg viewBox="0 0 120 60" aria-hidden="true"><path d="M8 30h86M72 8l26 22-26 22" /></svg>
    </div>
    <div v-else-if="zoom" class="cap__zoom" :class="`cap__zoom--${zoom}`" aria-hidden="true">
      <span /><span /><span /><span />
    </div>

    <transition name="fade">
      <div v-if="view.prompt" :key="view.prompt" class="cap__prompt">{{ view.prompt }}</div>
    </transition>

    <div v-if="view.status === 'failed' || view.status === 'saving' || (view.message && view.status === 'done')" class="cap__message"
      :class="{ 'cap__message--bad': view.status === 'failed' }">
      {{ view.message }}
    </div>

    <div v-if="view.rateNote" class="cap__rate">{{ view.rateNote }}</div>
    <div class="cap__checks">
      <span v-for="c in view.checks" :key="c.id" class="chip" :class="{ 'chip--ok': c.ok, 'chip--soft': c.soft && !c.ok }">
        {{ c.ok ? '✓' : c.soft ? '!' : '✕' }} {{ c.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.cap { position: absolute; inset: 0; pointer-events: none; color: #eef0f3; }

.cap__card {
  position: absolute; left: 50%; top: 18px; transform: translateX(-50%);
  width: min(460px, calc(100% - 32px));
  padding: 13px 16px 12px; border-radius: 12px;
  background: rgba(10, 12, 16, 0.82); backdrop-filter: blur(12px);
  text-align: center;
}
.cap__title { font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: #a9afb7; display: flex; gap: 8px; justify-content: center; align-items: center; }
.cap__instruction { margin-top: 6px; font-size: 15px; font-weight: 500; line-height: 1.35; }
.cap__bar { margin: 10px 0 6px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.14); overflow: hidden; }
.cap__fill { height: 100%; background: linear-gradient(90deg, #d8a44e, #f2cf86); transition: width 0.15s linear; }
.cap__metric { font-size: 12px; color: #b9bec5; font-variant-numeric: tabular-nums; }

.rec { display: inline-flex; align-items: center; gap: 5px; color: #ff6b62; font-weight: 600; }
.rec i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: blink 1s infinite; }
.rec--soon { color: #f2cf86; }
@keyframes blink { 50% { opacity: 0.25; } }

.cap__count {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  font-size: 120px; font-weight: 700; color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
  animation: pop 0.8s ease-out;
}
@keyframes pop { from { transform: translate(-50%, -50%) scale(1.4); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }

.cap__arrow {
  position: absolute; left: 50%; top: 50%;
  width: 150px; height: 75px;
  transform: translate(-50%, -50%) rotate(var(--turn));
  filter: drop-shadow(0 2px 10px rgba(0, 0, 0, 0.6));
}
.cap__arrow svg { width: 100%; height: 100%; overflow: visible; animation: nudge 1s ease-in-out infinite; }
.cap__arrow path { fill: none; stroke: #f2cf86; stroke-width: 9; stroke-linecap: round; stroke-linejoin: round; }
@keyframes nudge { 50% { transform: translateX(14px); } }

.cap__zoom { position: absolute; left: 50%; top: 50%; width: 160px; height: 110px; transform: translate(-50%, -50%); }
.cap__zoom span { position: absolute; width: 26px; height: 26px; border: 0 solid #f2cf86; filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.6)); }
.cap__zoom span:nth-child(1) { left: 0; top: 0; border-width: 6px 0 0 6px; }
.cap__zoom span:nth-child(2) { right: 0; top: 0; border-width: 6px 6px 0 0; }
.cap__zoom span:nth-child(3) { left: 0; bottom: 0; border-width: 0 0 6px 6px; }
.cap__zoom span:nth-child(4) { right: 0; bottom: 0; border-width: 0 6px 6px 0; }
.cap__zoom--closer { animation: grow 1.1s ease-in-out infinite; }
.cap__zoom--further { animation: shrink 1.1s ease-in-out infinite; }
@keyframes grow { 50% { transform: translate(-50%, -50%) scale(1.3); } }
@keyframes shrink { 50% { transform: translate(-50%, -50%) scale(0.72); } }

.cap__prompt {
  position: absolute; left: 50%; bottom: 64px; transform: translateX(-50%);
  max-width: calc(100% - 32px);
  padding: 10px 18px; border-radius: 999px;
  background: rgba(10, 12, 16, 0.85); backdrop-filter: blur(10px);
  font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.cap__message {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  max-width: min(420px, calc(100% - 32px));
  padding: 14px 20px; border-radius: 12px;
  background: rgba(10, 12, 16, 0.88); font-size: 14px; text-align: center; line-height: 1.45;
}
.cap__message--bad { border: 1px solid rgba(255, 107, 98, 0.5); }

.cap__rate {
  position: absolute; left: 50%; bottom: 50px; transform: translateX(-50%);
  max-width: calc(100% - 32px); font-size: 12px; color: #ffe3b0; text-align: center;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.8);
}
.cap__checks {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
  display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; max-width: calc(100% - 24px);
}
.chip { font-size: 11.5px; padding: 4px 9px; border-radius: 999px; background: rgba(214, 101, 96, 0.28); color: #ffd6d3; }
.chip--ok { background: rgba(80, 180, 120, 0.25); color: #c9f1d6; }
.chip--soft { background: rgba(224, 163, 60, 0.25); color: #ffe3b0; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
