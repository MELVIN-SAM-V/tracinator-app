import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import type { Window as TauriWindow } from '@tauri-apps/api/window'
import { inTauri, tauriWindowModule } from '../lib/tauri'

// VS Code-style window controls: only the desktop build has a frameless
// window (src-tauri/src/lib.rs's main WebviewWindowBuilder sets
// decorations(false)) — the web/demo build and `tracinator ui` keep the
// browser's own chrome, so this renders nothing there.
export default function WindowControls() {
  const [enabled, setEnabled] = useState(false)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!inTauri()) return
    setEnabled(true)

    let cancelled = false
    let unlisten: (() => void) | undefined

    tauriWindowModule().then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      const sync = () => {
        win.isMaximized().then((m) => {
          if (!cancelled) setMaximized(m)
        })
      }
      sync()
      unlisten = await win.onResized(sync)
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  if (!enabled) return null

  const withWindow = (fn: (win: TauriWindow) => unknown) => {
    tauriWindowModule().then(({ getCurrentWindow }) => fn(getCurrentWindow()))
  }

  return (
    <div className="flex items-stretch h-full ml-auto shrink-0">
      <button
        onClick={() => withWindow((w) => w.minimize())}
        aria-label="Minimize"
        className="flex items-center justify-center w-11 text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={() => withWindow((w) => w.toggleMaximize())}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        className="flex items-center justify-center w-11 text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors"
      >
        {maximized ? <Copy size={12} className="-scale-x-100" /> : <Square size={11} />}
      </button>
      <button
        onClick={() => withWindow((w) => w.close())}
        aria-label="Close"
        className="flex items-center justify-center w-11 text-gray-400 hover:text-white hover:bg-red-600 transition-colors"
      >
        <X size={15} />
      </button>
    </div>
  )
}
