<script setup>
const props = defineProps({
  catalog: { type: Array, required: true },
  selected: { type: Array, required: true },
})
const emit = defineEmits(['toggle'])

const CATEGORY_LABEL = {
  rigid_bangle: 'Rigid bangle',
  open_cuff: 'Open cuff',
  tennis_bracelet: 'Tennis',
  chain: 'Chain',
  charm_bracelet: 'Charm',
}

const SWATCH = {
  gold: '#f0c268',
  'rose-gold': '#e5a184',
  'white-gold': '#e8ebee',
  silver: '#d9dee2',
}

function isSelected(id) {
  return props.selected.includes(id)
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <h2>Catalogue</h2>
      <span class="panel__note">Tap to stack</span>
    </header>

    <ul class="list">
      <li v-for="item in catalog" :key="item.id">
        <button
          class="card"
          :class="{ 'card--on': isSelected(item.id) }"
          @click="emit('toggle', item.id)"
        >
          <span class="card__swatch" :style="{ background: SWATCH[item.material.type] ?? '#f0c268' }" />
          <span class="card__body">
            <span class="card__name">{{ item.name }}</span>
            <span class="card__meta">
              {{ CATEGORY_LABEL[item.category] }} · {{ item.innerCircumferenceMm }} mm · {{ item.massG }} g
            </span>
          </span>
          <span v-if="isSelected(item.id)" class="card__index">
            {{ selected.indexOf(item.id) + 1 }}
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 10px; }

.panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.panel__head h2 {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #9aa0a8;
  font-weight: 600;
}

.panel__note { font-size: 11px; color: #6a7078; }

.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }

.card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 11px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.025);
  color: #e6e8ec;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.card:hover { background: rgba(255, 255, 255, 0.055); }

.card--on {
  border-color: rgba(226, 178, 96, 0.55);
  background: rgba(226, 178, 96, 0.1);
}

.card__swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  flex: none;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35), inset -3px -4px 7px rgba(0, 0, 0, 0.3);
}

.card__body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.card__name { font-size: 13px; font-weight: 500; }
.card__meta { font-size: 11px; color: #858b93; }

.card__index {
  flex: none;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: #e2b260;
  color: #1a1206;
  font-size: 11px;
  font-weight: 700;
}
</style>
