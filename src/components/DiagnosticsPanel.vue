<script setup>
defineProps({
  diagnostics: { type: Object, required: true },
  options: { type: Object, required: true },
})
defineEmits(['update:option'])

/**
 * Internal targets from the temporal-quality benchmark. Most AR looks fine in a
 * screenshot; these are the numbers that decide whether it looks fine in motion.
 */
const TARGETS = {
  jitterPx: 2,
  jitterDeg: 1,
  breathingPct: 1,
}
</script>

<template>
  <section class="panel">
    <header class="panel__head"><h2>Engine</h2></header>

    <div class="grid">
      <div class="cell" title="Images actually drawn per second, and the rate the camera delivers">
        <span>Drawn / camera</span>
        <strong>{{ diagnostics.fps }} · {{ diagnostics.cameraFps || '?' }} fps</strong>
      </div>
      <div class="cell" title="Main-thread time per image; camera capture to image drawn (where the browser reports capture times)">
        <span>Frame · latency</span>
        <strong>{{ diagnostics.frameMs }} ms · {{ diagnostics.latencyMs ? `${diagnostics.latencyMs} ms` : '?' }}</strong>
      </div>
      <div class="cell">
        <span>Tracking</span>
        <strong :class="`state state--${diagnostics.state.toLowerCase()}`">{{ diagnostics.state }}</strong>
      </div>
      <div class="cell">
        <span>Hands</span>
        <strong>{{ diagnostics.handHz }} Hz · {{ diagnostics.handMs }} ms</strong>
      </div>
      <div class="cell">
        <span>Segmentation</span>
        <strong>{{ diagnostics.segHz }} Hz · {{ diagnostics.segMs }} ms</strong>
      </div>
    </div>

    <div class="quality">
      <div class="quality__head">Temporal quality (still hand)</div>
      <div v-for="(target, key) in TARGETS" :key="key" class="quality__row">
        <span>{{ key === 'jitterPx' ? 'Position jitter' : key === 'jitterDeg' ? 'Rotation jitter' : 'Scale breathing' }}</span>
        <strong :class="{ over: diagnostics[key] > target }">
          {{ diagnostics[key] }}{{ key === 'jitterPx' ? ' px' : key === 'jitterDeg' ? '°' : '%' }}
        </strong>
        <em>≤ {{ target }}</em>
      </div>
    </div>

    <div class="toggles">
      <label v-for="(label, key) in {
        frameLock: 'Lock drawing to camera frames',
        lightEstimation: 'Camera light estimation',
        showOccluder: 'Show wrist occluder',
        showWristFrame: 'Show wrist frame (rotation)',
        showSegmentation: 'Show segmentation mask',
        showWalls: 'Show invisible walls',
      }" :key="key" class="toggle">
        <input
          type="checkbox"
          :checked="options[key]"
          @change="$emit('update:option', { key, value: $event.target.checked })"
        />
        <span>{{ label }}</span>
      </label>

      <label class="picker" title="How much of the arm's motion reaches the jewellery, and how quickly it dies away. Both ends are real physics.">
        <span>Bracelet physics</span>
        <span class="slider">
          <em>calm</em>
          <input
            type="range" min="0" max="1" step="0.05"
            :value="options.physicsLiveliness"
            @input="$emit('update:option', { key: 'physicsLiveliness', value: Number($event.target.value) })"
          />
          <em>lively</em>
        </span>
      </label>

      <label class="picker">
        <span>Hand landmarks</span>
        <select
          :value="options.landmarkView"
          @change="$emit('update:option', { key: 'landmarkView', value: $event.target.value })"
        >
          <option value="off">Off</option>
          <option value="2d">2D — raw image landmarks</option>
          <option value="3d">3D — after the solve</option>
          <option value="both">Both</option>
        </select>
      </label>
    </div>

    <p v-if="options.landmarkView === 'both'" class="hint">
      White markers are the raw 2D detections; coloured ones are the same landmarks after the
      translation solve. They should sit concentric — any gap is real disagreement between
      the detector and the solve, not a drawing artefact.
    </p>

    <!-- The numbers behind the rotation overlay, so the drawing can be checked
         against what the solver actually computed. -->
    <!-- What the invisible-walls overlay draws: the physics-only limits that
         keep a bracelet on the arm. Nothing here is rendered or occludes. -->
    <div v-if="options.showWalls" class="rot">
      <div class="rot__head">Invisible walls</div>
      <ul class="legend">
        <li><i style="background: #ff4d4d" />Two planes across the arm, at the ends of the arm tube</li>
      </ul>
      <p class="rot__note">
        The bracelet moves freely between the planes and can never pass either one.
        They only constrain it: never rendered, never hiding it.
      </p>
    </div>

    <div v-if="options.showWristFrame" class="rot">
      <div class="rot__head">Rotation solve</div>
      <div class="rot__row">
        <span>Roll vs. camera</span>
        <strong>{{ diagnostics.rollDeg }}°</strong>
        <em>0° = back of hand</em>
      </div>
      <div class="rot__row">
        <span>Dorsal agreement</span>
        <strong :class="{ weak: diagnostics.dorsalAgreement < 0.5 }">{{ diagnostics.dorsalAgreement }}</strong>
        <em>palm-plane check</em>
      </div>
      <div class="rot__row">
        <span>Forearm axis from</span>
        <strong :class="{ weak: !diagnostics.forearmFromSilhouette }">
          {{ diagnostics.forearmFromSilhouette ? 'arm silhouette' : 'joint model' }}
        </strong>
        <em>
          {{ diagnostics.forearmFromSilhouette
            ? `silhouette confidence ${diagnostics.silhouetteConfidence}`
            : 'no silhouette — holds the arm still while the wrist bends' }}
        </em>
      </div>
      <div class="rot__row">
        <span>Wrist joint</span>
        <strong>{{ diagnostics.wristFlexDeg }}° / {{ diagnostics.wristDeviationDeg }}°</strong>
        <em>flexion / deviation, hand vs. forearm — {{ diagnostics.forearmCorrectionDeg }}° total</em>
      </div>
      <div class="rot__row">
        <span>Hand motion read as</span>
        <strong>{{ diagnostics.armMotion > 0.5 ? 'arm moving' : 'wrist bending' }}</strong>
        <em>{{ diagnostics.armMotion }} — bracelet follows the hand only when the arm moves</em>
      </div>
      <div class="rot__row">
        <span>Reprojection error</span>
        <strong :class="{ weak: diagnostics.reprojectionPx > 6 }">{{ diagnostics.reprojectionPx }} px</strong>
        <em>landmark agreement on one rigid pose</em>
      </div>
      <div class="rot__row">
        <span>Angular speed</span>
        <strong>{{ diagnostics.angularSpeedDeg }}°/s</strong>
        <em>drives smoothing</em>
      </div>
      <ul class="legend">
        <li><i style="background: #ff6b6b" />Radial (X) — toward the thumb</li>
        <li><i style="background: #7fd77f" />Forearm (Y) — down the arm</li>
        <li><i style="background: #6ba8ff" />Dorsal (Z) — out the back of the hand</li>
        <li><i style="background: #e06bd8" />Thumb vector — fixes the dorsal sign</li>
        <li><i style="background: #9ad4ff" />Palm plane — the cross-check</li>
      </ul>
      <p class="rot__note">
        Thick axes are the filtered pose that drives the jewellery; thin axes are the raw
        per-frame observation. The gap between them is the smoothing and prediction.
      </p>
    </div>

    <p v-if="diagnostics.sleeveLimitMm !== Infinity" class="sleeve">
      Sleeve detected {{ diagnostics.sleeveLimitMm.toFixed(0) }} mm up the forearm — measurement stops there.
    </p>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 10px; }
.panel__head h2 {
  margin: 0; font-size: 12px; letter-spacing: 0.09em;
  text-transform: uppercase; color: #9aa0a8; font-weight: 600;
}

.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

.cell {
  padding: 8px 10px; border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.05);
  display: flex; flex-direction: column; gap: 3px;
}
.cell span { font-size: 10px; color: #6f757d; text-transform: uppercase; letter-spacing: 0.06em; }
.cell strong { font-size: 12.5px; color: #dfe2e7; font-variant-numeric: tabular-nums; font-weight: 500; }

.state--excellent { color: #8fc49b; }
.state--good { color: #b7c78f; }
.state--degraded { color: #e0a33c; }
.state--lost { color: #d66560; }

.quality {
  padding: 10px; border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.quality__head { font-size: 10px; color: #6f757d; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 7px; }
.quality__row {
  display: grid; grid-template-columns: 1fr auto 42px;
  gap: 8px; align-items: baseline; font-size: 11.5px; color: #8a9098;
  padding: 2px 0;
}
.quality__row strong { color: #8fc49b; font-variant-numeric: tabular-nums; font-weight: 500; }
.quality__row strong.over { color: #e0a33c; }
.quality__row em { font-style: normal; font-size: 10px; color: #5e646c; text-align: right; }

.toggles { display: flex; flex-direction: column; gap: 6px; }
.toggle { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #a8aeb6; cursor: pointer; }
.toggle input { accent-color: #c79a51; }

.picker {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; font-size: 12px; color: #a8aeb6; cursor: pointer; margin-top: 2px;
}
.slider { flex: 1; max-width: 172px; display: flex; align-items: center; gap: 6px; }
.slider em { font-style: normal; font-size: 10.5px; color: #6f757d; }
.slider input { flex: 1; min-width: 0; accent-color: #c79a51; }
.picker select {
  flex: 1; max-width: 172px;
  padding: 5px 7px; border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.35); color: #e6e8ec;
  font-size: 11.5px; cursor: pointer;
}
.hint {
  margin: 0; font-size: 10.5px; color: #6f757d; line-height: 1.5;
  padding: 8px 10px; border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.sleeve { margin: 0; font-size: 11px; color: #e0a33c; line-height: 1.4; }

.rot {
  padding: 10px; border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.rot__head {
  font-size: 10px; color: #6f757d; text-transform: uppercase;
  letter-spacing: 0.06em; margin-bottom: 7px;
}
.rot__row {
  display: grid; grid-template-columns: 1fr auto;
  gap: 4px 8px; align-items: baseline;
  font-size: 11.5px; color: #8a9098; padding: 2px 0;
}
.rot__row strong { color: #dfe2e7; font-variant-numeric: tabular-nums; font-weight: 500; }
.rot__row strong.weak { color: #e0a33c; }
.rot__row em {
  grid-column: 1 / -1; font-style: normal;
  font-size: 10px; color: #5e646c; margin-top: -2px;
}

.legend { list-style: none; margin: 9px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.legend li { display: flex; align-items: center; gap: 7px; font-size: 10.5px; color: #8a9098; }
.legend i { width: 9px; height: 2px; border-radius: 1px; flex: none; }

.rot__note { margin: 9px 0 0; font-size: 10.5px; color: #6f757d; line-height: 1.45; }
</style>
