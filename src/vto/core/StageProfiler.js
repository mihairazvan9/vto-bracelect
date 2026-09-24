/**
 * Where a frame's main-thread time goes, stage by stage.
 *
 * Each frame: begin(), then lap(name) after each stage (the time since the
 * previous lap), or add(name, ms) for a cost measured elsewhere; end() files
 * the frame. A stage that did not run on a frame counts 0 for it, so a stage's
 * mean is its cost per frame - what it takes out of the frame budget - and its
 * p95 shows the frames it does run on.
 */
export class StageProfiler {
  /** @param {number} [frames] how many recent frames the statistics cover */
  constructor(frames = 120) {
    this.frames = frames
    /** @type {Map<string, Float64Array>} */
    this._rings = new Map()
    this._n = 0
    this._t = 0
    this._frame = new Map()
  }

  begin(t = performance.now()) {
    this._t = t
    this._frame.clear()
  }

  lap(name) {
    const t = performance.now()
    this.add(name, t - this._t)
    this._t = t
  }

  add(name, ms) {
    this._frame.set(name, (this._frame.get(name) ?? 0) + ms)
  }

  end() {
    for (const name of this._frame.keys()) {
      if (!this._rings.has(name)) this._rings.set(name, new Float64Array(this.frames))
    }
    const slot = this._n % this.frames
    for (const [name, ring] of this._rings) ring[slot] = this._frame.get(name) ?? 0
    this._n++
  }

  /** @returns {Record<string, {mean:number, p50:number, p95:number}>} ms, over the recent frames */
  summary() {
    const count = Math.min(this._n, this.frames)
    const out = {}
    if (!count) return out
    for (const [name, ring] of this._rings) {
      const v = Array.from(ring.subarray(0, count)).sort((a, b) => a - b)
      const mean = v.reduce((a, b) => a + b, 0) / count
      out[name] = {
        mean: +mean.toFixed(2),
        p50: +v[Math.floor(count * 0.5)].toFixed(2),
        p95: +v[Math.min(count - 1, Math.floor(count * 0.95))].toFixed(2),
      }
    }
    return out
  }
}
