import { installCameraHook } from './media/hook'
import { detectPlatform } from './platforms/registry'
import { readBg } from './snap/settings'
import { createState, rememberBg } from './state'
import { mountPanel } from './ui/panel'

const platform = detectPlatform(location.href)

if (platform) {
  const state = createState()
  const { toggle } = installCameraHook(state, platform.id)
  void readBg().then((saved) => {
    if (!saved) return
    rememberBg(state, saved.canvas, saved.source)
    state.refresh()
  })
  const mount = () => {
    try {
      mountPanel(state, toggle)
    } catch (error) {
      console.error('[meet-thanos] could not draw the control pill', error)
    }
  }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)
}
