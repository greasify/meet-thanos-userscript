import type { EffectId } from '../effects'
import {
  BLUR_FRAGMENT_SHADER,
  EFFECT_FRAGMENT_SHADER,
  FULLSCREEN_VERTEX_SHADER,
  MASK_FRAGMENT_SHADER,
  NORMALIZE_FRAGMENT_SHADER,
  PARTICLE_FRAGMENT_SHADER,
  PARTICLE_VERTEX_SHADER,
} from './shaders'

const DEFAULT_MASK_WIDTH = 320
const DEFAULT_PARTICLE_COUNT = 1400
const DEFAULT_DIFF_THRESHOLD = 70 / 255

const EFFECT_INDEX: Record<EffectId, number> = {
  burn: 1,
  dust: 0,
  ghost: 2,
  hedge: 5,
  melt: 3,
  portal: 4,
}

export interface GlRendererOptions {
  diffThreshold?: number
  height: number
  maskWidth?: number
  particleCount?: number
  width: number
}

export interface GlRenderFrame {
  active: boolean
  e: number
  effect: EffectId
  gone: boolean
  /** Time in seconds. */
  time: number
  vanishing: boolean
  video: HTMLVideoElement
}

interface TextureOptions {
  filter: number
  format: number
  height: number
  internalFormat: number
  width: number
}

interface Program {
  handle: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation>
}

interface Resources {
  backgroundFramebuffer: WebGLFramebuffer
  backgroundTexture: WebGLTexture
  backgroundUploadTexture: WebGLTexture
  blurProgram: Program
  effectProgram: Program
  fullscreenVao: WebGLVertexArrayObject
  maskAFramebuffer: WebGLFramebuffer
  maskATexture: WebGLTexture
  maskBFramebuffer: WebGLFramebuffer
  maskBTexture: WebGLTexture
  maskProgram: Program
  normalizeProgram: Program
  particleBuffer: WebGLBuffer
  particleProgram: Program
  particleVao: WebGLVertexArrayObject
  videoTexture: WebGLTexture
}

interface TimerQueryExtension {
  GPU_DISJOINT_EXT: number
  TIME_ELAPSED_EXT: number
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

function compileShader(gl: WebGL2RenderingContext, spec: { source: string, type: number }) {
  const shader = gl.createShader(spec.type)
  if (!shader) throw new Error('Unable to create WebGL shader')
  gl.shaderSource(shader, spec.source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  const message = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error'
  gl.deleteShader(shader)
  throw new Error(message)
}

function createProgram(gl: WebGL2RenderingContext, shaders: { fragment: string, vertex: string }): Program {
  const vertex = compileShader(gl, { source: shaders.vertex, type: gl.VERTEX_SHADER })
  const fragment = compileShader(gl, { source: shaders.fragment, type: gl.FRAGMENT_SHADER })
  const handle = gl.createProgram()
  if (!handle) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new Error('Unable to create WebGL program')
  }
  gl.attachShader(handle, vertex)
  gl.attachShader(handle, fragment)
  gl.linkProgram(handle)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (gl.getProgramParameter(handle, gl.LINK_STATUS)) return { handle, uniforms: new Map() }
  const message = gl.getProgramInfoLog(handle) || 'Unknown WebGL program link error'
  gl.deleteProgram(handle)
  throw new Error(message)
}

function createTexture(gl: WebGL2RenderingContext, options: TextureOptions) {
  const texture = gl.createTexture()
  if (!texture) throw new Error('Unable to create WebGL texture')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, options.filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    options.internalFormat,
    options.width,
    options.height,
    0,
    options.format,
    gl.UNSIGNED_BYTE,
    null,
  )
  return texture
}

function createFramebuffer(gl: WebGL2RenderingContext, texture: WebGLTexture) {
  const framebuffer = gl.createFramebuffer()
  if (!framebuffer) throw new Error('Unable to create WebGL framebuffer')
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer)
    throw new Error('Incomplete WebGL framebuffer')
  }
  return framebuffer
}

function createVao(gl: WebGL2RenderingContext) {
  const vao = gl.createVertexArray()
  if (!vao) throw new Error('Unable to create WebGL vertex array')
  return vao
}

function createBuffer(gl: WebGL2RenderingContext) {
  const buffer = gl.createBuffer()
  if (!buffer) throw new Error('Unable to create WebGL buffer')
  return buffer
}

function sourceSize(source: CanvasImageSource) {
  const sized = source as unknown as Record<string, unknown>
  const numeric = (name: string) => {
    const value = sized[name]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  const width = numeric('videoWidth') || numeric('naturalWidth') || numeric('displayWidth') || numeric('width')
  const height = numeric('videoHeight') || numeric('naturalHeight') || numeric('displayHeight') || numeric('height')
  if (width <= 0 || height <= 0) throw new Error('Background source has no drawable size')
  return { height, width }
}

function makeParticleData(count: number) {
  const data = new Float32Array(count * 4)
  let state = 0x6D2B79F5
  const random = () => {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  for (let index = 0; index < data.length; index++) data[index] = random()
  return data
}

function uniform(gl: WebGL2RenderingContext, program: Program, name: string) {
  const cached = program.uniforms.get(name)
  if (cached) return cached
  const location = gl.getUniformLocation(program.handle, name)
  if (!location) throw new Error(`Missing WebGL uniform: ${name}`)
  program.uniforms.set(name, location)
  return location
}

export class GlRenderer {
  readonly canvas: HTMLCanvasElement

  private backgroundReady = false
  private backgroundSource: CanvasImageSource | null = null
  private contextLost = false
  private destroyed = false
  private readonly diffThreshold: number
  private readonly gl: WebGL2RenderingContext
  private readonly gpuExt: TimerQueryExtension | null
  private readonly gpuPending: WebGLQuery[] = []
  private readonly gpuTimes: number[] = []
  private readonly height: number
  private readonly maskHeight: number
  private readonly maskWidth: number
  private readonly particleCount: number
  private resources: Resources | null = null
  private videoHeight = 0
  private videoWidth = 0
  private readonly width: number

  constructor(options: GlRendererOptions) {
    if (options.width < 1 || options.height < 1) throw new Error('WebGL renderer dimensions must be positive')
    this.width = Math.round(options.width)
    this.height = Math.round(options.height)
    this.maskWidth = Math.max(2, Math.min(this.width, Math.round(options.maskWidth ?? DEFAULT_MASK_WIDTH)))
    this.maskHeight = Math.max(2, Math.round(this.maskWidth * this.height / this.width))
    this.particleCount = Math.max(1, Math.round(options.particleCount ?? DEFAULT_PARTICLE_COUNT))
    this.diffThreshold = options.diffThreshold ?? DEFAULT_DIFF_THRESHOLD

    this.canvas = document.createElement('canvas')
    this.canvas.width = this.width
    this.canvas.height = this.height
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      stencil: false,
    })
    if (!gl) throw new Error('WebGL2 is unavailable')
    this.gl = gl
    this.gpuExt = import.meta.env.DEV
      ? gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExtension | null
      : null
    this.canvas.addEventListener('webglcontextlost', this.onContextLost)
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored)
    this.initialize()
  }

  get lost() {
    return this.contextLost || this.gl.isContextLost()
  }

  updateBackground(source: CanvasImageSource) {
    if (this.destroyed) return
    const size = sourceSize(source)
    this.backgroundSource = source
    if (this.lost || !this.resources) return
    this.uploadBackground(source, size)
  }

  render(frame: GlRenderFrame) {
    if (this.destroyed || this.lost || !this.resources) return
    if (frame.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      || frame.video.videoWidth < 1 || frame.video.videoHeight < 1) {
      return
    }

    const { gl, resources } = this
    const active = frame.active && this.backgroundReady
    this.pollGpuQueries()
    const query = this.gpuExt ? gl.createQuery() : null
    if (query && this.gpuExt) gl.beginQuery(this.gpuExt.TIME_ELAPSED_EXT, query)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    if (!active || !frame.gone) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, resources.videoTexture)
      if (this.videoWidth !== frame.video.videoWidth || this.videoHeight !== frame.video.videoHeight) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, frame.video)
        this.videoWidth = frame.video.videoWidth
        this.videoHeight = frame.video.videoHeight
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, frame.video)
      }
    }

    if (active && !frame.gone) this.renderMask()
    this.renderEffect(frame, active)
    if (active && !frame.gone && this.hasParticles(frame.effect)) this.renderParticles(frame)
    if (query && this.gpuExt) {
      gl.endQuery(this.gpuExt.TIME_ELAPSED_EXT)
      this.gpuPending.push(query)
    }
  }

  flush() {
    if (!this.destroyed && !this.lost) this.gl.flush()
  }

  takeGpuTimes() {
    this.pollGpuQueries()
    return this.gpuTimes.splice(0)
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    this.deleteResources()
    this.backgroundSource = null
    this.backgroundReady = false
  }

  private readonly onContextLost: EventListener = (event) => {
    event.preventDefault()
    this.contextLost = true
    this.resources = null
    this.backgroundReady = false
    this.gpuPending.length = 0
    this.gpuTimes.length = 0
    this.videoHeight = 0
    this.videoWidth = 0
  }

  private readonly onContextRestored = () => {
    if (this.destroyed) return
    this.contextLost = false
    try {
      this.initialize()
      if (this.backgroundSource) this.uploadBackground(this.backgroundSource, sourceSize(this.backgroundSource))
    } catch {
      this.backgroundReady = false
    }
  }

  private initialize() {
    const { gl } = this
    const normalizeProgram = createProgram(gl, {
      fragment: NORMALIZE_FRAGMENT_SHADER,
      vertex: FULLSCREEN_VERTEX_SHADER,
    })
    const maskProgram = createProgram(gl, {
      fragment: MASK_FRAGMENT_SHADER,
      vertex: FULLSCREEN_VERTEX_SHADER,
    })
    const blurProgram = createProgram(gl, {
      fragment: BLUR_FRAGMENT_SHADER,
      vertex: FULLSCREEN_VERTEX_SHADER,
    })
    const effectProgram = createProgram(gl, {
      fragment: EFFECT_FRAGMENT_SHADER,
      vertex: FULLSCREEN_VERTEX_SHADER,
    })
    const particleProgram = createProgram(gl, {
      fragment: PARTICLE_FRAGMENT_SHADER,
      vertex: PARTICLE_VERTEX_SHADER,
    })
    const rgba = {
      filter: gl.LINEAR,
      format: gl.RGBA,
      height: this.height,
      internalFormat: gl.RGBA8,
      width: this.width,
    }
    const mask = {
      filter: gl.LINEAR,
      format: gl.RED,
      height: this.maskHeight,
      internalFormat: gl.R8,
      width: this.maskWidth,
    }
    const videoTexture = createTexture(gl, { ...rgba, height: 1, width: 1 })
    const backgroundUploadTexture = createTexture(gl, { ...rgba, height: 1, width: 1 })
    const backgroundTexture = createTexture(gl, rgba)
    const maskATexture = createTexture(gl, mask)
    const maskBTexture = createTexture(gl, mask)
    const fullscreenVao = createVao(gl)
    const particleVao = createVao(gl)
    const particleBuffer = createBuffer(gl)

    gl.bindVertexArray(particleVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, makeParticleData(this.particleCount), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)

    this.resources = {
      backgroundFramebuffer: createFramebuffer(gl, backgroundTexture),
      backgroundTexture,
      backgroundUploadTexture,
      blurProgram,
      effectProgram,
      fullscreenVao,
      maskAFramebuffer: createFramebuffer(gl, maskATexture),
      maskATexture,
      maskBFramebuffer: createFramebuffer(gl, maskBTexture),
      maskBTexture,
      maskProgram,
      normalizeProgram,
      particleBuffer,
      particleProgram,
      particleVao,
      videoTexture,
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.backgroundReady = false
    this.videoHeight = 0
    this.videoWidth = 0
  }

  private uploadBackground(source: CanvasImageSource, size: { height: number, width: number }) {
    const resources = this.resources
    if (!resources) return
    const { gl } = this
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, resources.backgroundUploadTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource)

    const sourceAspect = size.width / size.height
    const outputAspect = this.width / this.height
    const scaleX = sourceAspect > outputAspect ? outputAspect / sourceAspect : 1
    const scaleY = sourceAspect > outputAspect ? 1 : sourceAspect / outputAspect

    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.backgroundFramebuffer)
    gl.viewport(0, 0, this.width, this.height)
    gl.disable(gl.BLEND)
    gl.useProgram(resources.normalizeProgram.handle)
    gl.uniform1i(uniform(gl, resources.normalizeProgram, 'uSource'), 0)
    gl.uniform2f(uniform(gl, resources.normalizeProgram, 'uScale'), scaleX, scaleY)
    this.drawFullscreen()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.backgroundReady = true
  }

  private renderMask() {
    const resources = this.resources
    if (!resources) return
    const { gl } = this
    gl.viewport(0, 0, this.maskWidth, this.maskHeight)
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.maskAFramebuffer)
    gl.useProgram(resources.maskProgram.handle)
    this.bindTexture(resources.videoTexture, 0)
    this.bindTexture(resources.backgroundTexture, 1)
    gl.uniform1i(uniform(gl, resources.maskProgram, 'uVideo'), 0)
    gl.uniform1i(uniform(gl, resources.maskProgram, 'uBackground'), 1)
    gl.uniform1f(uniform(gl, resources.maskProgram, 'uThreshold'), this.diffThreshold)
    this.drawFullscreen()

    gl.useProgram(resources.blurProgram.handle)
    gl.uniform1i(uniform(gl, resources.blurProgram, 'uSource'), 0)
    gl.uniform2f(
      uniform(gl, resources.blurProgram, 'uTexel'),
      1 / this.maskWidth,
      1 / this.maskHeight,
    )

    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.maskBFramebuffer)
    this.bindTexture(resources.maskATexture, 0)
    gl.uniform2f(uniform(gl, resources.blurProgram, 'uDirection'), 1, 0)
    this.drawFullscreen()

    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.maskAFramebuffer)
    this.bindTexture(resources.maskBTexture, 0)
    gl.uniform2f(uniform(gl, resources.blurProgram, 'uDirection'), 0, 1)
    this.drawFullscreen()
  }

  private renderEffect(frame: GlRenderFrame, active: boolean) {
    const resources = this.resources
    if (!resources) return
    const { gl } = this
    const program = resources.effectProgram
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.disable(gl.BLEND)
    gl.useProgram(program.handle)
    this.bindTexture(resources.videoTexture, 0)
    this.bindTexture(resources.backgroundTexture, 1)
    this.bindTexture(resources.maskATexture, 2)
    gl.uniform1i(uniform(gl, program, 'uVideo'), 0)
    gl.uniform1i(uniform(gl, program, 'uBackground'), 1)
    gl.uniform1i(uniform(gl, program, 'uMask'), 2)
    gl.uniform1i(uniform(gl, program, 'uHasBackground'), this.backgroundReady ? 1 : 0)
    gl.uniform1i(uniform(gl, program, 'uActive'), active ? 1 : 0)
    gl.uniform1i(uniform(gl, program, 'uEffect'), EFFECT_INDEX[frame.effect])
    gl.uniform1i(uniform(gl, program, 'uGone'), frame.gone ? 1 : 0)
    gl.uniform1f(uniform(gl, program, 'uEffectAmount'), clamp01(frame.e))
    gl.uniform1f(uniform(gl, program, 'uTime'), frame.time)
    this.drawFullscreen()
  }

  private renderParticles(frame: GlRenderFrame) {
    const resources = this.resources
    if (!resources) return
    const { gl } = this
    const program = resources.particleProgram
    gl.useProgram(program.handle)
    this.bindTexture(resources.videoTexture, 0)
    this.bindTexture(resources.maskATexture, 2)
    gl.uniform1i(uniform(gl, program, 'uVideo'), 0)
    gl.uniform1i(uniform(gl, program, 'uMask'), 2)
    gl.uniform1i(uniform(gl, program, 'uEffect'), EFFECT_INDEX[frame.effect])
    gl.uniform1i(uniform(gl, program, 'uVanishing'), frame.vanishing ? 1 : 0)
    gl.uniform1f(uniform(gl, program, 'uEffectAmount'), clamp01(frame.e))
    gl.uniform1f(uniform(gl, program, 'uTime'), frame.time)
    gl.uniform2f(uniform(gl, program, 'uResolution'), this.width, this.height)
    gl.enable(gl.BLEND)
    if (frame.effect === 'burn' || frame.effect === 'portal') gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(resources.particleVao)
    gl.drawArrays(gl.POINTS, 0, this.particleCount)
    gl.bindVertexArray(null)
    gl.disable(gl.BLEND)
  }

  private hasParticles(effect: EffectId) {
    return effect === 'dust' || effect === 'burn' || effect === 'portal' || effect === 'hedge'
  }

  private bindTexture(texture: WebGLTexture, unit: number) {
    const { gl } = this
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  private drawFullscreen() {
    const resources = this.resources
    if (!resources) return
    const { gl } = this
    gl.bindVertexArray(resources.fullscreenVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }

  private pollGpuQueries() {
    if (!this.gpuExt || this.gl.isContextLost()) return
    const { gl } = this
    const disjoint = gl.getParameter(this.gpuExt.GPU_DISJOINT_EXT) as boolean
    while (this.gpuPending.length) {
      const query = this.gpuPending[0]
      if (!query || !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break
      this.gpuPending.shift()
      if (!disjoint) {
        const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number
        this.gpuTimes.push(nanoseconds / 1_000_000)
      }
      gl.deleteQuery(query)
    }
  }

  private deleteResources() {
    const resources = this.resources
    if (!resources || this.gl.isContextLost()) {
      this.resources = null
      return
    }
    const { gl } = this
    gl.deleteFramebuffer(resources.backgroundFramebuffer)
    gl.deleteFramebuffer(resources.maskAFramebuffer)
    gl.deleteFramebuffer(resources.maskBFramebuffer)
    gl.deleteTexture(resources.backgroundTexture)
    gl.deleteTexture(resources.backgroundUploadTexture)
    gl.deleteTexture(resources.maskATexture)
    gl.deleteTexture(resources.maskBTexture)
    gl.deleteTexture(resources.videoTexture)
    gl.deleteBuffer(resources.particleBuffer)
    gl.deleteVertexArray(resources.fullscreenVao)
    gl.deleteVertexArray(resources.particleVao)
    gl.deleteProgram(resources.blurProgram.handle)
    gl.deleteProgram(resources.effectProgram.handle)
    gl.deleteProgram(resources.maskProgram.handle)
    gl.deleteProgram(resources.normalizeProgram.handle)
    gl.deleteProgram(resources.particleProgram.handle)
    for (const query of this.gpuPending) gl.deleteQuery(query)
    this.gpuPending.length = 0
    this.gpuTimes.length = 0
    this.resources = null
  }
}
