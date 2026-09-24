import { KalmanCV } from './KalmanCV.js'
import { Deadzone2D } from './Deadzone.js'

/** Acceleration noise, px^2/s^3: how fast the hand's velocity may change. */
const Q_PX = 2e4
/** Detector noise on a still hand, px (~1 px frame to frame on the recordings). */
const R_PX = 1.5
/** Deadzone after the Kalman filter: still / moving band, px. */
const DEADZONE = { restPx: 2, movePx: 0.3 }

/**
 * Where the wrist is ON SCREEN: a constant-velocity Kalman filter per axis,
 * then a small deadzone.
 *
 * A low-pass filter trails a moving hand in proportion to its speed; a
 * constant-velocity filter predicts along the motion, so a steady movement is
 * followed without trailing and only changes of speed are smoothed. The
 * deadzone then holds a still wrist still. No outlier gate: at 10-16 fps a
 * real flick looks like an outlier, and gated the filter lost the hand (lag
 * p95 34-56 px).
 *
 * Replayed on the recordings (11-16 fps, as webcams deliver in dim light; px
 * on the processed image, p50 / p95; frames classified by the raw reading's
 * own step, so every variant is judged on the same frames):
 *
 *                               still: shake   moving: lag   start of a move: lag (p95)
 *   raw detection                  2.1 / 5.7      0 / 0             0
 *   1€ (1.7 Hz, beta 14), before   0.7 / 2.1      5.2 / 10.1        8.5
 *   deadzone alone (5 / 1 px)      0.0 / 4.8      0.6 / 1.0         1.0
 *   this                           0.7 / 3.6      0.5 / 2.6         1.8
 *
 * The 1€ filter's speed estimate is itself smoothed (~160 ms), so for the
 * first frames of every movement it still smoothed as if the arm were still:
 * the wrist cylinder visibly trailed the hand. Its lower "shake" while moving
 * (70 against the raw 112 px p95 second difference) was that same trailing -
 * the raw hand really accelerates that much at these frame rates.
 */
export class ScreenPointFilter {
  constructor() {
    this._kx = new KalmanCV({ q: Q_PX, r: R_PX * R_PX, gate: Infinity, pv0: 1e4 })
    this._ky = new KalmanCV({ q: Q_PX, r: R_PX * R_PX, gate: Infinity, pv0: 1e4 })
    this._deadzone = new Deadzone2D(DEADZONE)
    this._t = null
    this._p = [0, 0]
  }

  reset() {
    this._kx.valid = false
    this._ky.valid = false
    this._deadzone.reset()
    this._t = null
  }

  /**
   * @param {number[]} v the reading, [x, y] in any units
   * @param {number} t ms
   * @param {number} pxPerUnit pixels per unit of `v`
   * @returns {number[]} the output, in the units of `v` (owned by the filter)
   */
  filter(v, t, pxPerUnit) {
    const dt = this._t === null ? 0 : Math.max(0, (t - this._t) / 1000)
    this._t = t
    this._kx.predict(dt)
    this._ky.predict(dt)
    this._p[0] = this._kx.update(v[0] * pxPerUnit) / pxPerUnit
    this._p[1] = this._ky.update(v[1] * pxPerUnit) / pxPerUnit
    return this._deadzone.filter(this._p, pxPerUnit)
  }
}
