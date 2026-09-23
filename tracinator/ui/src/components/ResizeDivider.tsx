import { useState } from 'react'

interface Props {
  onMouseDown: (e: React.MouseEvent) => void
}

// Thin drag handle between two panels — pairs with useResizableWidth. Wider
// invisible hit-area than the visible line (VS Code-style) so it's easy to
// grab without needing pixel-perfect aim. Tracks its own `dragging` state
// just to keep the highlight lit for the whole drag — CSS :hover alone
// drops as soon as the mouse outruns the thin hit-area mid-drag, even
// though the drag (driven by useResizableWidth's own window listeners)
// keeps working fine either way.
export default function ResizeDivider({ onMouseDown }: Props) {
  const [dragging, setDragging] = useState(false)

  const handleMouseDown = (e: React.MouseEvent) => {
    setDragging(true)
    const onMouseUp = () => {
      setDragging(false)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mouseup', onMouseUp)
    onMouseDown(e)
  }

  return (
    <div className="relative w-0 shrink-0 z-10 group">
      <div onMouseDown={handleMouseDown} className="absolute inset-y-0 -left-1.5 w-3 cursor-col-resize" />
      {/* pointer-events-none: this is a same-stacking-context sibling of the hit-area
          above, not a descendant — without this, a click landing exactly on the
          (wider, on hover) visible line hits *this* div, which has no mousedown
          handler, instead of passing through to the actual drag target next to it. */}
      <div
        className={`absolute inset-y-0 left-0 pointer-events-none transition-[width,background-color] ${
          dragging ? 'w-1 bg-indigo-500' : 'w-px bg-gray-800 group-hover:bg-indigo-500/70 group-hover:w-1'
        }`}
      />
    </div>
  )
}
