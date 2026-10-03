import type { PlatformId } from './registry'

interface LegacyVideoConstraints extends MediaTrackConstraints {
  chromeMediaSource?: string
  mandatory?: {
    chromeMediaSource?: string
  }
}

function sourceOf(video: boolean | MediaTrackConstraints) {
  if (typeof video !== 'object') return
  const legacy: LegacyVideoConstraints = video
  return legacy.chromeMediaSource ?? legacy.mandatory?.chromeMediaSource
}

/** Meet and Telemost grab the display through `getDisplayMedia`, not `getUserMedia`. */
export function hasVideoTrack(constraints?: MediaStreamConstraints) {
  return Boolean(constraints?.video)
}

/**
 * Older Jitsi builds request screen share via `getUserMedia` and
 * `chromeMediaSource`. That path must stay out of the vanish pipeline.
 */
export function isJitsiCameraRequest(constraints?: MediaStreamConstraints) {
  const video = constraints?.video
  if (!video) return false
  const source = sourceOf(video)
  return !source || source === 'camera'
}

const checks: Record<PlatformId, (constraints?: MediaStreamConstraints) => boolean> = {
  'google-meet': hasVideoTrack,
  'jitsi': isJitsiCameraRequest,
  'telemost': hasVideoTrack,
}

export function isCameraRequest(platformId: PlatformId, constraints?: MediaStreamConstraints) {
  return checks[platformId](constraints)
}
