export const platforms = [
  {
    id: 'google-meet',
    matches: [
      'https://meet.google.com/*',
    ],
  },
  {
    id: 'jitsi',
    matches: [
      'https://meet.jit.si/*',
      'https://meet.it-expertise.ru/*',
    ],
  },
  {
    id: 'telemost',
    matches: [
      'https://telemost.yandex.ru/private-join/*',
    ],
  },
  {
    id: 'zoom',
    /** Workplace is a shell. The camera exists only in the meeting iframe. */
    frame: 'child',
    matches: [
      'https://app.zoom.us/*',
      'https://app.zoom.com/*',
      'https://home.zoom.us/*',
      'https://home.zoom.com/*',
      'https://zoom.us/wc/*',
      'https://zoom.com/wc/*',
      'https://*.zoom.us/wc/*',
      'https://*.zoom.com/wc/*',
      'https://app.zoomgov.com/*',
      'https://zoomgov.com/wc/*',
      'https://*.zoomgov.com/wc/*',
    ],
  },
] as const

export type PlatformId = (typeof platforms)[number]['id']

/** Single list for `@match` and runtime detection. A new host is one entry here. */
export const userscriptMatches: string[] = platforms.flatMap(platform => [...platform.matches])

function hostOf(pattern: string) {
  const scheme = pattern.indexOf('://')
  const afterScheme = scheme === -1 ? pattern : pattern.slice(scheme + 3)
  const slash = afterScheme.indexOf('/')
  return slash === -1 ? afterScheme : afterScheme.slice(0, slash)
}

/** `*.zoom.us` matches that domain and any subdomain. `@match` still owns the path. */
function hostMatches(patternHost: string, hostname: string) {
  if (!patternHost.startsWith('*.')) return patternHost === hostname
  const domain = patternHost.slice(2)
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

export function detectPlatform(href: string) {
  const hostname = new URL(href).hostname
  return platforms.find(platform => platform.matches.some(pattern => hostMatches(hostOf(pattern), hostname)),
  ) ?? null
}

/** A `child` platform starts only inside the meeting iframe, never on the top page. */
export function shouldStart(platform: (typeof platforms)[number]) {
  if (!('frame' in platform) || platform.frame !== 'child') return true
  return window.top !== window
}
