# Meet Thanos

Snap your fingers and vanish from your own video in Google Meet, Jitsi and Yandex Telemost. You stay in the call, your picture dissolves (6 effects to choose from) and leaves an empty room behind, until you snap again.

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
2. A small dark pill appears in the top left. Click it. Everything is controlled from there:
   - **Turn snap off** — the camera goes to the call untouched and the mic is released. Press `turn snap on` to come back.
   - **Background** — Snap needs to know what's behind you. Either:
     - **Capture empty room**: press it, step out of frame, and wait for the beep. The countdown is 5 seconds by default (stored with the other settings; there is no slider for it).
     - **Upload background**: if you use a macOS camera background (Control Center → Video Effects → Background), upload the same picture. The camera then already shows you on top of a known image, so the cut-out is clean and you never need to leave the frame. Snap figures out on its own if the picture needs to be mirrored.
     The background is saved in the userscript manager, so it survives reloads and is the same on Meet, Jitsi and Telemost.
   - **Effect** — pick one of 6.
   - **Duration** — how long the vanish takes.
3. Snap your fingers (a normal, sharp snap) to vanish. Snap again to come back. You can snap as many times as you like, and snapping mid-way turns the effect around.

**Pause snap** — the button next to Vanish, or `Alt`/`Option` `+ Shift + P`, stops listening for snaps, so nothing fires by mistake while you talk, type or clap. The mic is released, the pill shows `armed, snap paused`, and `vanish / return` plus `Cmd`/`Ctrl` `+ Shift + X` still work. Press it again to resume.

`Cmd`/`Ctrl` `+ Shift + H` hides the pill.

Turning the camera off and on again keeps the saved room. Everyone in the call sees the same picture you do, because the effect is applied to the camera track itself. Screen sharing is left untouched.

## Effects

| Effect | What happens |
| --- | --- |
| Dust | The original: you crumble into grains that drift away |
| Burn | A glowing edge eats through you like burning paper, embers float up |
| Ghost | You go soft and see-through and drift upwards |
| Melt | You drip down like wax |
| Portal | You spin and shrink into a purple vortex that closes behind you |
| Hedge | The Homer Simpson ("Homer Loves Flanders", 1994): you step back while two hedges slide in from the left and the right in front of you, swaying. They close with a rustle and a burst of leaves, then part again and you're gone. Coming back is Homer stepping out of the hedge |

## Troubleshooting

- **Not reacting to snaps** — open the pill and move `snap sensitivity` to the right. If the mic is asleep, click once anywhere on the call page (Chrome keeps audio paused until you do). Snapping close to the laptop works best.
- **Triggers on its own** — move the same slider to the left. Snap ignores clicks that come right before or after other sounds (talking, typing), but a single loud isolated key press can still count.
- **The disappearing looks messy / leaves a trace** — the lighting changed since you captured the room. Capture again, or use a macOS camera background and upload the same image.
- **The pill never shows up** — reload the tab after installing, and check that the script is enabled. It only runs on the sites listed above.
- Keep the camera still and the lighting steady, otherwise the saved room stops matching reality.

## Privacy

Everything happens locally, inside your browser: no camera frame and no microphone audio is ever sent anywhere, and the script talks to no server. The microphone is only used to listen for the finger snap itself. The audio is never stored or recorded, and it is released when Snap is switched off or the finger snap trigger is paused. The saved background and the other pill settings stay in the userscript manager on your computer, shared across Meet, Jitsi and Telemost.

## Develop

```bash
pnpm install
pnpm dev
pnpm type-check
pnpm build
```

`pnpm build` writes `dist/meet-thanos.user.js`.
