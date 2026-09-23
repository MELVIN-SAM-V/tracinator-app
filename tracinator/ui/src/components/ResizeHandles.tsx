import { useEffect, useState } from 'react'
import { inTauri, tauriWindowModule } from '../lib/tauri'

// A frameless window (decorations(false) in src-tauri/src/lib.rs) loses the
// OS's own edge/corner resize hit-testing, so it has to be reimplemented by
// hand — this is the standard Tauri pattern for it: thin invisible strips
// along the window's border that hand off to the OS's native resize drag via
// startResizeDragging, rather than resizing in JS.
//
// `Window.startResizeDragging` types its argument as `ResizeDirection`, but
// that type isn't actually re-exported from @tauri-apps/api/window — these
// string literals match it exactly regardless.
type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West'

const HANDLES: { direction: ResizeDirection; className: string; cursor: string }[] = [
  { direction: 'North', className: 'top-0 left-1.5 right-1.5 h-1', cursor: 'cursor-n-resize' },
  { direction: 'South', className: 'bottom-0 left-1.5 right-1.5 h-1', cursor: 'cursor-s-resize' },
  { direction: 'West', className: 'left-0 top-1.5 bottom-1.5 w-1', cursor: 'cursor-w-resize' },
  { direction: 'East', className: 'right-0 top-1.5 bottom-1.5 w-1', cursor: 'cursor-e-resize' },
  { direction: 'NorthWest', className: 'top-0 left-0 w-1.5 h-1.5', cursor: 'cursor-nw-resize' },
  { direction: 'NorthEast', className: 'top-0 right-0 w-1.5 h-1.5', cursor: 'cursor-ne-resize' },
  { direction: 'SouthWest', className: 'bottom-0 left-0 w-1.5 h-1.5', cursor: 'cursor-sw-resize' },
  { direction: 'SouthEast', className: 'bottom-0 right-0 w-1.5 h-1.5', cursor: 'cursor-se-resize' },
]

export default function ResizeHandles() {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    setEnabled(inTauri())
  }, [])

  if (!enabled) return null

  const startResize = (direction: ResizeDirection) => {
    tauriWindowModule().then(({ getCurrentWindow }) => getCurrentWindow().startResizeDragging(direction))
  }

  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.direction}
          onMouseDown={() => startResize(h.direction)}
          className={`fixed z-50 ${h.className} ${h.cursor}`}
        />
      ))}
    </>
  )
}
