import type { EffectId } from './effect/effects'
import type { SnapSettings } from './snap/settings'
import { setSensitivity } from './snap/detector'
import { readSettings } from './snap/settings'

export type SnapMode = 'gone' | 'in' | 'live' | 'out'
export type BgSource = 'capture' | 'upload'

export interface CameraPipeline {
  H: number
  W: number
  canvas: HTMLCanvasElement
  dead: boolean
  parts: { length: number }
  video: HTMLVideoElement
  captureBg: () => Promise<HTMLCanvasElement>
  destroy: () => void
  scoreBg: (img: CanvasImageSource, flip: boolean) => number
  start: () => void
}

export interface SnapState {
  active: CameraPipeline | null
  bg: HTMLCanvasElement | null
  bgFlip: boolean
  bgSource: BgSource | null
  bgVer: number
  dur: number
  effect: EffectId
  enabled: boolean
  flash: (message: string) => void
  mode: SnapMode
  onChange: (() => void) | null
  onFrame: (() => void) | null
  onPipes: (() => void) | null
  pendingFlip: boolean
  pipes: Set<CameraPipeline>
  refresh: () => void
  settings: SnapSettings
  t: number
  t0: number
  tone: (freq: number, ms: number) => void
  transId: number
}

export function createState(): SnapState {
  const settings = readSettings()
  setSensitivity(settings.sens)
  return {
    active: null,
    bg: null,
    bgFlip: false,
    bgSource: null,
    bgVer: 0,
    dur: settings.duration,
    effect: settings.effect,
    enabled: settings.enabled,
    flash: () => {},
    mode: 'live',
    onChange: null,
    onFrame: null,
    onPipes: null,
    pendingFlip: false,
    pipes: new Set(),
    refresh: () => {},
    settings,
    t: 0,
    t0: 0,
    tone: () => {},
    transId: 0,
  }
}

export function rememberBg(state: SnapState, canvas: HTMLCanvasElement, source: BgSource) {
  state.bg = canvas
  state.bgSource = source
  state.bgFlip = false
  state.pendingFlip = source === 'upload'
  state.bgVer += 1
  state.mode = 'live'
  for (const pipe of state.pipes) pipe.parts.length = 0
}
