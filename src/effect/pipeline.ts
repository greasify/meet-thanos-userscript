import type { SnapState } from '../state'
import type { EffectHost, ParticleKind, SpawnSpec } from './effects'
import { ease, effects } from './effects'

const WORK_W = 480
const DIFF_T = 70
const MAX_PARTICLES = 4500
const BG_FRAMES = 14

interface Plane {
  h: number
  r: number
  w: number
}

interface Cover {
  ctx: CanvasRenderingContext2D
  flip: boolean
  h: number
  img: CanvasImageSource
  w: number
}

interface Particle {
  add: boolean
  age: number
  ang: number
  b: number
  cx: number
  cy: number
  g: number
  inward: boolean
  kind: ParticleKind
  life: number
  ox: number
  oy: number
  r: number
  rad: number
  rad0: number
  size: number
  soft: boolean
  tx: number
  ty: number
  vx: number
  vy: number
  x: number
  y: number
}

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

function context2d(canvas: HTMLCanvasElement, options?: CanvasRenderingContext2DSettings) {
  const ctx = canvas.getContext('2d', options)
  if (!ctx) throw new Error('no 2d context')
  return ctx
}

function sourceSize(img: CanvasImageSource) {
  const sized = img as CanvasImageSource & {
    displayHeight?: number
    displayWidth?: number
    height?: number
    naturalHeight?: number
    naturalWidth?: number
    videoHeight?: number
    videoWidth?: number
    width?: number
  }
  return {
    h: sized.videoHeight || sized.naturalHeight || sized.displayHeight || sized.height || 0,
    w: sized.videoWidth || sized.naturalWidth || sized.displayWidth || sized.width || 0,
  }
}

function drawCover(cover: Cover) {
  const { ctx, flip, h, img, w } = cover
  const size = sourceSize(img)
  const s = Math.max(w / size.w, h / size.h)
  const dw = size.w * s
  const dh = size.h * s
  ctx.save()
  if (flip) {
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
  }
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
  ctx.restore()
}

function blurH(src: Uint8Array, dst: Uint8Array, plane: Plane) {
  const { h, r, w } = plane
  const k = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))] as number
    for (let x = 0; x < w; x++) {
      dst[row + x] = (sum / k) | 0
      sum += (src[row + Math.min(w - 1, x + r + 1)] as number) - (src[row + Math.max(0, x - r)] as number)
    }
  }
}

function blurV(src: Uint8Array, dst: Uint8Array, plane: Plane) {
  const { h, r, w } = plane
  const k = 2 * r + 1
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) sum += src[Math.min(h - 1, Math.max(0, y)) * w + x] as number
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = (sum / k) | 0
      sum += (src[Math.min(h - 1, y + r + 1) * w + x] as number) - (src[Math.max(0, y - r) * w + x] as number)
    }
  }
}

function blur(src: Uint8Array, tmp: Uint8Array, plane: Plane) {
  blurH(src, tmp, plane)
  blurV(tmp, src, plane)
}

export function tick(sh: SnapState, now: number) {
  if (sh.mode === 'out' || sh.mode === 'in') {
    const t = Math.min(1, Math.max(0, (now - sh.t0) / sh.dur))
    sh.t = t
    if (t >= 1) {
      sh.mode = sh.mode === 'out' ? 'gone' : 'live'
      sh.onChange?.()
    }
  }
  if (sh.mode === 'out') return sh.t
  if (sh.mode === 'in') return 1 - sh.t
  if (sh.mode === 'gone') return 1
  return 0
}

export class Pipeline implements EffectHost {
  H: number
  HH: number
  W: number
  WW: number
  alphaC: HTMLCanvasElement
  alphaCtx: CanvasRenderingContext2D
  alphaImg: ImageData
  bgCtx: CanvasRenderingContext2D
  bgFull: HTMLCanvasElement
  bgSmall: Uint8ClampedArray | null = null
  bgVer = -1
  bin: Uint8Array
  box: EffectHost['box']
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  dead = false
  fx: HTMLCanvasElement
  fxCtx: CanvasRenderingContext2D
  glowC: HTMLCanvasElement
  glowCtx: CanvasRenderingContext2D
  glowImg: ImageData
  hedgeL: EffectHost['hedgeL'] = null
  hedgeR: EffectHost['hedgeR'] = null
  labels: Int32Array
  last = performance.now()
  layer: HTMLCanvasElement
  layerCtx: CanvasRenderingContext2D
  mask: Uint8Array
  maskAvg: Float32Array
  maskFrames = 0
  meltN: Float32Array | null = null
  n: number
  parts: Particle[] = []
  prevE: number | null = null
  sh: SnapState
  small: HTMLCanvasElement
  smallCtx: CanvasRenderingContext2D
  stack: Int32Array
  thrCache: Record<string, Float32Array> = {}
  timer: number | null = null
  tmp: Uint8Array
  transId = -1
  video: HTMLVideoElement

  constructor(video: HTMLVideoElement, shared: SnapState) {
    this.video = video
    this.sh = shared
    const vw = video.videoWidth || 1280
    const vh = video.videoHeight || 720
    const scale = Math.min(1, 1280 / vw)
    this.W = Math.max(2, Math.round((vw * scale) / 2) * 2)
    this.H = Math.max(2, Math.round((vh * scale) / 2) * 2)
    this.WW = Math.min(WORK_W, this.W)
    this.HH = Math.max(2, Math.round((this.WW * this.H) / this.W))

    this.canvas = makeCanvas(this.W, this.H)
    this.ctx = context2d(this.canvas)
    this.layer = makeCanvas(this.W, this.H)
    this.layerCtx = context2d(this.layer)
    this.fx = makeCanvas(this.W, this.H)
    this.fxCtx = context2d(this.fx)
    this.bgFull = makeCanvas(this.W, this.H)
    this.bgCtx = context2d(this.bgFull)
    this.small = makeCanvas(this.WW, this.HH)
    this.smallCtx = context2d(this.small, { willReadFrequently: true })
    this.alphaC = makeCanvas(this.WW, this.HH)
    this.alphaCtx = context2d(this.alphaC)
    this.alphaImg = this.alphaCtx.createImageData(this.WW, this.HH)
    this.glowC = makeCanvas(this.WW, this.HH)
    this.glowCtx = context2d(this.glowC)
    this.glowImg = this.glowCtx.createImageData(this.WW, this.HH)

    const n = this.WW * this.HH
    this.n = n
    this.mask = new Uint8Array(n)
    this.maskAvg = new Float32Array(n)
    this.tmp = new Uint8Array(n)
    this.bin = new Uint8Array(n)
    this.labels = new Int32Array(n)
    this.stack = new Int32Array(n)
    this.box = { cx: this.W / 2, cy: this.H / 2, h: this.H / 2, w: this.W / 3 }
    shared.pipes.add(this)
  }

  start() {
    this.timer = window.setInterval(() => this.frame(), 1000 / 30)
    this.frame()
  }

  destroy() {
    if (this.dead) return
    this.dead = true
    if (this.timer != null) window.clearInterval(this.timer)
    this.video.pause()
    this.video.srcObject = null
    this.video.remove()
    this.sh.pipes.delete(this)
    if (this.sh.active === this) {
      const rest = [...this.sh.pipes]
      this.sh.active = rest[rest.length - 1] ?? null
    }
    this.sh.onPipes?.()
  }

  async captureBg() {
    const { H, W } = this
    const grab = makeCanvas(W, H)
    const gctx = context2d(grab, { willReadFrequently: true })
    const acc = new Float32Array(W * H * 3)
    for (let f = 0; f < BG_FRAMES; f++) {
      gctx.drawImage(this.video, 0, 0, W, H)
      const d = gctx.getImageData(0, 0, W, H).data
      for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
        acc[j] = (acc[j] as number) + (d[i] as number)
        acc[j + 1] = (acc[j + 1] as number) + (d[i + 1] as number)
        acc[j + 2] = (acc[j + 2] as number) + (d[i + 2] as number)
      }
      await new Promise(resolve => window.setTimeout(resolve, 45))
    }
    const out = gctx.createImageData(W, H)
    for (let i = 0, j = 0; i < out.data.length; i += 4, j += 3) {
      out.data[i] = (acc[j] as number) / BG_FRAMES
      out.data[i + 1] = (acc[j + 1] as number) / BG_FRAMES
      out.data[i + 2] = (acc[j + 2] as number) / BG_FRAMES
      out.data[i + 3] = 255
    }
    gctx.putImageData(out, 0, 0)
    this.parts.length = 0
    return grab
  }

  scoreBg(img: CanvasImageSource, flip: boolean) {
    const { HH, WW } = this
    const c = makeCanvas(WW, HH)
    const cx = context2d(c, { willReadFrequently: true })
    drawCover({ ctx: cx, flip, h: HH, img, w: WW })
    const b = cx.getImageData(0, 0, WW, HH).data
    this.smallCtx.drawImage(this.video, 0, 0, WW, HH)
    const d = this.smallCtx.getImageData(0, 0, WW, HH).data
    let s = 0
    for (let i = 0; i < d.length; i += 16) {
      s += Math.abs((d[i] as number) - (b[i] as number))
        + Math.abs((d[i + 1] as number) - (b[i + 1] as number))
        + Math.abs((d[i + 2] as number) - (b[i + 2] as number))
    }
    return s
  }

  syncBg() {
    const bg = this.sh.bg
    if (!bg) return
    this.bgCtx.clearRect(0, 0, this.W, this.H)
    drawCover({ ctx: this.bgCtx, flip: this.sh.bgFlip, h: this.H, img: bg, w: this.W })
    this.smallCtx.drawImage(this.bgFull, 0, 0, this.WW, this.HH)
    this.bgSmall = this.smallCtx.getImageData(0, 0, this.WW, this.HH).data.slice()
    this.bgVer = this.sh.bgVer
  }

  thrFor(name: string, make: (w: number, h: number) => Float32Array) {
    const cached = this.thrCache[name]
    if (cached) return cached
    const made = make(this.WW, this.HH)
    this.thrCache[name] = made
    return made
  }

  computeMask(d: Uint8ClampedArray) {
    const { HH, WW, bgSmall, bin, labels, mask, maskAvg, n, stack, tmp } = this
    if (!bgSmall) return

    let o0 = 0
    let o1 = 0
    let o2 = 0
    for (let pass = 0; pass < 2; pass++) {
      let s0 = 0
      let s1 = 0
      let s2 = 0
      let c = 0
      for (let i = 0; i < n; i += 3) {
        const j = i * 4
        const e0 = (d[j] as number) - (bgSmall[j] as number) - o0
        const e1 = (d[j + 1] as number) - (bgSmall[j + 1] as number) - o1
        const e2 = (d[j + 2] as number) - (bgSmall[j + 2] as number) - o2
        if (Math.abs(e0) + Math.abs(e1) + Math.abs(e2) < 70 || pass === 0) {
          s0 += e0 + o0
          s1 += e1 + o1
          s2 += e2 + o2
          c++
        }
      }
      if (c) {
        o0 = s0 / c
        o1 = s1 / c
        o2 = s2 / c
      }
    }
    for (let i = 0; i < n; i++) {
      const j = i * 4
      const diff = Math.abs((d[j] as number) - (bgSmall[j] as number) - o0)
        + Math.abs((d[j + 1] as number) - (bgSmall[j + 1] as number) - o1)
        + Math.abs((d[j + 2] as number) - (bgSmall[j + 2] as number) - o2)
      bin[i] = diff > DIFF_T ? 255 : 0
    }

    blur(bin, tmp, { h: HH, r: 2, w: WW })
    for (let i = 0; i < n; i++) bin[i] = (bin[i] as number) > 150 ? 255 : 0
    blur(bin, tmp, { h: HH, r: 3, w: WW })
    for (let i = 0; i < n; i++) bin[i] = (bin[i] as number) > 70 ? 1 : 0

    labels.fill(0)
    const sizes = [0]
    let next = 0
    for (let s = 0; s < n; s++) {
      if (!(bin[s] as number) || (labels[s] as number)) continue
      next++
      let sp = 0
      let size = 0
      stack[sp++] = s
      labels[s] = next
      while (sp) {
        const p = stack[--sp] as number
        size++
        const x = p % WW
        if (x > 0 && (bin[p - 1] as number) && !(labels[p - 1] as number)) {
          labels[p - 1] = next
          stack[sp++] = p - 1
        }
        if (x < WW - 1 && (bin[p + 1] as number) && !(labels[p + 1] as number)) {
          labels[p + 1] = next
          stack[sp++] = p + 1
        }
        if (p >= WW && (bin[p - WW] as number) && !(labels[p - WW] as number)) {
          labels[p - WW] = next
          stack[sp++] = p - WW
        }
        if (p < n - WW && (bin[p + WW] as number) && !(labels[p + WW] as number)) {
          labels[p + WW] = next
          stack[sp++] = p + WW
        }
      }
      sizes.push(size)
    }
    let largest = 0
    for (let k = 1; k < sizes.length; k++) {
      const size = sizes[k] as number
      if (size > largest) largest = size
    }
    const minKeep = Math.max(n * 0.015, largest * 0.25)
    for (let i = 0; i < n; i++) {
      const label = labels[i] as number
      bin[i] = label && (sizes[label] as number) >= minKeep ? 1 : 0
    }

    labels.fill(0)
    let sp = 0
    const seed = (p: number) => {
      if ((bin[p] as number) || (labels[p] as number)) return
      labels[p] = 1
      stack[sp++] = p
    }
    for (let x = 0; x < WW; x++) {
      seed(x)
      seed((HH - 1) * WW + x)
    }
    for (let y = 0; y < HH; y++) {
      seed(y * WW)
      seed(y * WW + WW - 1)
    }
    while (sp) {
      const p = stack[--sp] as number
      const x = p % WW
      if (x > 0) seed(p - 1)
      if (x < WW - 1) seed(p + 1)
      if (p >= WW) seed(p - WW)
      if (p < n - WW) seed(p + WW)
    }
    for (let i = 0; i < n; i++) mask[i] = (bin[i] as number) || !(labels[i] as number) ? 255 : 0

    blur(mask, tmp, { h: HH, r: 2, w: WW })
    const blend = this.maskFrames === 0 ? 1 : 0.5
    for (let i = 0; i < n; i++) {
      const prev = maskAvg[i] as number
      maskAvg[i] = prev + ((mask[i] as number) - prev) * blend
    }
    this.maskFrames++

    let x0 = WW
    let y0 = HH
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < HH; y += 2) {
      const row = y * WW
      for (let x = 0; x < WW; x += 2) {
        if ((maskAvg[row + x] as number) <= 128) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    if (x1 < 0) return
    const sx = this.W / WW
    const sy = this.H / HH
    this.box = {
      cx: ((x0 + x1) / 2) * sx,
      cy: ((y0 + y1) / 2) * sy,
      h: (y1 - y0) * sy,
      w: (x1 - x0) * sx,
    }
  }

  matte(alpha: HTMLCanvasElement) {
    const { H, W, layerCtx: lc } = this
    lc.globalCompositeOperation = 'source-over'
    lc.clearRect(0, 0, W, H)
    lc.drawImage(this.video, 0, 0, W, H)
    lc.globalCompositeOperation = 'destination-in'
    lc.filter = 'blur(1.5px)'
    lc.drawImage(alpha, 0, 0, W, H)
    lc.filter = 'none'
    lc.globalCompositeOperation = 'source-over'
    return this.layer
  }

  fullMatte() {
    const a = this.alphaImg.data
    const m = this.maskAvg
    for (let i = 0; i < this.n; i++) a[i * 4 + 3] = m[i] as number
    this.alphaCtx.putImageData(this.alphaImg, 0, 0)
    return this.matte(this.alphaC)
  }

  drawBg() {
    this.ctx.drawImage(this.bgFull, 0, 0, this.W, this.H)
  }

  spawn(spec: SpawnSpec) {
    if (this.parts.length >= MAX_PARTICLES) return
    if (spec.kind === 'swirl' && !spec.extra) return
    const p: Particle = {
      add: false,
      age: 0,
      ang: 0,
      b: spec.b,
      cx: 0,
      cy: 0,
      g: spec.g,
      inward: spec.inward,
      kind: spec.kind,
      life: 1,
      ox: 0,
      oy: 0,
      r: spec.r,
      rad: 0,
      rad0: 0,
      size: 1.5 + Math.random() * 2.5,
      soft: false,
      tx: spec.x,
      ty: spec.y,
      vx: 0,
      vy: 0,
      x: spec.x,
      y: spec.y,
    }
    if (spec.kind === 'dust') {
      p.life = 0.9 + Math.random() * 0.9
      p.vx = 30 + Math.random() * 150
      p.vy = -(20 + Math.random() * 110)
      p.ox = 60 + Math.random() * 160
      p.oy = -(40 + Math.random() * 110)
    } else if (spec.kind === 'ember') {
      p.life = 0.6 + Math.random()
      p.vx = (Math.random() - 0.5) * 40
      p.vy = -(40 + Math.random() * 90)
      p.ox = (Math.random() - 0.5) * 60
      p.oy = -(60 + Math.random() * 120)
      p.add = true
      p.size = 1.5 + Math.random() * 2
    } else if (spec.kind === 'wisp') {
      p.life = 1 + Math.random() * 1.2
      p.vx = (Math.random() - 0.5) * 20
      p.vy = -(35 + Math.random() * 60)
      p.ox = (Math.random() - 0.5) * 40
      p.oy = -(60 + Math.random() * 100)
      p.add = true
      p.size = 2 + Math.random() * 4
      p.soft = true
    } else if (spec.kind === 'drop') {
      p.life = 0.8 + Math.random() * 0.6
      p.vx = (Math.random() - 0.5) * 10
      p.vy = 20 + Math.random() * 60
      p.size = 2 + Math.random() * 3
    } else if (spec.kind === 'leaf') {
      p.life = 1 + Math.random() * 0.8
      p.vx = (Math.random() - 0.5) * 90
      p.vy = -(20 + Math.random() * 70)
      p.ox = (Math.random() - 0.5) * 120
      p.oy = -(30 + Math.random() * 90)
      p.size = 3 + Math.random() * 4
    } else if (spec.extra) {
      p.life = 0.6 + Math.random() * 0.5
      p.cx = spec.extra.cx
      p.cy = spec.extra.cy
      p.ang = spec.extra.ang
      p.rad = spec.extra.rad
      p.rad0 = spec.extra.rad
      p.add = true
      p.size = 1.5 + Math.random() * 2
    }
    this.parts.push(p)
  }

  updateParticles(dt: number) {
    const arr = this.parts
    let w = 0
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i]
      if (!p) continue
      p.age += dt
      if (p.age >= p.life) continue
      if (!p.inward) this.stepParticle(p, dt)
      arr[w++] = p
    }
    arr.length = w
  }

  drawParticles() {
    const ctx = this.ctx
    for (let pass = 0; pass < 2; pass++) {
      ctx.globalCompositeOperation = pass ? 'lighter' : 'source-over'
      for (const p of this.parts) {
        if (p.add !== !!pass) continue
        const drawn = this.placeParticle(p)
        ctx.globalAlpha = Math.max(0, drawn.a) * (p.soft ? 0.35 : 1)
        ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`
        if (p.soft) {
          ctx.beginPath()
          ctx.arc(drawn.x, drawn.y, p.size, 0, 6.2832)
          ctx.fill()
        } else if (p.kind === 'leaf') {
          ctx.beginPath()
          ctx.ellipse(drawn.x, drawn.y, p.size, p.size * 0.45, p.age * 4 + p.r, 0, 6.2832)
          ctx.fill()
        } else {
          ctx.fillRect(drawn.x, drawn.y, p.size, p.size)
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }

  frame() {
    if (this.dead) return
    const v = this.video
    if (v.paused) void v.play().catch(() => {})
    if (v.readyState < 2) return
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const sh = this.sh
    const ctx = this.ctx
    if (sh.bg && this.bgVer !== sh.bgVer) this.syncBg()
    const q = tick(sh, now)

    if (!sh.enabled || !sh.bg || sh.mode === 'live') {
      ctx.drawImage(v, 0, 0, this.W, this.H)
      this.prevE = null
    } else if (sh.mode === 'gone') {
      this.drawBg()
      this.prevE = null
    } else {
      this.transition(q, now)
    }
    this.updateParticles(dt)
    if (this.parts.length) this.drawParticles()
    if (sh.onFrame && sh.active === this) sh.onFrame()
  }

  private stepParticle(p: Particle, dt: number) {
    if (p.kind === 'dust') {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vx += 40 * dt
      p.vy -= 15 * dt
      return
    }
    if (p.kind === 'ember') {
      p.x += (p.vx + Math.sin(p.age * 9 + p.y) * 25) * dt
      p.y += p.vy * dt
      return
    }
    if (p.kind === 'wisp') {
      p.x += (p.vx + Math.sin(p.age * 3 + p.y * 0.02) * 30) * dt
      p.y += p.vy * dt
      return
    }
    if (p.kind === 'drop') {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 500 * dt
      return
    }
    if (p.kind === 'leaf') {
      p.x += (p.vx + Math.sin(p.age * 6) * 40) * dt
      p.y += p.vy * dt
      p.vy += 220 * dt
      p.vx *= 1 - dt
      return
    }
    const u = p.age / p.life
    p.ang += dt * (3 + 6 * u)
    p.rad = p.rad0 * (1 - u) * (1 - u)
    p.x = p.cx + Math.cos(p.ang) * p.rad
    p.y = p.cy + Math.sin(p.ang) * p.rad * 0.8
  }

  private placeParticle(p: Particle) {
    const u = p.age / p.life
    if (!p.inward) {
      const a = p.kind === 'ember' ? (1 - u) * (0.6 + 0.4 * Math.sin(p.age * 30)) : 1 - u
      return { a, x: p.x, y: p.y }
    }
    const k = (1 - u) * (1 - u)
    return {
      a: Math.min(1, u * 1.6),
      x: p.tx + p.ox * k,
      y: p.ty + p.oy * k,
    }
  }

  private transition(q: number, now: number) {
    const sh = this.sh
    if (this.transId !== sh.transId) {
      this.transId = sh.transId
      this.maskFrames = 0
      this.prevE = null
    }
    const e = ease(q)
    this.smallCtx.drawImage(this.video, 0, 0, this.WW, this.HH)
    const d = this.smallCtx.getImageData(0, 0, this.WW, this.HH).data
    this.computeMask(d)
    const fx = effects[sh.effect] ?? effects.dust
    fx.render(this, { d, e, now, prevE: this.prevE, vanishing: sh.mode === 'out' })
    this.prevE = e
  }
}
