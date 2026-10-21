/**
 * Zoom's encoder reads frames through `MediaStreamTrackProcessor` and keeps
 * only I420 and NV12. `canvas.captureStream()` is often I420A, and Chrome
 * refuses `copyTo({ format: 'I420' })` for that layout, so the alpha plane is
 * dropped from the native YUV. Other layouts are drawn and encoded as I420.
 * Meet, Jitsi and Telemost stay on the canvas track.
 */

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>
}

interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>
}

interface InsertableStreams {
  MediaStreamTrackGenerator: new (init: { kind: 'audio' | 'video' }) => TrackGenerator
  MediaStreamTrackProcessor: new (init: { maxBufferSize?: number, track: MediaStreamTrack }) => TrackProcessor
}

interface PlaneCopy {
  dest: Uint8Array
  height: number
  offset: number
  plane: PlaneLayout
  source: Uint8Array
  width: number
}

interface Nv12Plane {
  buffer: Uint8Array
  chromaHeight: number
  chromaWidth: number
  source: Uint8Array
  uv: PlaneLayout
  ySize: number
}

const insertable = globalThis as Partial<InsertableStreams>

const limited709: VideoColorSpaceInit = {
  fullRange: false,
  matrix: 'bt709',
  primaries: 'bt709',
  transfer: 'bt709',
}

let warned = false
let pixelsCanvas: OffscreenCanvas | null = null
let pixelsCtx: OffscreenCanvasRenderingContext2D | null = null

function warnOnce(message: string, error?: unknown) {
  if (warned) return
  warned = true
  console.warn(message, error)
}

function supportsInsertableStreams() {
  return typeof insertable.MediaStreamTrackProcessor === 'function' && typeof insertable.MediaStreamTrackGenerator === 'function'
}

const even = (size: number) => size & ~1

const clampByte = (value: number) => Math.min(255, Math.max(0, value))

function rgbAt(pixels: Uint8ClampedArray, index: number) {
  const alpha = (pixels[index + 3] ?? 255) / 255
  return {
    b: (pixels[index + 2] ?? 0) * alpha,
    g: (pixels[index + 1] ?? 0) * alpha,
    r: (pixels[index] ?? 0) * alpha,
  }
}

const luma = (r: number, g: number, b: number) => ((47 * r + 157 * g + 16 * b + 128) >> 8) + 16

function chromaOf(r: number, g: number, b: number) {
  return {
    u: clampByte(((-26 * r - 86 * g + 112 * b + 128) >> 8) + 128),
    v: clampByte(((112 * r - 102 * g - 10 * b + 128) >> 8) + 128),
  }
}

function frameFromI420(buffer: Uint8Array, frame: VideoFrame, colorSpace?: VideoColorSpaceInit) {
  const codedWidth = even(frame.codedWidth)
  const codedHeight = even(frame.codedHeight)
  const displayWidth = Math.min(even(frame.displayWidth) || codedWidth, codedWidth)
  const displayHeight = Math.min(even(frame.displayHeight) || codedHeight, codedHeight)
  const next = new VideoFrame(buffer, {
    codedHeight,
    codedWidth,
    colorSpace: colorSpace ?? frame.colorSpace.toJSON(),
    displayHeight,
    displayWidth,
    format: 'I420',
    timestamp: frame.timestamp,
    ...(frame.duration == null ? {} : { duration: frame.duration }),
  })
  try {
    frame.close()
  } catch {
    // The source frame can already be closed.
  }
  return next
}

function copyPlane(copy: PlaneCopy) {
  const { dest, height, offset, plane, source, width } = copy
  const rowBytes = Math.min(plane.stride, width)
  for (let y = 0; y < height; y++) {
    const from = plane.offset + y * plane.stride
    dest.set(source.subarray(from, from + rowBytes), offset + y * width)
  }
}

function unpackNv12(spec: Nv12Plane) {
  const { buffer, chromaHeight, chromaWidth, source, uv, ySize } = spec
  const uOffset = ySize
  const vOffset = ySize + chromaWidth * chromaHeight
  for (let row = 0; row < chromaHeight; row++) {
    const start = uv.offset + row * uv.stride
    for (let col = 0; col < chromaWidth; col++) {
      const pixel = start + col * 2
      buffer[uOffset + row * chromaWidth + col] = source[pixel] ?? 128
      buffer[vOffset + row * chromaWidth + col] = source[pixel + 1] ?? 128
    }
  }
}

function rgbaToI420(pixels: Uint8ClampedArray, width: number, height: number) {
  const ySize = width * height
  const chromaWidth = width >> 1
  const chromaHeight = height >> 1
  const buffer = new Uint8Array(ySize + chromaWidth * chromaHeight * 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { b, g, r } = rgbAt(pixels, (y * width + x) * 4)
      buffer[y * width + x] = luma(r, g, b)
    }
  }
  const uOffset = ySize
  const vOffset = ySize + chromaWidth * chromaHeight
  for (let y = 0; y < chromaHeight; y++) {
    for (let x = 0; x < chromaWidth; x++) {
      const { b, g, r } = rgbAt(pixels, (y * 2 * width + x * 2) * 4)
      const sample = chromaOf(r, g, b)
      const chroma = y * chromaWidth + x
      buffer[uOffset + chroma] = sample.u
      buffer[vOffset + chroma] = sample.v
    }
  }
  return buffer
}

async function convertByFormat(frame: VideoFrame) {
  const codedWidth = even(frame.codedWidth)
  const codedHeight = even(frame.codedHeight)
  const copy: VideoFrameCopyToOptions = {
    format: 'I420',
    rect: { height: codedHeight, width: codedWidth, x: 0, y: 0 },
  }
  const buffer = new Uint8Array(frame.allocationSize(copy))
  await frame.copyTo(buffer, copy)
  return frameFromI420(buffer, frame)
}

async function stripPacked(frame: VideoFrame) {
  const codedWidth = even(frame.codedWidth)
  const codedHeight = even(frame.codedHeight)
  const rect = { height: codedHeight, width: codedWidth, x: 0, y: 0 }
  const source = new Uint8Array(frame.allocationSize({ rect }))
  const planes = await frame.copyTo(source, { rect })
  if (planes.length < 2) return null
  const y = planes[0]
  if (!y) return null
  const ySize = codedWidth * codedHeight
  const chromaWidth = codedWidth >> 1
  const chromaHeight = codedHeight >> 1
  const buffer = new Uint8Array(ySize + chromaWidth * chromaHeight * 2)
  copyPlane({ dest: buffer, height: codedHeight, offset: 0, plane: y, source, width: codedWidth })
  if (planes.length >= 3) {
    const u = planes[1]
    const v = planes[2]
    if (!u || !v) return null
    const chromaSize = chromaWidth * chromaHeight
    copyPlane({ dest: buffer, height: chromaHeight, offset: ySize, plane: u, source, width: chromaWidth })
    copyPlane({ dest: buffer, height: chromaHeight, offset: ySize + chromaSize, plane: v, source, width: chromaWidth })
    return frameFromI420(buffer, frame)
  }
  const uv = planes[1]
  if (!uv) return null
  unpackNv12({ buffer, chromaHeight, chromaWidth, source, uv, ySize })
  return frameFromI420(buffer, frame)
}

function pixelContext(width: number, height: number) {
  if (!pixelsCanvas || pixelsCanvas.width !== width || pixelsCanvas.height !== height) {
    pixelsCanvas = new OffscreenCanvas(width, height)
    pixelsCtx = pixelsCanvas.getContext('2d', { willReadFrequently: true })
  }
  return pixelsCtx
}

function fromPixels(frame: VideoFrame) {
  const codedWidth = even(frame.codedWidth)
  const codedHeight = even(frame.codedHeight)
  const ctx = pixelContext(codedWidth, codedHeight)
  if (!ctx) return null
  ctx.clearRect(0, 0, codedWidth, codedHeight)
  ctx.drawImage(frame, 0, 0, codedWidth, codedHeight)
  const pixels = ctx.getImageData(0, 0, codedWidth, codedHeight).data
  return frameFromI420(rgbaToI420(pixels, codedWidth, codedHeight), frame, limited709)
}

async function tryConvert(frame: VideoFrame) {
  // I420A → I420 via copyTo throws NotSupportedError in Chrome.
  if (frame.format !== 'I420A') {
    try {
      return await convertByFormat(frame)
    } catch {
      // This layout has no libyuv conversion to I420.
    }
  }
  try {
    const stripped = await stripPacked(frame)
    if (stripped) return stripped
  } catch {
    // The native layout is not planar YUV.
  }
  return fromPixels(frame)
}

async function convertFrame(frame: VideoFrame) {
  if (frame.format === 'I420') return frame
  if (even(frame.codedWidth) < 2 || even(frame.codedHeight) < 2) {
    frame.close()
    return null
  }
  try {
    const next = await tryConvert(frame)
    if (next) return next
  } catch (error) {
    warnOnce('[meet-thanos] I420 conversion failed', error)
  }
  try {
    frame.close()
  } catch {
    // The source frame can already be closed.
  }
  return null
}

function connectOpaque(canvasTrack: MediaStreamTrack) {
  const Processor = insertable.MediaStreamTrackProcessor
  const Generator = insertable.MediaStreamTrackGenerator
  if (!Processor || !Generator) return canvasTrack
  const processor = new Processor({ maxBufferSize: 1, track: canvasTrack })
  const generator = new Generator({ kind: 'video' })
  let stopped = false
  const nativeStop = generator.stop.bind(generator)
  const stopBoth = () => {
    if (stopped) return
    stopped = true
    try {
      nativeStop()
    } catch {
      // The generator can already be ended.
    }
    try {
      canvasTrack.stop()
    } catch {
      // The canvas capture can already be ended.
    }
  }
  generator.stop = () => {
    stopBoth()
  }
  canvasTrack.addEventListener('ended', stopBoth)

  // The readable watermark defaults to 0, so desiredSize stays 0 until a
  // consumer pulls and every frame would be dropped, including the one that
  // unmutes the generator. 1 keeps a single frame and skips the rest while
  // Zoom is behind.
  const transformer = new TransformStream<VideoFrame, VideoFrame>({
    async transform(frame, controller) {
      if (controller.desiredSize != null && controller.desiredSize <= 0) {
        frame.close()
        return
      }
      try {
        const next = await convertFrame(frame)
        if (!next) return
        try {
          controller.enqueue(next)
        } catch (error) {
          next.close()
          throw error
        }
      } catch (error) {
        try {
          frame.close()
        } catch {
          // convertFrame already closed it.
        }
        warnOnce('[meet-thanos] I420 conversion failed', error)
      }
    },
  }, { highWaterMark: 1 }, { highWaterMark: 1 })

  void processor.readable.pipeThrough(transformer).pipeTo(generator.writable).catch(() => {
    stopBoth()
  })
  return generator
}

export function toOpaqueVideoTrack(canvasTrack: MediaStreamTrack) {
  if (!supportsInsertableStreams()) {
    warnOnce('[meet-thanos] insertable streams unavailable, Zoom may drop canvas frames')
    return canvasTrack
  }
  try {
    return connectOpaque(canvasTrack)
  } catch (error) {
    warnOnce('[meet-thanos] insertable streams unavailable, Zoom may drop canvas frames', error)
    return canvasTrack
  }
}
