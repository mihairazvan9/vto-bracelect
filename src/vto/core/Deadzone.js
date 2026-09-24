import { Vector3 } from 'three'

/**
 * Two-band soft deadzone over a 2D point.
 *
 * The output moves only by how far the reading has left a band around it, so
 * it never trails a real movement by more than the band - and never smooths
 * one out. While the point is still, the band is wide and swallows small
 * frame-to-frame noise; once a reading clearly leaves it the band narrows and
 * the output follows to within `movePx`; after `calmFrames` frames of small
 * steps it widens again. Soft, so leaving the band never jumps the output.
 */
export class Deadzone2D {
  /**
   * @param {{restPx?: number, movePx?: number, calmFrames?: number, calmStepPx?: number}} [options]
   *        band while still and while moving, px; frames of steps under
   *        calmStepPx px after which the point counts as still again
   */
  constructor({ restPx = 5, movePx = 1, calmFrames = 3, calmStepPx = 1.5 } = {}) {
    this.restPx = restPx
    this.movePx = movePx
    this.calmFrames = calmFrames
    this.calmStepPx = calmStepPx
    this.reset()
  }

  reset() {
    this.value = null
    this._prev = [0, 0]
    this.moving = false
    this._calm = 0
  }

  /**
   * @param {number[]} v the reading, [x, y] in any units
   * @param {number} pxPerUnit pixels per unit of `v` (the bands are in px)
   * @returns {number[]} the output (owned by the filter)
   */
  filter(v, pxPerUnit) {
    if (!this.value) {
      this.value = [v[0], v[1]]
      this._prev[0] = v[0]
      this._prev[1] = v[1]
      return this.value
    }
    const step = Math.hypot(v[0] - this._prev[0], v[1] - this._prev[1]) * pxPerUnit
    this._prev[0] = v[0]
    this._prev[1] = v[1]
    const ex = v[0] - this.value[0]
    const ey = v[1] - this.value[1]
    const off = Math.hypot(ex, ey) * pxPerUnit
    if (!this.moving && off > this.restPx) this.moving = true
    if (this.moving) {
      this._calm = step < this.calmStepPx ? this._calm + 1 : 0
      if (this._calm >= this.calmFrames) this.moving = false
    }
    const band = this.moving ? this.movePx : this.restPx
    if (off > band) {
      const k = 1 - band / off
      this.value[0] += ex * k
      this.value[1] += ey * k
    }
    return this.value
  }
}

/** Two-band soft deadzone over one value: Deadzone2D's logic, in the value's own units. */
export class Deadzone1D {
  /**
   * @param {{rest: number, move: number, calmFrames?: number, calmStep?: number}} options
   *        band while still and while moving; frames of steps under calmStep
   *        (default: 0.5 x rest) after which the value counts as still again
   */
  constructor({ rest, move, calmFrames = 3, calmStep = rest * 0.5 }) {
    this.rest = rest
    this.move = move
    this.calmFrames = calmFrames
    this.calmStep = calmStep
    this.reset()
  }

  reset(value = null) {
    this.value = value
    this._prev = value
    this.moving = false
    this._calm = 0
  }

  /** @param {number} v the reading @returns {number} the output */
  filter(v) {
    if (this.value === null) {
      this.reset(v)
      return v
    }
    const step = Math.abs(v - this._prev)
    this._prev = v
    const e = v - this.value
    if (!this.moving && Math.abs(e) > this.rest) this.moving = true
    if (this.moving) {
      this._calm = step < this.calmStep ? this._calm + 1 : 0
      if (this._calm >= this.calmFrames) this.moving = false
    }
    const band = this.moving ? this.move : this.rest
    if (Math.abs(e) > band) this.value += e - Math.sign(e) * band
    return this.value
  }
}

const _axis = new Vector3()

/**
 * Soft deadzone on a direction (a unit vector): it turns only by how far the
 * reading is beyond `deg` from it. A still direction holds; a turning one is
 * followed to within `deg`, never smoothed.
 */
export class DeadzoneDir {
  /** @param {{deg?: number}} [options] band, degrees */
  constructor({ deg = 1 } = {}) {
    this.band = (deg * Math.PI) / 180
    this.value = null
  }

  reset() {
    this.value = null
  }

  /**
   * @param {Vector3} v the reading (need not be normalised)
   * @returns {Vector3} the output (owned by the filter)
   */
  filter(v) {
    if (!this.value) {
      this.value = v.clone().normalize()
      return this.value
    }
    const angle = this.value.angleTo(v)
    if (angle > this.band) {
      _axis.crossVectors(this.value, v)
      if (_axis.lengthSq() > 1e-14) this.value.applyAxisAngle(_axis.normalize(), angle - this.band).normalize()
    }
    return this.value
  }
}
