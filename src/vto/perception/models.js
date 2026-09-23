/**
 * Model + runtime locations. All overridable so the whole stack can be
 * self-hosted (no third-party CDN at runtime) for a production deployment.
 */
export const DEFAULT_MODEL_CONFIG = {
  wasmPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
  handLandmarker:
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  // Multiclass selfie segmentation gives us skin vs. clothing, which is exactly
  // the hand / forearm / sleeve split the wrist solver needs.
  segmenter: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  // segmenter: '/selfie_multiclass_256x256_dyn8_meta.tflite',
  delegate: 'GPU',
}

/**
 * Pose landmarking was tried here and removed. For bracelet try-on the wrist is
 * held close to the camera, so the elbow and shoulder are routinely out of
 * frame or poorly estimated. The forearm axis it produced was worse than the
 * palm-derived one, and it cost a whole extra model in the frame budget.
 */

/** selfie_multiclass_256x256 category ids. */
export const SEG_CLASS = {
  BACKGROUND: 0,
  HAIR: 1,
  BODY_SKIN: 2,
  FACE_SKIN: 3,
  CLOTHES: 4,
  OTHERS: 5,
}

/** MediaPipe hand landmark indices we actually rely on. */
export const HAND = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  INDEX_MCP: 5,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
  PINKY_MCP: 17,
}

/** MediaPipe hand skeleton, for the debug overlay. */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]
