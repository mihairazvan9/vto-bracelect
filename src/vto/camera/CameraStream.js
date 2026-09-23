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
    return this
  }

  async flip() {
    return this.start({ facingMode: this.facingMode === 'user' ? 'environment' : 'user' })
  }

  /** True when the video has advanced since the last call. */
  hasNewFrame() {
    const t = this.video.currentTime
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
  }

  destroy() {
    this.stop()
    this.video.remove()
  }
}
