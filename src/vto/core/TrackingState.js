export const TrackingState = {
  LOST: 'LOST',
  DEGRADED: 'DEGRADED',
  GOOD: 'GOOD',
  EXCELLENT: 'EXCELLENT',
}

const ORDER = [TrackingState.LOST, TrackingState.DEGRADED, TrackingState.GOOD, TrackingState.EXCELLENT]

/**
 * Hysteretic tracking-quality state machine.
 *
 * Rendering a $10k bracelet on a bad pose looks worse than not rendering it, but
 * so does a hard visible=false. This drives a continuous `presence` value that
 * the renderer fades with, plus a discrete state the solvers use to decide how
 * aggressively to trust new observations.
 */
export class TrackingStateMachine {
  constructor({
    enterExcellent = 0.82,
    exitExcellent = 0.7,
    enterGood = 0.55,
    exitGood = 0.4,
    enterDegraded = 0.25,
    lostAfterMs = 450,
    fadeInMs = 220,
    fadeOutMs = 320,
  } = {}) {
    Object.assign(this, {
      enterExcellent, exitExcellent, enterGood, exitGood,
      enterDegraded, lostAfterMs, fadeInMs, fadeOutMs,
    })
    this.state = TrackingState.LOST
    this.presence = 0
    this.lastObservationTime = -Infinity
    this.confidence = 0
    /**
     * Keep the jewellery hidden whatever the state (the tracker holds it
     * while a new track is still locking on; see WristTracker warm-up).
     */
    this.hold = false
  }

  /** Called whenever perception produced a usable hand. */
  observe(confidence, timestamp) {
    this.confidence = confidence
    this.lastObservationTime = timestamp
  }

  /** Called every render frame. */
  update(timestamp, dt) {
    const age = timestamp - this.lastObservationTime
    const c = this.confidence

    let next = this.state
    if (age > this.lostAfterMs) {
      next = TrackingState.LOST
    } else if (this.state === TrackingState.EXCELLENT) {
      next = c < this.exitExcellent ? TrackingState.GOOD : TrackingState.EXCELLENT
    } else if (this.state === TrackingState.GOOD) {
      if (c >= this.enterExcellent) next = TrackingState.EXCELLENT
      else if (c < this.exitGood) next = TrackingState.DEGRADED
    } else if (this.state === TrackingState.DEGRADED) {
      if (c >= this.enterGood) next = TrackingState.GOOD
    } else if (c >= this.enterDegraded) {
      next = TrackingState.DEGRADED
    }
    this.state = next

    const target = next === TrackingState.LOST || this.hold ? 0 : next === TrackingState.DEGRADED ? 0.65 : 1
    const rate = target > this.presence ? dt / (this.fadeInMs / 1000) : dt / (this.fadeOutMs / 1000)
    this.presence += Math.sign(target - this.presence) * Math.min(Math.abs(target - this.presence), rate)
    this.presence = Math.max(0, Math.min(1, this.presence))

    return this.state
  }

  get rank() {
    return ORDER.indexOf(this.state)
  }

  /** How far ahead the pose predictor is allowed to extrapolate, in ms. */
  get predictionBudgetMs() {
    switch (this.state) {
      case TrackingState.EXCELLENT: return 120
      case TrackingState.GOOD: return 160
      case TrackingState.DEGRADED: return 260
      default: return 0
    }
  }

  reset() {
    this.state = TrackingState.LOST
    this.presence = 0
    this.confidence = 0
    this.lastObservationTime = -Infinity
  }
}
