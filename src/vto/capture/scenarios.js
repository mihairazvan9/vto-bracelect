/**
 * The guided recording script: what each test clip must contain.
 *
 * Every scenario exercises one thing the tracker or the physics has to get
 * right, and states that as a MOTION REQUIREMENT the coach measures while the
 * take runs. A take only counts once its requirement has been seen, so a clip
 * called "turn" really contains a turn, not four seconds of a hand waiting.
 *
 * Requirement kinds (measured in CaptureSession, all from the live pipeline):
 *   still     seconds with the arm still (wrist < stillMmS, spin < stillRadS)
 *   twist     degrees of forearm roll covered, plus a change of direction
 *   bend      degrees the hand axis swings from where the take started
 *   swing     degrees the forearm's image direction sweeps
 *   depth     ratio of farthest to nearest distance
 *   flick     a fast shake, then `holdS` seconds still
 *   sideOn    seconds with the palm edge-on (roll above `minRollDeg`)
 *   sleeve    seconds with a sleeve detected on the forearm
 *   duration  just enough well-framed seconds (free movement)
 */
export const SCENARIOS = [
  {
    id: 'still',
    title: 'Hold still',
    instruction: 'Back of your hand to the camera. Hold your arm still.',
    why: 'Jitter on a still arm: what a customer notices first.',
    need: { kind: 'still', seconds: 6 },
    maxS: 14,
  },
  {
    id: 'turn',
    title: 'Slow wrist turn',
    instruction: 'Slowly turn your palm up, then back down. Keep the forearm in view.',
    why: 'Roll around the arm - the noisiest thing we track.',
    need: { kind: 'twist', degrees: 110 },
    maxS: 16,
  },
  {
    id: 'bend',
    title: 'Wrist bend',
    instruction: 'Keep your forearm still. Bend only your wrist up and down.',
    why: 'The bracelet must follow the forearm, not the palm.',
    need: { kind: 'bend', degrees: 40 },
    maxS: 14,
  },
  {
    id: 'swing',
    title: 'Forearm swing',
    instruction: 'Swing your whole forearm slowly left and right, like a wiper.',
    why: 'Whole-arm motion the forearm tracker must follow.',
    need: { kind: 'swing', degrees: 35 },
    maxS: 14,
  },
  {
    id: 'depth',
    title: 'Closer and further',
    instruction: 'Bring your wrist toward the camera, then back again.',
    why: 'Distance changes: size must not pump or lag.',
    need: { kind: 'depth', ratio: 1.35 },
    maxS: 14,
  },
  {
    id: 'flick',
    title: 'Shake, then hold',
    instruction: 'Give your wrist a quick shake, then hold it perfectly still.',
    why: 'How the bracelet swings and settles after motion.',
    need: { kind: 'flick', speedMmS: 450, holdS: 2.5 },
    maxS: 14,
  },
  {
    id: 'side',
    title: 'Side-on',
    instruction: 'Turn your hand sideways, thumb toward the camera, and hold.',
    why: 'Edge-on view: wrist depth and the arm edge case.',
    need: { kind: 'sideOn', seconds: 3.5, minRollDeg: 55 },
    maxS: 14,
  },
  {
    id: 'sleeve',
    title: 'Sleeve',
    instruction: 'Pull your sleeve down to cover part of your forearm.',
    why: 'Where the arm stops being visible.',
    need: { kind: 'sleeve', seconds: 3 },
    maxS: 16,
    optional: true,
  },
  {
    id: 'natural',
    title: 'Free try-on',
    instruction: 'Look at the bracelet as you would in a shop: turn, tilt, move.',
    why: 'Real behaviour, mixed motion.',
    need: { kind: 'duration', seconds: 18 },
    maxS: 24,
  },
]

export function getScenario(id) {
  return SCENARIOS.find((s) => s.id === id) ?? null
}
