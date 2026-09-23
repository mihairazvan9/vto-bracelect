/**
 * The invisible walls: two planes across the arm, at the two ends of the
 * procedural arm tube. Between them a bracelet moves freely (sliding, sagging,
 * tilting as its physics mode allows); it can never pass either plane, so it
 * can never leave the tube - onto the hand, or off the end of the modelled
 * forearm.
 *
 * Shared by the solvers that enforce them, the occluder tube they bound, and
 * the debug overlay that draws them, so the three can never disagree.
 * Physics only: the planes are never rendered (except in debug) and never
 * occlude anything.
 */

/** Start plane: just below the wrist crease, mm along the forearm. */
export const WALL_NEAR_MM = 6
/** End plane: just inside the far end of the tube, mm along the forearm. */
export const WALL_FAR_MM = 84

/**
 * Where the arm tube itself starts, mm along the forearm (negative = onto the
 * hand). Only a short lip past the start plane: nothing can sit beyond it, so
 * a longer stretch into the palm only showed as a wrong-looking top.
 */
export const TUBE_START_MM = -4
