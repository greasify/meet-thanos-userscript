export const effectList = ['dust', 'burn', 'ghost', 'melt', 'portal', 'hedge'] as const

export type EffectId = typeof effectList[number]
export type ParticleKind = 'drop' | 'dust' | 'ember' | 'leaf' | 'swirl' | 'wisp'

export interface SwirlExtra {
  ang: number
  cx: number
  cy: number
  rad: number
}

export interface SpawnSpec {
  b: number
  extra?: SwirlExtra
  g: number
  inward: boolean
  kind: ParticleKind
  r: number
  x: number
  y: number
}

export interface EffectBox {
  cx: number
  cy: number
  h: number
  w: number
}

export interface HedgePanel {
  c: HTMLCanvasElement
  ext: number
  pw: number
}

export interface EffectFrame {
  d: Uint8ClampedArray
  e: number
  now: number
  prevE: number | null
  vanishing: boolean
}

export interface EffectHost {
  H: number
  HH: number
  W: number
  WW: number
  alphaC: HTMLCanvasElement
  alphaCtx: CanvasRenderingContext2D
  alphaImg: ImageData
  box: EffectBox
  ctx: CanvasRenderingContext2D
  fx: HTMLCanvasElement
  fxCtx: CanvasRenderingContext2D
  glowC: HTMLCanvasElement
  glowCtx: CanvasRenderingContext2D
  glowImg: ImageData
  hedgeL: HedgePanel | null
  hedgeR: HedgePanel | null
  maskAvg: Float32Array
  meltN: Float32Array | null
  n: number
  drawBg: () => void
  fullMatte: () => HTMLCanvasElement
  matte: (alpha: HTMLCanvasElement) => HTMLCanvasElement
  spawn: (spec: SpawnSpec) => void
  thrFor: (name: string, make: (w: number, h: number) => Float32Array) => Float32Array
}

export interface VanishEffect {
  durScale?: number
  label: string
  render: (host: EffectHost, frame: EffectFrame) => void
}

const P_MIN = -0.05
const P_MAX = 1.05
const PANEL = 0.6

type Rgb = [number, number, number]

interface Glow {
  c: Rgb
  width: number
}

interface DissolveCfg {
  band: number
  color?: () => Rgb
  glow?: Glow
  kind: ParticleKind
  makeThr: (w: number, h: number) => Float32Array
  name: string
  spawn: number
}

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

export function smooth(t: number) {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

export function ease(t: number) {
  const curved = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
  return 0.5 * t + 0.5 * curved
}

function hash2(x: number, y: number, s: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash2(xi, yi, s)
  const b = hash2(xi + 1, yi, s)
  const c = hash2(xi, yi + 1, s)
  const d = hash2(xi + 1, yi + 1, s)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function normalize(t: Float32Array) {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < t.length; i++) {
    const value = t[i] as number
    if (value < lo) lo = value
    if (value > hi) hi = value
  }
  const k = 1 / (hi - lo || 1)
  for (let i = 0; i < t.length; i++) t[i] = ((t[i] as number) - lo) * k
  return t
}

function dissolve(pl: EffectHost, cfg: DissolveCfg, frame: EffectFrame) {
  const { H, HH, W, WW, ctx, n } = pl
  const { d, e, prevE, vanishing } = frame
  const thr = pl.thrFor(cfg.name, cfg.makeThr)
  const P = P_MIN + e * (P_MAX - P_MIN)
  const PP = prevE == null ? P : P_MIN + prevE * (P_MAX - P_MIN)
  const lo = Math.min(P, PP)
  const hi = Math.max(P, PP)
  const a = pl.alphaImg.data
  const mask = pl.maskAvg
  const g = cfg.glow ? pl.glowImg.data : null
  const gw = cfg.glow ? cfg.glow.width : 1
  const gc = cfg.glow ? cfg.glow.c : null
  const sx = W / WW
  const sy = H / HH
  for (let i = 0; i < n; i++) {
    const m = (mask[i] as number) / 255
    const th = thr[i] as number
    a[i * 4 + 3] = m * smooth((th - P) / cfg.band + 0.5) * 255
    if (g && gc) {
      const j = i * 4
      const gv = m * Math.max(0, 1 - Math.abs(th - P) / gw)
      g[j] = gc[0]
      g[j + 1] = gc[1]
      g[j + 2] = gc[2]
      g[j + 3] = gv * 255
    }
    if (m > 0.6 && th >= lo && th < hi && Math.random() < cfg.spawn) {
      const j = i * 4
      const tint = cfg.color ? cfg.color() : [d[j] as number, d[j + 1] as number, d[j + 2] as number] as Rgb
      pl.spawn({
        b: tint[2],
        g: tint[1],
        inward: !vanishing,
        kind: cfg.kind,
        r: tint[0],
        x: (i % WW) * sx,
        y: ((i / WW) | 0) * sy,
      })
    }
  }
  pl.alphaCtx.putImageData(pl.alphaImg, 0, 0)
  pl.drawBg()
  ctx.drawImage(pl.matte(pl.alphaC), 0, 0)
  if (!g) return
  pl.glowCtx.putImageData(pl.glowImg, 0, 0)
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.filter = 'blur(2px)'
  ctx.drawImage(pl.glowC, 0, 0, W, H)
  ctx.restore()
}

function makePanel(W: number, H: number, side: number): HedgePanel {
  const k = W / 1280
  const pw = Math.round(W * PANEL)
  const ext = Math.round(H * 0.08)
  const c = makeCanvas(pw, H + ext * 2)
  const g = c.getContext('2d')
  if (!g) throw new Error('no 2d context')
  const CH = c.height
  const seed = Math.random() * 10
  const edge = (y: number) => pw - 60 * k
    + Math.sin(y * 0.011 + seed) * 30 * k
    + Math.sin(y * 0.034 + seed * 2) * 18 * k
    + Math.sin(y * 0.09 + seed * 3) * 6 * k
  const X = (x: number) => (side < 0 ? x : pw - x)
  const body = new Path2D()
  body.moveTo(X(0), 0)
  for (let y = 0; y <= CH; y += 8) body.lineTo(X(edge(y) - 14 * k), y)
  body.lineTo(X(0), CH)
  body.closePath()
  g.fillStyle = '#1f4617'
  g.fill(body)

  const step = 58 * k
  for (let y = -step / 2; y < CH + step; y += step * 0.68) {
    for (let x = -step / 2; x < pw + step; x += step * 0.78) {
      const cy = y + (Math.random() - 0.5) * step * 0.5
      const cx = Math.min(x + (Math.random() - 0.5) * step * 0.6, edge(cy) - step * 0.3)
      const r = step * (0.55 + Math.random() * 0.3)
      const sh = g.createRadialGradient(X(cx), cy + r * 0.35, 0, X(cx), cy + r * 0.35, r * 1.2)
      sh.addColorStop(0, 'rgba(6,18,4,0.75)')
      sh.addColorStop(1, 'rgba(6,18,4,0)')
      g.save()
      g.clip(body)
      g.fillStyle = sh
      g.beginPath()
      g.arc(X(cx), cy + r * 0.35, r * 1.2, 0, Math.PI * 2)
      g.fill()
      g.restore()
      for (let n = 0; n < 34; n++) {
        const ang = Math.random() * Math.PI * 2
        const dist = Math.sqrt(Math.random()) * r
        const lx = cx + Math.cos(ang) * dist
        const ly = cy + Math.sin(ang) * dist * 0.85
        if (lx > edge(ly) + 16 * k) continue
        const up = 1 - (ly - (cy - r)) / (2 * r)
        const inner = lx / pw
        const L = 18 + up * 24 + inner * 6 + Math.random() * 8
        const size = (11 + Math.random() * 10) * k
        const la = ang + (Math.random() - 0.5)
        g.fillStyle = `hsl(${98 + Math.random() * 16},${48 + Math.random() * 16}%,${L}%)`
        g.beginPath()
        g.ellipse(X(lx), ly, size, size * 0.5, la, 0, Math.PI * 2)
        g.fill()
        if (up > 0.6 && Math.random() < 0.5) {
          g.fillStyle = `hsla(86,60%,${L + 18}%,0.55)`
          g.beginPath()
          g.ellipse(X(lx - size * 0.15), ly - size * 0.12, size * 0.5, size * 0.16, la, 0, Math.PI * 2)
          g.fill()
        }
      }
    }
  }
  const sg = g.createLinearGradient(X(pw), 0, X(pw - 90 * k), 0)
  sg.addColorStop(0, 'rgba(0,12,0,0.45)')
  sg.addColorStop(1, 'rgba(0,12,0,0)')
  g.globalCompositeOperation = 'source-atop'
  g.fillStyle = sg
  g.fillRect(0, 0, pw, CH)
  const shade = g.createLinearGradient(0, 0, 0, CH)
  shade.addColorStop(0, 'rgba(0,0,0,0)')
  shade.addColorStop(1, 'rgba(0,10,0,0.18)')
  g.fillStyle = shade
  g.fillRect(0, 0, pw, CH)
  return { c, ext, pw }
}

function drawPanel(draw: { ctx: CanvasRenderingContext2D, panel: HedgePanel, sway: number, t: number, x: number }) {
  const { ctx, panel, sway, t, x } = draw
  const band = 6
  const CH = panel.c.height
  for (let y = 0; y < CH; y += band) {
    const dx = (Math.sin(y * 0.006 + t * 1.6) * 0.7 + Math.sin(y * 0.015 - t * 2.3) * 0.3) * sway
    ctx.drawImage(panel.c, 0, y, panel.pw, band + 1, x + dx, y - panel.ext, panel.pw, band + 1)
  }
}

const dust: VanishEffect = {
  label: 'Dust',
  render: (pl, st) => dissolve(pl, {
    band: 0.035,
    kind: 'dust',
    makeThr: (WW, HH) => {
      const t = new Float32Array(WW * HH)
      for (let y = 0; y < HH; y++) {
        for (let x = 0; x < WW; x++) t[y * WW + x] = 0.55 * (x / WW) + 0.45 * Math.random()
      }
      return t
    },
    name: 'dust',
    spawn: 0.1,
  }, st),
}

const burn: VanishEffect = {
  label: 'Burn',
  render: (pl, st) => dissolve(pl, {
    band: 0.02,
    color: () => [255, 120 + ((Math.random() * 120) | 0), 30],
    glow: { c: [255, 140, 40], width: 0.045 },
    kind: 'ember',
    makeThr: (WW, HH) => {
      const t = new Float32Array(WW * HH)
      const k = 1 / WW
      for (let y = 0; y < HH; y++) {
        for (let x = 0; x < WW; x++) {
          const nx = x * k
          const ny = y * k
          t[y * WW + x] = 0.55 * vnoise(nx * 5, ny * 5, 1)
            + 0.3 * vnoise(nx * 12, ny * 12, 2)
            + 0.15 * vnoise(nx * 30, ny * 30, 3)
        }
      }
      return normalize(t)
    },
    name: 'burn',
    spawn: 0.05,
  }, st),
}

const ghost: VanishEffect = {
  label: 'Ghost',
  render: (pl, { e }) => {
    const { H, W, box, ctx } = pl
    const layer = pl.fullMatte()
    pl.drawBg()
    const s = 1 + 0.06 * e
    ctx.save()
    ctx.translate(box.cx, box.cy - 30 * e)
    ctx.scale(s, s)
    ctx.translate(-box.cx, -box.cy)
    ctx.filter = `blur(${(e * 10).toFixed(1)}px)`
    ctx.globalAlpha = (1 - e) ** 1.4
    ctx.drawImage(layer, 0, 0, W, H)
    ctx.globalAlpha = 0.35 * Math.sin(Math.PI * Math.min(1, e * 1.2))
    ctx.translate(0, -40 * e)
    ctx.drawImage(layer, 0, 0, W, H)
    ctx.restore()
  },
}

const melt: VanishEffect = {
  label: 'Melt',
  render: (pl, { e }) => {
    const { H, W, ctx, fx, fxCtx } = pl
    const layer = pl.fullMatte()
    pl.drawBg()
    const strip = 6
    const cols = Math.ceil(W / strip)
    let meltN = pl.meltN
    if (!meltN || meltN.length !== cols) {
      meltN = new Float32Array(cols)
      for (let c = 0; c < cols; c++) {
        meltN[c] = 0.6 * vnoise(c / 14, 0, 5) + 0.4 * vnoise(c / 4, 0, 6)
      }
      pl.meltN = meltN
    }
    const drop = e ** 1.7
    fxCtx.clearRect(0, 0, W, H)
    for (let c = 0; c < cols; c++) {
      const nz = meltN[c] as number
      const oy = H * drop * (0.35 + 1.1 * nz)
      const stretch = 1 + e * 0.8 * nz
      fxCtx.drawImage(layer, c * strip, 0, strip, H, c * strip, oy, strip, H * stretch)
    }
    ctx.globalAlpha = 1 - smooth((e - 0.65) / 0.35)
    ctx.drawImage(fx, 0, 0)
    ctx.globalAlpha = 1
  },
}

const portal: VanishEffect = {
  label: 'Portal',
  render: (pl, { e, vanishing }) => {
    const { H, W, box, ctx } = pl
    const layer = pl.fullMatte()
    pl.drawBg()
    const cx = box.cx
    const cy = box.cy
    const R = Math.max(40, Math.min(W, H) * 0.32) * Math.sin(Math.PI * Math.min(1, e * 1.05))
    if (R > 1) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R)
      g.addColorStop(0, 'rgba(10,0,25,0.95)')
      g.addColorStop(0.6, 'rgba(40,10,90,0.85)')
      g.addColorStop(0.85, 'rgba(170,110,255,0.7)')
      g.addColorStop(1, 'rgba(170,110,255,0)')
      ctx.save()
      ctx.fillStyle = g
      ctx.translate(cx, cy)
      ctx.scale(1, 0.8)
      ctx.translate(-cx, -cy)
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      if (vanishing) {
        for (let k = 0; k < 8; k++) {
          pl.spawn({
            b: 255,
            extra: { ang: Math.random() * Math.PI * 2, cx, cy, rad: R * (1 + Math.random() * 0.5) },
            g: 160,
            inward: false,
            kind: 'swirl',
            r: 200 + ((Math.random() * 55) | 0),
            x: cx,
            y: cy,
          })
        }
      }
    }
    const s = (1 - e) ** 1.3
    if (s < 0.005) return
    ctx.save()
    ctx.globalAlpha = 1 - smooth((e - 0.85) / 0.15)
    ctx.translate(cx, cy)
    ctx.rotate(e * e * 3)
    ctx.scale(s, s)
    ctx.translate(-cx, -cy)
    ctx.drawImage(layer, 0, 0, W, H)
    ctx.restore()
  },
}

const hedge: VanishEffect = {
  label: 'Hedge',
  render: (pl, { e, now, prevE, vanishing }) => {
    const { H, W, box, ctx } = pl
    if (!pl.hedgeL || !pl.hedgeR) {
      pl.hedgeL = makePanel(W, H, -1)
      pl.hedgeR = makePanel(W, H, 1)
    }
    const left = pl.hedgeL
    const right = pl.hedgeR
    if (!left || !right) return
    const k = W / 1280
    const t = now / 1000
    const CLOSED = 0.42
    const c = Math.min(1, e / CLOSED)
    const close = c < 0.5 ? 4 * c * c * c : 1 - ((-2 * c + 2) ** 3) / 2
    const after = Math.max(0, e - CLOSED)
    const bounce = after > 0 ? Math.exp(-after * 22) * Math.sin(after * 55) * 0.035 : 0
    const open = smooth((e - 0.58) / 0.42)
    const pos = (close + bounce) * (1 - open)
    const hit = Math.exp(-(((e - CLOSED - 0.03) / 0.07) ** 2))
    const sway = (4 + 6 * Math.sin(Math.PI * c) + 16 * hit) * k

    pl.drawBg()

    if (e < CLOSED + 0.02) {
      const layer = pl.fullMatte()
      const back = smooth(c)
      const s = 1 - 0.16 * back
      ctx.save()
      ctx.translate(box.cx, box.cy)
      ctx.scale(s, s)
      ctx.translate(-box.cx, -box.cy - box.h * 0.03 * back)
      ctx.filter = `brightness(${(1 - 0.4 * back).toFixed(2)})`
      ctx.drawImage(layer, 0, 0)
      ctx.restore()
    }

    const reach = W / 2 + 36 * k
    if (pos > 0.001) {
      drawPanel({ ctx, panel: left, sway, t, x: -left.pw + pos * reach })
      drawPanel({ ctx, panel: right, sway, t: t + 1.7, x: W - pos * reach })
    }

    if (!vanishing || hit <= 0.3 || prevE == null) return
    for (let n = 0; n < 8 * hit; n++) {
      pl.spawn({
        b: 30,
        g: 105 + ((Math.random() * 70) | 0),
        inward: false,
        kind: 'leaf',
        r: 40 + ((Math.random() * 50) | 0),
        x: W / 2 + (Math.random() - 0.5) * 80 * k,
        y: Math.random() * H,
      })
    }
  },
}

export const effects: Record<EffectId, VanishEffect> = {
  burn,
  dust,
  ghost,
  hedge,
  melt,
  portal,
}
