import type { EffectId } from '../effect/effects'
import { effectList } from '../effect/effects'

const SETTINGS_KEY = 'snap.settings'
const BG_KEY = 'snap.bg'

export interface SnapSettings {
  countdown: number
  duration: number
  effect: EffectId
  enabled: boolean
  pill: boolean
  sens: number
  snap: boolean
  x: number | null
  y: number | null
}

interface StoredBg {
  dataUrl: string
  source: 'capture' | 'upload'
  ts: number
}

export const DEFAULT_SETTINGS: SnapSettings = {
  countdown: 5,
  duration: 2000,
  effect: 'dust',
  enabled: true,
  pill: true,
  sens: 9,
  snap: true,
  x: null,
  y: null,
}

function clamp(spec: { fallback: number, max: number, min: number, value: number }) {
  if (!Number.isFinite(spec.value)) return spec.fallback
  return Math.min(spec.max, Math.max(spec.min, spec.value))
}

function isEffect(value: unknown): value is EffectId {
  return typeof value === 'string' && (effectList as readonly string[]).includes(value)
}

function readCoord(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function readRaw(key: string) {
  const stored = GM_getValue(key, '')
  if (stored) return stored
  const legacy = localStorage.getItem(key)
  if (!legacy) return ''
  GM_setValue(key, legacy)
  return legacy
}

export function readSettings(): SnapSettings {
  try {
    const raw = readRaw(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<SnapSettings>
    return {
      countdown: clamp({ fallback: DEFAULT_SETTINGS.countdown, max: 15, min: 1, value: Number(parsed.countdown) }),
      duration: clamp({ fallback: DEFAULT_SETTINGS.duration, max: 6000, min: 500, value: Number(parsed.duration) }),
      effect: isEffect(parsed.effect) ? parsed.effect : DEFAULT_SETTINGS.effect,
      enabled: parsed.enabled !== false,
      pill: parsed.pill !== false,
      sens: clamp({ fallback: DEFAULT_SETTINGS.sens, max: 20, min: 2, value: Number(parsed.sens) }),
      snap: parsed.snap !== false,
      x: readCoord(parsed.x),
      y: readCoord(parsed.y),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function writeSettings(settings: SnapSettings) {
  try {
    GM_setValue(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Storage can be blocked by the page.
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement) {
  const scale = Math.min(1, 1280 / canvas.width)
  const out = document.createElement('canvas')
  out.width = Math.max(2, Math.round(canvas.width * scale))
  out.height = Math.max(2, Math.round(canvas.height * scale))
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  return out.toDataURL('image/jpeg', 0.9)
}

export function writeBg(canvas: HTMLCanvasElement, source: 'capture' | 'upload') {
  try {
    const stored: StoredBg = {
      dataUrl: canvasToJpeg(canvas),
      source,
      ts: Date.now(),
    }
    GM_setValue(BG_KEY, JSON.stringify(stored))
  } catch {
    // Storage can be blocked or full.
  }
}

export async function readBg() {
  try {
    const raw = readRaw(BG_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as Partial<StoredBg>
    if (!stored.dataUrl?.startsWith('data:image/')) return null
    const source: 'capture' | 'upload' = stored.source === 'upload' ? 'upload' : 'capture'
    const comma = stored.dataUrl.indexOf(',')
    const bytes = Uint8Array.from(atob(stored.dataUrl.slice(comma + 1)), char => char.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0)
    bmp.close()
    return { canvas, source }
  } catch {
    return null
  }
}
