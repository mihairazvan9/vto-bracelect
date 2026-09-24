/**
 * A one-dimensional constant-velocity Kalman filter: a value and its rate,
 * with the rate's changes (acceleration) as white noise.
 *
 * Why not another 1€ filter: a Kalman filter keeps an explicit prediction
 * (value + rate x dt) and weighs each measurement against it by how much it
 * trusts both. That gives three things the tracker needs:
 *   - measurements of different quality can be fused, each with its own
 *     variance (a steady ruler and a noisy one feed the same state);
 *   - a missing measurement is simply no update - the prediction carries on,
 *     nothing switches source and nothing steps;
 *   - an implausible measurement (far outside what the prediction and its
 *     uncertainty allow) is down-weighted instead of obeyed (robust gating).
 *
 * Units are the caller's. `q` is the acceleration noise spectral density
 * (unit^2 / s^3): larger follows faster changes, smaller smooths harder.
 */
export class KalmanCV {
  /**
   * @param {{q:number, r:number, gate?:number, p0?:number, pv0?:number}} options
   *        q  acceleration noise density; r  default measurement variance;
   *        gate  innovation beyond this many sigmas is down-weighted;
   *        p0 / pv0  initial variance of the value / rate
   */
  constructor({ q, r, gate = 3, p0 = r, pv0 = 1 }) {
    this.q = q
    this.r = r
    this.gate = gate
    this.p0 = p0
    this.pv0 = pv0
    this.valid = false
    this.x = 0
    this.v = 0
    this.p00 = p0
    this.p01 = 0
    this.p11 = pv0
    /** Normalised innovation of the last update (sigmas), for diagnostics. */
    this.lastSigma = 0
  }

  reset(x = 0, v = 0) {
    this.x = x
    this.v = v
    this.p00 = this.p0
    this.p01 = 0
    this.p11 = this.pv0
    this.valid = true
    this.lastSigma = 0
  }

  /** Advance the state by dt seconds. */
  predict(dt) {
    if (!(dt > 0)) return
    this.x += this.v * dt
    const q = this.q
    const dt2 = dt * dt
    const p00 = this.p00 + dt * (2 * this.p01 + dt * this.p11) + (q * dt2 * dt) / 3
    const p01 = this.p01 + dt * this.p11 + (q * dt2) / 2
    const p11 = this.p11 + q * dt
    this.p00 = p00
    this.p01 = p01
    this.p11 = p11
  }

  /**
   * Fuse a measurement of the value.
   * @param {number} z
   * @param {number} [r] its variance
   * @returns {number} the filtered value
   */
  update(z, r = this.r) {
    if (!this.valid) {
      this.reset(z, 0)
      return this.x
    }
    const y = z - this.x
    let s = this.p00 + r
    const d2 = (y * y) / s
    this.lastSigma = Math.sqrt(d2)
    // Robust: outside the gate, inflate this measurement's variance so its
    // pull stays bounded (Huber-like), instead of either obeying or ignoring it.
    if (d2 > this.gate * this.gate) {
      s = this.p00 + r * (d2 / (this.gate * this.gate))
    }
    const k0 = this.p00 / s
    const k1 = this.p01 / s
    this.x += k0 * y
    this.v += k1 * y
    const p00 = (1 - k0) * this.p00
    const p01 = (1 - k0) * this.p01
    const p11 = this.p11 - k1 * this.p01
    this.p00 = p00
    this.p01 = p01
    this.p11 = p11
    return this.x
  }
}
