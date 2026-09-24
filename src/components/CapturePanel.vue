<script setup>
import { SCENARIOS } from '../vto/capture/scenarios.js'

defineProps({
  view: { type: Object, required: true },
})
defineEmits(['start', 'redo', 'skip', 'stop', 'close'])

function stateOf(view, s) {
  if (view.scenarioId === s.id && view.active && view.status !== 'done') return 'current'
  return view.results[s.id]?.state ?? 'pending'
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <h2>Record test clips</h2>
      <button class="link" @click="$emit('close')">Close</button>
    </header>
    <p class="note">
      Each take is saved to <code>fixtures/</code> for <code>npm run bench</code>. Follow the prompts on the
      video; a take only counts once it contains the movement asked for.
    </p>

    <ol class="list">
      <li v-for="s in SCENARIOS" :key="s.id" class="item" :class="`item--${stateOf(view, s)}`">
        <div class="item__main">
          <span class="item__mark">{{
            { done: '✓', skipped: '–', error: '!', current: '●', pending: '○' }[stateOf(view, s)]
          }}</span>
          <div>
            <div class="item__title">{{ s.title }}<em v-if="s.optional"> optional</em></div>
            <div class="item__why">
              <template v-if="view.results[s.id]?.state === 'done'">
                {{ view.results[s.id].seconds }} s · {{ view.results[s.id].frames }} frames · {{ view.results[s.id].mb }} MB
              </template>
              <template v-else-if="view.results[s.id]?.state === 'error'">{{ view.results[s.id].message }}</template>
              <template v-else>{{ s.why }}</template>
            </div>
          </div>
        </div>
        <button
          v-if="!view.active || view.status === 'done'"
          class="link"
          @click="$emit('redo', s.id)"
        >{{ view.results[s.id] ? 'Redo' : 'Record' }}</button>
      </li>
    </ol>

    <div class="actions">
      <template v-if="!view.active || view.status === 'done'">
        <button class="primary" @click="$emit('start')">
          {{ Object.keys(view.results).length ? 'Record remaining' : 'Start recording' }}
        </button>
      </template>
      <template v-else>
        <button class="ghost" :disabled="view.status === 'saving'" @click="$emit('skip')">Skip this one</button>
        <button class="ghost" :disabled="view.status === 'saving'" @click="$emit('stop')">Stop</button>
      </template>
    </div>
    <p v-if="view.status === 'done'" class="note">{{ view.message }}</p>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 10px; }
.panel__head { display: flex; align-items: center; justify-content: space-between; }
.panel__head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; }
.note { margin: 0; font-size: 12px; line-height: 1.5; color: #8d939b; }
code { font-size: 11.5px; color: #c9ced5; }

.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 10px; border-radius: 9px; background: rgba(255, 255, 255, 0.03);
}
.item--current { background: rgba(242, 207, 134, 0.1); outline: 1px solid rgba(242, 207, 134, 0.35); }
.item__main { display: flex; gap: 9px; align-items: flex-start; min-width: 0; }
.item__mark { width: 14px; flex: none; text-align: center; color: #6f757d; font-size: 12px; line-height: 18px; }
.item--done .item__mark { color: #7fd29c; }
.item--current .item__mark { color: #ff6b62; }
.item--error .item__mark { color: #e0a33c; }
.item__title { font-size: 12.5px; font-weight: 500; }
.item__title em { font-style: normal; font-size: 10.5px; color: #7d838b; margin-left: 5px; }
.item__why { font-size: 11px; color: #7d838b; line-height: 1.4; margin-top: 1px; }

.actions { display: flex; gap: 8px; }
.primary {
  background: linear-gradient(140deg, #f2cf86, #c79a51); border: none; color: #1a1206;
  font-size: 12.5px; font-weight: 600; padding: 8px 16px; border-radius: 8px; cursor: pointer;
}
.ghost {
  background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1);
  color: #c9ced5; font-size: 12px; padding: 7px 12px; border-radius: 7px; cursor: pointer;
}
.ghost:disabled { opacity: 0.5; cursor: default; }
.link { background: none; border: none; color: #9aa0a8; font-size: 12px; cursor: pointer; text-decoration: underline; padding: 0; }
</style>
