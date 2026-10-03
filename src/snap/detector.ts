const WORKLET = `
class SnapMeter extends AudioWorkletProcessor {
  constructor() {
    super()
    this.n = 0
    this.sr = 0
    this.sh = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input.length) return true
    const raw = input[0]
    const hi = input[1] || input[0]
    for (let i = 0; i < raw.length; i++) {
      this.sr += raw[i] * raw[i]
      this.sh += hi[i] * hi[i]
    }
    this.n += raw.length
    if (this.n >= 256) {
      this.port.postMessage([Math.sqrt(this.sr / this.n), Math.sqrt(this.sh / this.n), currentFrame])
      this.n = 0
      this.sr = 0
      this.sh = 0
    }
    return true
  }
}
registerProcessor('snap-meter', SnapMeter)
`

const CHUNK = 256
const MIN_ABS = 0.0024
const MAX_BURST = 90
const COOLDOWN = 1000
const BRIGHT = 0.3
const QUIET_BEFORE = 50
const ALONE_AFTER = 220

type SnapStateName = 'burst' | 'confirm' | 'idle' | 'reject'

let sensitivity = 9

export function setSensitivity(value: number) {
  if (value >= 2 && value <= 20) sensitivity = value
}

function openAudioContext() {
  const Ctx = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) throw new Error('AudioContext unavailable')
  return new Ctx()
}

async function loadWorklet(ac: AudioContext) {
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
  try {
    await Promise.race([
      ac.audioWorklet.addModule(url),
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error('worklet load timed out')), 3000)
      }),
    ])
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function startSnapDetector(
  getUserMedia: typeof navigator.mediaDevices.getUserMedia,
  onSnap: () => void,
) {
  const stream = await getUserMedia({
    audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false },
  })
  const ac = openAudioContext()
  const src = ac.createMediaStreamSource(stream)
  const hp = ac.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 2000
  const merge = ac.createChannelMerger(2)
  src.connect(merge, 0, 0)
  src.connect(hp)
  hp.connect(merge, 0, 1)
  const mute = ac.createGain()
  mute.gain.value = 0
  mute.connect(ac.destination)

  const resume = () => {
    if (ac.state === 'suspended') void ac.resume().catch(() => {})
  }
  const wakeEvents = ['pointerdown', 'keydown', 'click'] as const
  for (const ev of wakeEvents) window.addEventListener(ev, resume, true)
  const wake = window.setInterval(resume, 2000)
  resume()

  let floor = 0.002
  let state: SnapStateName = 'idle'
  let peak = 0
  let t0 = 0
  let tEnd = 0
  let lastFire = -1e9
  let rejectAt = 0
  let dur = 0
  const hist = new Float32Array(QUIET_BEFORE)
  const histR = new Float32Array(QUIET_BEFORE)
  let head = 0
  let peakR = 0
  let rawBefore = 0

  const step = (rmsR: number, rms: number, now: number) => {
    floor += (rms - floor) * (rms < floor ? 0.2 : 0.003)
    if (floor < 0.0003) floor = 0.0003
    const trigger = Math.max(floor * sensitivity, MIN_ABS * sensitivity)
    let before = 0
    let beforeR = 0
    for (let k = 0; k < QUIET_BEFORE - 1; k++) {
      const q = (head + k) % QUIET_BEFORE
      const hi = hist[q] as number
      const raw = histR[q] as number
      if (hi > before) before = hi
      if (raw > beforeR) beforeR = raw
    }

    if (state === 'idle') {
      if (rms > trigger && before < trigger * 0.3 && rms > rmsR * BRIGHT) {
        state = 'burst'
        peak = rms
        peakR = rmsR
        rawBefore = beforeR
        t0 = now
      }
    } else if (state === 'burst') {
      peak = Math.max(peak, rms)
      peakR = Math.max(peakR, rmsR)
      dur = now - t0
      if (dur > MAX_BURST || rawBefore > peakR * 0.2) {
        state = 'reject'
        rejectAt = now
      } else if (rms < peak * 0.25) {
        state = 'confirm'
        tEnd = now
      }
    } else if (state === 'confirm') {
      if (rms > Math.max(trigger * 0.5, peak * 0.35) || rmsR > peakR * 0.3) {
        state = 'reject'
        rejectAt = now
      } else if (now - tEnd > ALONE_AFTER) {
        state = 'idle'
        if (now - lastFire > COOLDOWN) {
          lastFire = now
          try {
            onSnap()
          } catch (error) {
            console.warn('[meet-thanos] snap listener failed', error)
          }
        }
      }
    } else if ((rms < trigger * 0.4 && now - rejectAt > 150) || now - rejectAt > 600) {
      state = 'idle'
    }
    hist[head] = rms
    histR[head] = rmsR
    head = (head + 1) % QUIET_BEFORE
  }

  let node: AudioWorkletNode | null = null
  let processor: ScriptProcessorNode | null = null
  try {
    if (!ac.audioWorklet) throw new Error('no worklet')
    await loadWorklet(ac)
    node = new AudioWorkletNode(ac, 'snap-meter', {
      channelCount: 2,
      channelCountMode: 'explicit',
      numberOfInputs: 1,
      numberOfOutputs: 1,
    })
    node.port.onmessage = (ev: MessageEvent<number[]>) => {
      const r = ev.data[0]
      const h = ev.data[1]
      const frame = ev.data[2]
      if (r == null || h == null || frame == null) return
      step(r, h, (frame * 1000) / ac.sampleRate)
    }
    merge.connect(node)
    node.connect(mute)
  } catch (error) {
    console.info('[meet-thanos] audio worklet unavailable, using the fallback', error)
    let frames = 0
    processor = ac.createScriptProcessor(CHUNK, 2, 1)
    processor.onaudioprocess = (event) => {
      const raw = event.inputBuffer.getChannelData(0)
      const hi = event.inputBuffer.getChannelData(1)
      let sr = 0
      let sh = 0
      for (let i = 0; i < hi.length; i++) {
        const sample = raw[i] as number
        const high = hi[i] as number
        sr += sample * sample
        sh += high * high
      }
      step(Math.sqrt(sr / raw.length), Math.sqrt(sh / hi.length), (frames++ * CHUNK * 1000) / ac.sampleRate)
    }
    merge.connect(processor)
    processor.connect(mute)
  }

  return {
    ac,
    stop() {
      if (node) node.port.onmessage = null
      if (processor) processor.onaudioprocess = null
      window.clearInterval(wake)
      for (const track of stream.getTracks()) track.stop()
      for (const ev of wakeEvents) window.removeEventListener(ev, resume, true)
      void ac.close().catch(() => {})
    },
  }
}
