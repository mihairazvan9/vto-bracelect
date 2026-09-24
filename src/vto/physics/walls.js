/**
 * The invisible walls: where the physics arm stops being a forearm.
 *
 * They used to be two planes across the arm, and a bracelet that slid down
 * stood square against the one at the wrist - resting on nothing. Now the arm
 * the physics sees FLARES past the wrist the way a hand does: wider across the
 * palm (the hand is flat, so no thicker), so a piece slides until it is as wide
 * as the hand there and wedges on the flare's slope, tilted by it - on the
 * heel of the hand, not on a wall. The forearm end flares gently too, as an
 * arm widens toward the elbow. Two planes remain far out as backstops only.
 *
 * Shared by the solvers that enforce them (through armTube.js), the occluder
 * tube they bound, and the debug overlay that draws them, so they can never
 * disagree. Physics only: never rendered (except in debug), never occluding.
 */

/** Where the hand flare starts, mm along the forearm: just below the wrist crease. */
export const HAND_FLARE_FROM_MM = 6
/**
 * How fast the hand flare widens: mm of half-width per mm toward the hand
 * (~39 deg). Across the heel of the hand the palm widens that steeply.
 */
export const HAND_FLARE_SLOPE = 0.8
/** The flare stops widening at this fraction of the hand's breadth (half-width). */
export const HAND_FLARE_MAX_PER_BREADTH = 0.45

/** Where the forearm-end flare starts, mm along the forearm. */
export const ELBOW_FLARE_FROM_MM = 72
/** Its widening, mm of half-width and half-thickness per mm toward the elbow. */
export const ELBOW_FLARE_SLOPE = 0.3

/**
 * Backstop planes, mm along the forearm: nothing reaches them unless it is
 * bigger than the hand (or the flares failed). They keep the simulation on
 * the modelled stretch of arm whatever happens.
 */
export const BACKSTOP_NEAR_MM = -25
export const BACKSTOP_FAR_MM = 110


/**
 * The flares' addition to the arm's section at station s: `out.a` to the
 * half-width (radial), `out.b` to the half-thickness (dorsal), mm.
 *
 * @param {number} s        station along the forearm, mm
 * @param {number} a        the arm's own half-width there, mm
 * @param {number} handBreadthMm
 * @param {{a:number,b:number}} out
 */
export function flareAt(s, a, handBreadthMm, out) {
  out.a = 0
  out.b = 0
  if (s < HAND_FLARE_FROM_MM) {
    const cap = Math.max(a, HAND_FLARE_MAX_PER_BREADTH * handBreadthMm)
    out.a = Math.min(cap, a + HAND_FLARE_SLOPE * (HAND_FLARE_FROM_MM - s)) - a
  } else if (s > ELBOW_FLARE_FROM_MM) {
    out.a = ELBOW_FLARE_SLOPE * (s - ELBOW_FLARE_FROM_MM)
    out.b = out.a
  }
  return out
}
