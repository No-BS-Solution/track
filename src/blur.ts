// Camera background blur. MediaPipe's selfie segmenter finds the person in each frame on-device; the frame is
// redrawn as a blurred copy with the sharp person on top, and the canvas becomes the outgoing video track.
// The runtime (public/mediapipe, copied from node_modules at build) and model (public/models) are served
// from our own origin, and only downloaded when blur is first turned on.

const BLUR_PX = 14
const FRAME_MS = 40 // ~25 fps

/** Canvas `filter` is what does the blurring; very old Safari lacks it. */
export const blurSupported = (() => {
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return false
    ctx.filter = 'blur(1px)'
    return ctx.filter === 'blur(1px)'
  } catch {
    return false
  }
})()

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

export type Blurred = { track: MediaStreamTrack; stop: () => void }

export async function blurTrack(input: MediaStreamTrack): Promise<Blurred> {
  const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
  const base = import.meta.env.BASE_URL
  const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe`)
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: `${base}models/selfie_segmenter.tflite`, delegate },
    runningMode: 'VIDEO' as const,
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  })
  const segmenter = await ImageSegmenter.createFromOptions(fileset, options('GPU')).catch(() =>
    ImageSegmenter.createFromOptions(fileset, options('CPU')),
  )

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([input])
  await video.play()
  const w = video.videoWidth || 640
  const h = video.videoHeight || 480

  const out = canvas(w, h)
  const person = canvas(w, h)
  const mask = canvas(1, 1)
  const outCtx = out.getContext('2d')!
  const personCtx = person.getContext('2d')!
  const maskCtx = mask.getContext('2d')!

  let running = true
  let lastTime = -1
  let timer = 0
  const frame = () => {
    if (!running) return
    if (video.readyState >= 2 && video.currentTime !== lastTime) {
      lastTime = video.currentTime
      const result = segmenter.segmentForVideo(video, performance.now())
      const conf = result.confidenceMasks?.[0]
      if (conf) {
        // Person confidence (0..1) becomes the alpha channel of a mask image.
        const data = conf.getAsFloat32Array()
        if (mask.width !== conf.width || mask.height !== conf.height) {
          mask.width = conf.width
          mask.height = conf.height
        }
        const img = maskCtx.createImageData(conf.width, conf.height)
        for (let i = 0; i < data.length; i++) img.data[i * 4 + 3] = data[i] * 255
        maskCtx.putImageData(img, 0, 0)
      }
      result.close()

      // Sharp person: soft-edged mask, then the frame drawn only where the mask is.
      personCtx.globalCompositeOperation = 'copy'
      personCtx.filter = 'blur(2px)'
      personCtx.drawImage(mask, 0, 0, w, h)
      personCtx.filter = 'none'
      personCtx.globalCompositeOperation = 'source-in'
      personCtx.drawImage(video, 0, 0, w, h)

      // Blurred room, person on top.
      // Drawn oversized so the blur doesn't pull transparent pixels in from outside the frame (pale edges).
      const pad = BLUR_PX * 2
      outCtx.globalCompositeOperation = 'copy'
      outCtx.filter = `blur(${BLUR_PX}px)`
      outCtx.drawImage(video, -pad, -pad, w + pad * 2, h + pad * 2)
      outCtx.filter = 'none'
      outCtx.globalCompositeOperation = 'source-over'
      outCtx.drawImage(person, 0, 0)
    }
    // A timer rather than requestAnimationFrame, which stops when the tab is in the background
    // (pages with a live call are not throttled, so this keeps running while you share another window).
    timer = window.setTimeout(frame, FRAME_MS)
  }
  frame()

  const track = out.captureStream(25).getVideoTracks()[0]
  return {
    track,
    stop: () => {
      running = false
      clearTimeout(timer)
      track.stop()
      segmenter.close()
      video.srcObject = null
    },
  }
}
