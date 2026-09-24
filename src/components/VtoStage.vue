<script setup>
import { ref } from 'vue'

const canvas = ref(null)
defineExpose({ canvas })
</script>

<template>
  <!-- The camera, edge to edge: nothing else on screen but the lil-gui panel
       (and the clip recorder's coaching while it records). -->
  <div class="stage">
    <canvas ref="canvas" class="stage__canvas" />
    <slot />
  </div>
</template>

<style scoped>
.stage {
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
}

.stage__canvas {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
