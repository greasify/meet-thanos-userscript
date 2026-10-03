import type { PlatformId } from '../platforms/registry'
import type { SnapState } from '../state'
import { effects } from '../effect/effects'
import { Pipeline, tick } from '../effect/pipeline'
import { isCameraRequest } from '../platforms/camera'
import { startSnapDetector } from '../snap/detector'

function settingsOf(real: MediaStreamTrack, pipe: Pipeline): MediaTrackSettings {
  return {
    ...real.getSettings(),
    height: pipe.H,
    width: pipe.W,
  }
}

/**
 * Meet clones the camera track and later stops the clone. Without this,
 * `stop` on that clone never tears the pipeline down.
 * The first stop — original or any clone — releases the real camera.
 */
function wrapOutputTrack(outTrack: MediaStreamTrack, realTrack: MediaStreamTrack, pipe: Pipeline) {
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    pipe.destroy()
    try {
      realTrack.stop()
    } catch {
      // The camera track can already be ended.
    }
  }

  const decorate = (track: MediaStreamTrack): MediaStreamTrack => {
    const realStop = track.stop.bind(track)
    const realClone = track.clone.bind(track)
    track.stop = () => {
      realStop()
      cleanup()
    }
    track.clone = () => decorate(realClone())
    track.getSettings = () => settingsOf(realTrack, pipe)
    track.getCapabilities = () => realTrack.getCapabilities()
    track.getConstraints = () => realTrack.getConstraints()
    track.applyConstraints = constraints => realTrack.applyConstraints(constraints)
    try {
      Object.defineProperty(track, 'label', { value: realTrack.label })
    } catch {
      // Some tracks expose a readonly label.
    }
    return track
  }

  realTrack.addEventListener('ended', () => {
    cleanup()
    try {
      outTrack.dispatchEvent(new Event('ended'))
    } catch {
      // The output track can already be ended.
    }
  })

  return decorate(outTrack)
}

async function openPreview(videoTrack: MediaStreamTrack) {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([videoTrack])
  Object.assign(video.style, {
    height: '1px',
    left: '-9999px',
    opacity: '0',
    pointerEvents: 'none',
    position: 'fixed',
    width: '1px',
  })
  // A detached video often never reaches a decoded frame, so the canvas stays
  // empty and Jitsi treats the capture track as a dead camera.
  ;(document.documentElement ?? document.body).append(video)
  await new Promise<void>((resolve) => {
    video.onloadedmetadata = () => {
      resolve()
    }
    window.setTimeout(resolve, 3000)
  })
  await video.play().catch(() => {})
  if (video.readyState >= 2) return video
  await new Promise<void>((resolve) => {
    video.addEventListener('loadeddata', () => resolve(), { once: true })
    window.setTimeout(resolve, 1000)
  })
  return video
}

function untilTrackLive(track: MediaStreamTrack) {
  if (!track.muted && track.readyState === 'live') return Promise.resolve()
  return new Promise<void>((resolve) => {
    const finish = () => {
      track.removeEventListener('unmute', finish)
      resolve()
    }
    track.addEventListener('unmute', finish)
    window.setTimeout(finish, 1000)
  })
}

function beep(ac: AudioContext, freq: number, ms: number) {
  if (ac.state !== 'running') return
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.frequency.value = freq
  gain.gain.value = 0.05
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start()
  osc.stop(ac.currentTime + ms / 1000)
}

export function installCameraHook(state: SnapState, platformId: PlatformId) {
  const media = navigator.mediaDevices
  const proto = MediaDevices.prototype
  if (!media?.getUserMedia || !proto.getUserMedia) return { toggle: () => {} }
  if (proto.getUserMedia.name === 'meetThanosGetUserMedia') return { toggle: () => {} }

  const origGetUserMedia = proto.getUserMedia
  let detector: { ac: AudioContext, stop: () => void } | null = null
  let starting = false

  const toggle = () => {
    if (!state.enabled) {
      state.flash('snap is off')
      return
    }
    if (!state.active) {
      state.flash('no camera yet')
      return
    }
    if (!state.bg) {
      state.flash('set a background first')
      return
    }
    const now = performance.now()
    tick(state, now)
    const dur = Math.max(500, Math.min(6000, state.settings.duration))
    if (state.mode === 'live' || state.mode === 'gone') {
      if (state.mode === 'live') state.effect = state.settings.effect
      state.mode = state.mode === 'live' ? 'out' : 'in'
      state.dur = dur * (effects[state.effect].durScale ?? 1)
      state.t0 = now
      state.t = 0
      state.transId += 1
    } else {
      state.mode = state.mode === 'out' ? 'in' : 'out'
      state.t0 = now - (1 - state.t) * state.dur
      state.t = 1 - state.t
    }
    state.refresh()
  }

  const wantMic = () => state.enabled && state.settings.snap && !!state.active

  const syncDetector = () => {
    if (!wantMic()) {
      detector?.stop()
      detector = null
      state.tone = () => {}
      return
    }
    if (detector || starting) return
    starting = true
    void startSnapDetector(
      constraints => origGetUserMedia.call(media, constraints),
      toggle,
    ).then((next) => {
      starting = false
      if (!wantMic()) {
        next.stop()
        return
      }
      detector = next
      state.tone = (freq, ms) => beep(next.ac, freq, ms)
    }).catch((error: unknown) => {
      starting = false
      console.warn('[meet-thanos] mic snap detection unavailable', error)
      state.flash('snap sound off, use the button')
    })
  }

  state.onPipes = syncDetector
  window.setInterval(() => tick(state, performance.now()), 250)

  async function meetThanosGetUserMedia(this: MediaDevices, constraints?: MediaStreamConstraints) {
    if (!isCameraRequest(platformId, constraints)) return origGetUserMedia.call(this, constraints)

    const real = await origGetUserMedia.call(this, constraints)
    let pipe: Pipeline | null = null
    let swapped = false
    const videoTracks = real.getVideoTracks()
    try {
      const videoTrack = videoTracks[0]
      if (!videoTrack) return real

      const video = await openPreview(videoTrack)
      pipe = new Pipeline(video, state)
      pipe.start()
      const outTrack = pipe.canvas.captureStream(30).getVideoTracks()[0]
      if (!outTrack) {
        pipe.destroy()
        return real
      }
      // Frames painted before captureStream do not count. Jitsi drops a video
      // track that is still muted when the promise resolves.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      pipe.frame()
      await untilTrackLive(outTrack)

      const wrapped = wrapOutputTrack(outTrack, videoTrack, pipe)
      state.active = pipe
      syncDetector()
      state.refresh()
      for (const track of videoTracks) real.removeTrack(track)
      swapped = true
      real.addTrack(wrapped)
      return real
    } catch (error) {
      pipe?.destroy()
      if (swapped) {
        for (const track of real.getVideoTracks()) real.removeTrack(track)
        for (const track of videoTracks) real.addTrack(track)
      }
      console.warn('[meet-thanos] falling back to the normal camera', error)
      return real
    }
  }

  Object.defineProperty(meetThanosGetUserMedia, 'name', { value: 'meetThanosGetUserMedia' })
  proto.getUserMedia = meetThanosGetUserMedia
  // Jitsi calls the instance method. webrtc-adapter also stores its own copy
  // there, which hides a prototype-only hook.
  if (media.getUserMedia !== meetThanosGetUserMedia) media.getUserMedia = meetThanosGetUserMedia
  return { toggle }
}
