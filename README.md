# Meet Thanos

Snap your fingers and vanish from your own video in Google Meet, Jitsi and Yandex Telemost. You stay in the call, your picture dissolves into particles and leaves the empty room behind, until you snap again.

Everything runs locally in your browser: no video or audio is ever sent anywhere, and it works offline (aside from the call itself).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/), Greasemonkey or Violentmonkey.
2. Open the [userscript](https://greasify.github.io/meet-thanos-userscript/meet-thanos.user.js) and confirm the install.
3. Reload the call tab if it was already open.

The script starts at `document-start` and replaces the camera track before the page reads it. A dev build from `pnpm dev` loads asynchronously, so check the effect with the production `meet-thanos.user.js`.

## Sites

- Google Meet — `https://meet.google.com/*`
- Jitsi — `https://meet.jit.si/*`
- Yandex Telemost — `https://telemost.yandex.ru/*`

Another Jitsi host is one entry in [`src/platforms/registry.ts`](src/platforms/registry.ts). That list is also the userscript `@match`.

## How to use it

1. Open a room and allow camera and microphone access when the browser asks. Do this on the prejoin preview, before you join.
2. A small dark pill button appears above the toolbar, on the left. Click it, then click `capture empty room`.
3. Step out of frame for about 3 seconds. The script takes a photo of the empty room.
4. Sit back down. The status changes to `armed`. Join the call.
5. Snap your fingers (a normal, sharp snap). You'll dissolve into particles and disappear from the video. Snap again to come back.

Turning the camera off and on again keeps the saved room. Everyone in the call sees the same picture you do, because the effect is applied to the camera track itself.

Backup options if the snap isn't heard: the `vanish / return` button in the panel, or the shortcut `Cmd` (on Windows, `Ctrl`) `+ Shift + X`.
To hide the pill while recording: `Cmd` / `Ctrl` `+ Shift + H`.

## Troubleshooting

- **Not reacting to snaps** — open the panel (click the status text) and move the `snap sensitivity` slider to the right (more sensitive).
- **Triggers on its own**, for example from talking or knocking — move the same slider to the left (less sensitive).
- **The disappearing looks messy / leaves a trace** — the lighting has changed since `capture empty room`. Click it again right before the call.
- **The button never shows up** — reload the tab after installing, and check that the script is enabled. It only runs on the sites listed above.
- Keep the camera still and the lighting steady, otherwise the saved empty room stops matching reality.
- Screen sharing is left untouched. The vanish effect applies to the camera only.

## Privacy

Everything happens locally, inside your browser: no camera frame and no microphone audio is ever sent anywhere, and the script talks to no server. The microphone is only used to listen for the finger snap itself. The audio is never stored or recorded.

## Develop

```bash
pnpm install
pnpm dev
pnpm type-check
pnpm build
```

`pnpm build` writes `dist/meet-thanos.user.js`.
