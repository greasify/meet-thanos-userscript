import type { SnapState } from '../state'
import { effectList, effects } from '../effect/effects'
import { setSensitivity } from '../snap/detector'
import { writeBg, writeSettings } from '../snap/settings'
import { rememberBg } from '../state'
import panelCss from './panel.scss?inline'

interface Status {
  text: string
  tone: string
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const EDGE = 8
const DRAG_SLOP = 4
const PANEL_WIDTH = 230

function sheetOf(css: string) {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  return sheet
}

function gripIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 10 16')
  svg.setAttribute('width', '10')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  for (const [cx, cy] of [[2, 2], [8, 2], [2, 8], [8, 8], [2, 14], [8, 14]]) {
    const circle = document.createElementNS(SVG_NS, 'circle')
    circle.setAttribute('cx', String(cx))
    circle.setAttribute('cy', String(cy))
    circle.setAttribute('r', '1.25')
    svg.append(circle)
  }
  return svg
}

export function mountPanel(state: SnapState, toggle: () => void) {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  root.adoptedStyleSheets = [sheetOf(panelCss)]

  const dot = document.createElement('span')
  dot.className = 'dot'
  const status = document.createElement('span')
  status.className = 'status'
  status.textContent = 'snap'
  const grip = document.createElement('span')
  grip.className = 'grip'
  grip.append(gripIcon())
  const pill = document.createElement('div')
  pill.className = 'pill'
  pill.append(dot, status, grip)

  const vanish = document.createElement('button')
  vanish.type = 'button'
  vanish.className = 'is-main'
  vanish.textContent = 'vanish / return'
  const pause = document.createElement('button')
  pause.type = 'button'
  const row = document.createElement('div')
  row.className = 'row'
  row.append(vanish, pause)

  const effect = document.createElement('select')
  for (const id of effectList) {
    const option = document.createElement('option')
    option.value = id
    option.textContent = effects[id].label
    effect.append(option)
  }
  effect.value = state.settings.effect

  const capture = document.createElement('button')
  capture.type = 'button'
  capture.textContent = 'capture empty room'
  const upload = document.createElement('button')
  upload.type = 'button'
  upload.textContent = 'upload background'
  const file = document.createElement('input')
  file.type = 'file'
  file.accept = 'image/*'
  file.className = 'file'

  const range = document.createElement('input')
  range.type = 'range'
  range.min = '2'
  range.max = '20'
  range.step = '0.5'
  range.value = String(state.settings.sens)
  const sensLabel = document.createElement('label')
  sensLabel.append('snap sensitivity ', range)

  const duration = document.createElement('input')
  duration.type = 'range'
  duration.min = '500'
  duration.max = '6000'
  duration.step = '100'
  duration.value = String(state.settings.duration)
  const durationText = document.createTextNode('')
  const durationLabel = document.createElement('label')
  durationLabel.append(durationText, duration)

  const power = document.createElement('button')
  power.type = 'button'
  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = 'Step out, capture or upload the room, then snap. Cmd or Ctrl + Shift + X vanishes. Alt + Shift + P pauses the snap. Cmd or Ctrl + Shift + H hides this.'
  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.append(row, effect, capture, upload, file, sensLabel, durationLabel, power, hint)
  root.append(pill, panel)

  let open = false
  let hidden = !state.settings.pill
  let countdown = 0
  let capturing = false
  let flashMsg = ''
  let flashUntil = 0
  let lastFrame = 0
  let drag: { id: number, left: number, moved: boolean, top: number, x: number, y: number } | null = null
  let suppressClick = false

  const readStatus = (): Status => {
    if (performance.now() < flashUntil) return { text: flashMsg, tone: 'warn' }
    if (countdown > 0) return { text: `step out... ${countdown}`, tone: 'warn' }
    if (countdown < 0) return { text: 'saving the room...', tone: 'warn' }
    if (!state.enabled) return { text: 'snap off', tone: '' }
    if (!state.active) return { text: 'waiting for camera', tone: '' }
    if (!state.bg) return { text: 'set a background', tone: 'warn' }
    if (state.mode === 'gone') return { text: 'vanished', tone: 'gone' }
    if (state.mode === 'out') return { text: 'vanishing', tone: '' }
    if (state.mode === 'in') return { text: 'returning', tone: '' }
    if (!state.settings.snap) return { text: 'armed, snap paused', tone: 'armed' }
    return { text: 'armed', tone: 'armed' }
  }

  const place = (viewportLeft: number, viewportTop: number) => {
    const rect = host.getBoundingClientRect()
    if (rect.width === 0) return null
    const style = getComputedStyle(host)
    const styleLeft = Number.parseFloat(style.left)
    const styleTop = Number.parseFloat(style.top)
    if (!Number.isFinite(styleLeft) || !Number.isFinite(styleTop)) return null
    const x = Math.min(Math.max(EDGE, window.innerWidth - rect.width - EDGE), Math.max(EDGE, viewportLeft))
    const y = Math.min(Math.max(EDGE, window.innerHeight - rect.height - EDGE), Math.max(EDGE, viewportTop))
    host.style.left = `${x - (rect.left - styleLeft)}px`
    host.style.top = `${y - (rect.top - styleTop)}px`
    return { x, y }
  }

  const flip = () => {
    const rect = host.getBoundingClientRect()
    const panelWidth = panel.offsetWidth || PANEL_WIDTH
    const panelHeight = panel.offsetHeight
    const needed = panelHeight + EDGE
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const overflowRight = rect.left + panelWidth > window.innerWidth - EDGE
    const fitsEnd = rect.right - panelWidth >= EDGE
    host.classList.toggle('is-up', open && panelHeight > 0 && spaceBelow < needed + EDGE && spaceAbove >= needed + EDGE)
    host.classList.toggle('is-end', overflowRight && fitsEnd)
  }

  const settle = () => {
    if (hidden || drag) return
    const rect = host.getBoundingClientRect()
    const { x, y } = state.settings
    const left = x != null && y != null ? x : rect.left
    const top = x != null && y != null ? y : rect.top
    place(left, top)
    flip()
  }

  const render = () => {
    const becameVisible = !hidden && host.classList.contains('is-hidden')
    host.classList.toggle('is-hidden', hidden)
    panel.classList.toggle('open', open)
    pause.textContent = state.settings.snap ? 'pause snap' : 'snaps on'
    power.textContent = state.enabled ? 'turn snap off' : 'turn snap on'
    durationText.data = `duration ${(Number(duration.value) / 1000).toFixed(1)}s `
    const next = readStatus()
    dot.className = next.tone ? `dot ${next.tone}` : 'dot'
    status.textContent = next.text
    if (becameVisible) settle()
    else if (!hidden) flip()
  }

  const flash = (message: string, ms = 2200) => {
    flashMsg = message
    flashUntil = performance.now() + ms
    render()
    window.setTimeout(render, ms + 50)
  }

  const save = () => {
    writeSettings(state.settings)
    state.onPipes?.()
    render()
  }

  const checkFlip = () => {
    const pipe = state.active
    if (!state.pendingFlip || !pipe || !state.bg || pipe.video.readyState < 2) return
    state.pendingFlip = false
    try {
      const flipped = pipe.scoreBg(state.bg, true)
      const plain = pipe.scoreBg(state.bg, false)
      if (flipped < plain * 0.9) {
        state.bgFlip = true
        state.bgVer += 1
      }
    } catch {
      // The camera frame can be missing for a moment.
    }
  }

  const runCapture = async () => {
    const pipe = state.active
    if (!pipe) {
      flash('no camera yet')
      return
    }
    if (capturing) return
    capturing = true
    const steps = Math.max(1, Math.min(15, state.settings.countdown))
    try {
      for (let left = steps; left > 0; left--) {
        countdown = left
        state.tone(880, 90)
        render()
        await new Promise(resolve => window.setTimeout(resolve, 1000))
      }
      countdown = -1
      state.tone(660, 160)
      render()
      const canvas = await pipe.captureBg()
      rememberBg(state, canvas, 'capture')
      writeBg(canvas, 'capture')
      countdown = 0
      open = false
      flash('room saved')
    } catch (error) {
      countdown = 0
      console.warn('[meet-thanos] capture failed', error)
      flash('could not save the room')
    } finally {
      capturing = false
      render()
    }
  }

  const runUpload = async () => {
    const picked = file.files?.[0]
    file.value = ''
    if (!picked) return
    try {
      const bmp = await createImageBitmap(picked)
      const scale = Math.min(1, 1920 / bmp.width)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(2, Math.round(bmp.width * scale))
      canvas.height = Math.max(2, Math.round(bmp.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
      bmp.close()
      rememberBg(state, canvas, 'upload')
      writeBg(canvas, 'upload')
      open = false
      flash('background set')
    } catch (error) {
      console.warn('[meet-thanos] upload failed', error)
      flash('could not read that image')
    }
  }

  state.refresh = render
  state.onChange = render
  state.flash = message => flash(message)
  state.onFrame = () => {
    checkFlip()
    const now = performance.now()
    if (now - lastFrame <= 250) return
    lastFrame = now
    render()
  }

  const swallowClick = (event: Event) => {
    if (!suppressClick) return false
    suppressClick = false
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  pill.addEventListener('click', (event) => {
    if (swallowClick(event)) return
    open = !open
    render()
  })
  grip.addEventListener('click', (event) => {
    if (swallowClick(event)) return
    event.stopPropagation()
  })
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const rect = host.getBoundingClientRect()
    drag = {
      id: event.pointerId,
      left: rect.left,
      moved: false,
      top: rect.top,
      x: event.clientX,
      y: event.clientY,
    }
    try {
      grip.setPointerCapture(event.pointerId)
    } catch {
      // The pointer can vanish before capture.
    }
  })
  grip.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return
    event.stopPropagation()
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    drag.moved = true
    grip.classList.add('is-dragging')
    place(drag.left + dx, drag.top + dy)
    flip()
  })
  const finishDrag = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return
    event.stopPropagation()
    if (drag.moved) {
      const rect = host.getBoundingClientRect()
      state.settings.x = rect.left
      state.settings.y = rect.top
      writeSettings(state.settings)
      suppressClick = true
      window.setTimeout(() => {
        suppressClick = false
      }, 0)
    }
    drag = null
    grip.classList.remove('is-dragging')
  }
  grip.addEventListener('pointerup', finishDrag)
  grip.addEventListener('pointercancel', finishDrag)
  vanish.addEventListener('click', toggle)
  pause.addEventListener('click', () => {
    state.settings.snap = !state.settings.snap
    save()
  })
  effect.addEventListener('change', () => {
    const next = effect.value
    if (!(effectList as readonly string[]).includes(next)) return
    state.settings.effect = next as typeof state.settings.effect
    save()
  })
  capture.addEventListener('click', () => {
    void runCapture()
  })
  upload.addEventListener('click', () => file.click())
  file.addEventListener('change', () => {
    void runUpload()
  })
  range.addEventListener('input', () => {
    const value = Number.parseFloat(range.value)
    state.settings.sens = value
    setSensitivity(value)
    writeSettings(state.settings)
  })
  duration.addEventListener('input', () => {
    state.settings.duration = Number.parseFloat(duration.value)
    writeSettings(state.settings)
    render()
  })
  power.addEventListener('click', () => {
    state.enabled = !state.enabled
    state.settings.enabled = state.enabled
    if (!state.enabled) {
      state.mode = 'live'
      for (const pipe of state.pipes) pipe.parts.length = 0
    }
    save()
  })

  window.addEventListener('keydown', (event) => {
    const chord = (event.metaKey || event.ctrlKey) && event.shiftKey
    if (chord && event.code === 'KeyX') {
      event.preventDefault()
      toggle()
    }
    if (chord && event.code === 'KeyH') {
      event.preventDefault()
      hidden = !hidden
      render()
    }
    if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyP') {
      event.preventDefault()
      state.settings.snap = !state.settings.snap
      save()
    }
  }, true)

  ;(document.body ?? document.documentElement).append(host)
  render()
  settle()
  window.addEventListener('resize', settle)
  window.setInterval(render, 1000)
}
