/**
 * 1€ filter — adaptive low-pass that trades lag for jitter based on speed.
 * Slow movement => heavy smoothing (kills jitter).
 * Fast movement => light smoothing (kills lag).
 */
class LowPass {
  constructor() {
    this.y = null
    this.s = null
  }

  filter(value, alpha) {
    if (this.s === null) {
      this.s = value
    } else {
      this.s = alpha * value + (1 - alpha) * this.s
    }
    this.y = value
    return this.s
  }

  reset() {
    this.y = null
    this.s = null
  }
}

function alphaFor(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
    this.x = new LowPass()
    this.dx = new LowPass()
    this.lastTime = null
  }

  filter(value, timestamp) {
    let dt = 1 / 60
    if (this.lastTime !== null && timestamp > this.lastTime) {
      dt = (timestamp - this.lastTime) / 1000
    }
    this.lastTime = timestamp

    const prev = this.x.y
    const derivative = prev === null ? 0 : (value - prev) / dt
    const edx = this.dx.filter(derivative, alphaFor(this.dCutoff, dt))
    const cutoff = this.minCutoff + this.beta * Math.abs(edx)
    return this.x.filter(value, alphaFor(cutoff, dt))
  }

  reset() {
    this.x.reset()
    this.dx.reset()
    this.lastTime = null
  }
}

/** Independent 1€ filters over an N-component vector. */
export class OneEuroVec {
  constructor(size, options) {
    this.filters = Array.from({ length: size }, () => new OneEuroFilter(options))
  }

  filter(values, timestamp, out = []) {
    for (let i = 0; i < this.filters.length; i++) {
      out[i] = this.filters[i].filter(values[i], timestamp)
    }
    return out
  }

  reset() {
    this.filters.forEach((f) => f.reset())
  }
}

/**
 * 1€ filter on orientation.
 *
 * Filtering quaternion components independently is wrong (they are not
 * independent and the result leaves the unit sphere), and a fixed-rate slerp
 * cannot tell jitter from motion. This applies the 1€ idea on SO(3): the speed
 * is the geodesic angle between the filtered and the new orientation, and the
 * step is a slerp by the resulting alpha.
 */
export class OneEuroQuat {
  constructor({ minCutoff = 1.0, beta = 0.5, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
    this.value = null
    this.speed = new LowPass()
    this.lastTime = null
    this._target = null
  }

  /**
   * @param {import('three').Quaternion} q new observation
   * @param {number} timestamp ms
   * @param {number} [trust=1] 0..1, scales the cutoff down for doubtful input
   * @returns the filtered quaternion (owned by the filter; copy it to keep it)
   */
  filter(q, timestamp, trust = 1) {
    if (this.value === null) {
      this.value = q.clone()
      this._target = q.clone()
      this.lastTime = timestamp
      return this.value
    }
    let dt = 1 / 60
    if (timestamp > this.lastTime) dt = (timestamp - this.lastTime) / 1000
    this.lastTime = timestamp

    const target = this._target.copy(q)
    if (this.value.dot(target) < 0) target.set(-target.x, -target.y, -target.z, -target.w)

    const angle = this.value.angleTo(target)
    const rate = this.speed.filter(angle / dt, alphaFor(this.dCutoff, dt))
    const cutoff = (this.minCutoff + this.beta * rate) * (0.4 + 0.6 * Math.min(1, Math.max(0, trust)))
    this.value.slerp(target, alphaFor(cutoff, dt))
    return this.value
  }

  reset() {
    this.value = null
    this.speed.reset()
    this.lastTime = null
  }
}
