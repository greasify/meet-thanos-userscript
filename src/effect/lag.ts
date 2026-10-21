/* eslint-disable antfu/top-level-function */

export const LAG_FPS = 15
export const LAG_MAX_MS = 5000
export const LAG_MIN_MS = 200

const FRAME_MS = 1000 / LAG_FPS

export interface LagTimeline {
  duration: number
  marks: number[]
  nextCaptureAt: number
  playbackAt: number | null
  startedAt: number
}

export interface LagStep {
  captureIndex: number | null
  playbackIndex: number | null
  progress: number
  recording: boolean
}

const clampDuration = (duration: number) => Math.min(LAG_MAX_MS, Math.max(LAG_MIN_MS, duration))

export const createLagTimeline = (startedAt: number, duration: number): LagTimeline => ({
  duration: clampDuration(duration),
  marks: [],
  nextCaptureAt: startedAt,
  playbackAt: null,
  startedAt,
})

const frameHolds = (timeline: LagTimeline) => timeline.marks.map((mark, index) => {
  const next = timeline.marks[index + 1] ?? timeline.duration
  return Math.max(1, next - mark)
})

const frameIndexAt = (elapsed: number, indexes: number[], holds: number[]) => {
  const span = indexes.reduce((sum, index) => sum + (holds[index] ?? 1), 0) || 1
  const local = ((elapsed % span) + span) % span
  let covered = 0
  for (const index of indexes) {
    covered += holds[index] ?? 1
    if (local < covered) return index
  }
  return indexes.at(-1) ?? 0
}

const playbackIndex = (timeline: LagTimeline, elapsed: number, reverse: boolean) => {
  const count = timeline.marks.length
  if (count < 2) return 0
  const forward = Array.from({ length: count }, (_, index) => index)
  if (!reverse) return frameIndexAt(elapsed, forward, frameHolds(timeline))
  const backward = Array.from({ length: Math.max(0, count - 2) }, (_, index) => count - 2 - index)
  return frameIndexAt(elapsed, [...forward, ...backward], frameHolds(timeline))
}

export const advanceLagTimeline = (timeline: LagTimeline, now: number, reverse: boolean): LagStep => {
  const elapsed = Math.max(0, now - timeline.startedAt)
  if (elapsed < timeline.duration) {
    let captureIndex: number | null = null
    if (now >= timeline.nextCaptureAt) {
      captureIndex = timeline.marks.length
      timeline.marks.push(elapsed)
      do timeline.nextCaptureAt += FRAME_MS
      while (timeline.nextCaptureAt <= now)
    }
    return {
      captureIndex,
      playbackIndex: null,
      progress: Math.min(1, elapsed / timeline.duration),
      recording: true,
    }
  }

  timeline.playbackAt ??= now
  return {
    captureIndex: null,
    playbackIndex: playbackIndex(timeline, now - timeline.playbackAt, reverse),
    progress: 1,
    recording: false,
  }
}
