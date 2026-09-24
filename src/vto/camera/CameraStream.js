/**
 * No frame callback for this long (a hidden tab, a browser that throttles
 * them) means the callback is not driving frames any more; fall back.
 */
const FRAME_CALLBACK_STALE_MS = 250

/**
 * Camera acquisition. Keeps a <video> alive and exposes the frame timestamp so
 * perception never re-processes the same frame twice.
 */
export class CameraStream {
  constructor() {
    this.video = document.createElement('video')
    this.video.playsInline = true
    this.video.muted = true
    this.video.autoplay = true
    // Some browsers throttle decoding for a detached <video>, and both the
    // perception layer and the background texture need every frame. Keeping it
    // in the document offscreen is the reliable way to get them.
    Object.assign(this.video.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '-1',
    })
    document.body.appendChild(this.video)
    this.stream = null
    this.facingMode = 'user'
    this.lastFrameTime = -1
    /** requestVideoFrameCallback metadata of the latest presented frame, or null. */
    this.frameMeta = null
    this._metaAt = -Infinity
    this._lastPresented = -1
    this._arrivals = []
    this._frameWatch = 0
    /** Snapshot of the latest presented frame, not yet taken (see takeFrame). */
    this._pending = null
  }

  /**
   * When the frame on screen was captured, in ms: the camera's own capture
   * time where the browser reports it, else the frame's media time, else
   * `fallback` (render-loop time). One source for the whole stream, so the
   * spacing between frames is always measured on the same clock.
   */
  frameTimeMs(fallback) {
    const m = this.frameMeta
    if (this.frameTimeSource === 'capture' && m?.captureTime > 0) return m.captureTime
    if (this.frameTimeSource === 'media' && Number.isFinite(m?.mediaTime)) return m.mediaTime * 1000
    return fallback
  }

  get frameTimeSource() {
    if (!this._timeSource && this.frameMeta) {
      this._timeSource = this.frameMeta.captureTime > 0 ? 'capture'
        : Number.isFinite(this.frameMeta.mediaTime) ? 'media' : 'render'
    }
    return this._timeSource ?? 'render'
  }

  /**
   * Frames per second the camera is actually delivering (over the last ~30
   * frames), or 0 when unknown. Webcams quietly halve it in dim light.
   */
  get cameraFps() {
    const a = this._arrivals
    if (a.length < 6 || performance.now() - a[a.length - 1] > 500) return 0
    return ((a.length - 1) * 1000) / (a[a.length - 1] - a[0])
  }

  /** What the browser says the track is running at: width, height, frameRate. */
  get trackSettings() {
    const s = this.stream?.getVideoTracks?.()[0]?.getSettings?.()
    return s ? { width: s.width, height: s.height, frameRate: s.frameRate } : null
  }

  /** Keep frameMeta current, for as long as this stream is the live one. */
  _watchFrames() {
    const video = this.video
    if (typeof video.requestVideoFrameCallback !== 'function') return
    const generation = ++this._frameWatch
    const onFrame = (_now, meta) => {
      if (generation !== this._frameWatch || !this.stream) return
      this.frameMeta = meta
      this._metaAt = performance.now()
      this._arrivals.push(this._metaAt)
      if (this._arrivals.length > 31) this._arrivals.shift()
      this._snapshot()
      video.requestVideoFrameCallback(onFrame)
    }
    video.requestVideoFrameCallback(onFrame)
  }

  /**
   * Freeze the frame just presented, from inside its frame callback, so the
   * snapshot is exactly the frame `frameMeta` describes. A frame nobody took
   * (processing ran long) is released for the newer one.
   */
  _snapshot() {
    this._pending?.close()
    this._pending = null
    if (typeof VideoFrame !== 'function') return
    try {
      const f = new VideoFrame(this.video)
      // A frame carrying rotation (some mobile cameras) would disagree with the
      // video element's size, which everything is laid out on: use the element.
      if (f.displayWidth === this.width && f.displayHeight === this.height) this._pending = f
      else f.close()
    } catch {
      // no data yet: takeFrame falls back to the element
    }
  }

  /**
   * The camera frame to process, as one immutable image: the hand detector,
   * the arm network, the mask refinement, the lighting and the background all
   * read this same snapshot. Read from the live <video> instead, each stage got
   * whatever frame was current when IT ran - detection takes 15-35 ms, so the
   * background was regularly a frame newer than the pose drawn on it.
   *
   * The caller owns the result and must close() it once the frame is off
   * screen. Falls back to the <video> element (close is then a no-op) where
   * VideoFrame is unavailable.
   *
   * @returns {{image: VideoFrame|HTMLVideoElement, width: number, height: number, close: () => void}}
   */
  takeFrame() {
    let f = this._pending
    this._pending = null
    // Callbacks stalled (see hasNewFrame): the snapshot is of a frame long gone.
    if (f && performance.now() - this._metaAt >= FRAME_CALLBACK_STALE_MS) {
      f.close()
      f = null
    }
    if (f) return { image: f, width: f.displayWidth, height: f.displayHeight, close: () => f.close() }
    return { image: this.video, width: this.width, height: this.height, close() {} }
  }

  get width() {
    return this.video.videoWidth || 0
  }

  get height() {
    return this.video.videoHeight || 0
  }

  get mirrored() {
    return this.facingMode === 'user'
  }

  get ready() {
    return this.video.readyState >= 2 && this.width > 0
  }

  async start({ facingMode = 'user', width = 1280, height = 720 } = {}) {
    await this.stop()
    this.facingMode = facingMode
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode,
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 60, min: 24 },
      },
    })
    this.video.srcObject = this.stream
    await this.video.play()
    await new Promise((resolve) => {
      if (this.ready) return resolve()
      this.video.addEventListener('loadeddata', resolve, { once: true })
    })
    this.frameMeta = null
    this._metaAt = -Infinity
    this._lastPresented = -1
    this._arrivals = []
    this._timeSource = null
    this._watchFrames()
    return this
  }

  async flip() {
    return this.start({ facingMode: this.facingMode === 'user' ? 'environment' : 'user' })
  }

  /**
   * True when the video has advanced since the last call.
   *
   * With requestVideoFrameCallback this is exactly "the browser presented a
   * new camera frame", so each frame is processed once and frameMeta
   * describes it. Watching currentTime alone disagreed with the frame
   * callbacks on ~4 % of frames in a recorded session (a frame read twice, or
   * under the previous frame's timestamp). currentTime remains the fallback
   * where the callback is missing or has stalled.
   */
  hasNewFrame() {
    const t = this.video.currentTime
    const meta = this.frameMeta
    if (meta && performance.now() - this._metaAt < FRAME_CALLBACK_STALE_MS) {
      if (meta.presentedFrames === this._lastPresented) return false
      this._lastPresented = meta.presentedFrames
      this.lastFrameTime = t
      return true
    }
    if (t === this.lastFrameTime) return false
    this.lastFrameTime = t
    return true
  }

  async stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    this.video.srcObject = null
    this.lastFrameTime = -1
    this._pending?.close()
    this._pending = null
  }

  destroy() {
    this.stop()
    this.video.remove()
  }
}
