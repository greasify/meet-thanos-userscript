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
    ],
  },
  {
    id: 'telemost',
    matches: [
      'https://telemost.yandex.ru/private-join/*',
    ],
  },
] as const

export type PlatformId = (typeof platforms)[number]['id']

/** Single list for `@match` and runtime detection. A new host is one entry here. */
export const userscriptMatches: string[] = platforms.flatMap(platform => [...platform.matches])

const hostnameOf = (pattern: string) => new URL(pattern.replaceAll('*', '')).hostname

export function detectPlatform(href: string) {
  const hostname = new URL(href).hostname
  return platforms.find(platform => platform.matches.some(pattern => hostnameOf(pattern) === hostname),
  ) ?? null
}
