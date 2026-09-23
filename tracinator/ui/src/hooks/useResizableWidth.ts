import { useCallback, useRef, useState } from 'react'

interface Options {
  initial: number
  min: number
  max: number
  // The panel being resized sits inside this container, next to a sibling
  // (flex-1) panel. Without measuring the container, `max` alone can't stop
  // a drag from swallowing the sibling entirely — e.g. the files/functions
  // split inside the file browser could be dragged past the file browser's
  // *own* current width (itself resizable) and visibly cross into the graph
  // panel next to it. reserveForOther keeps at least that many px for
  // whatever's on the other side of the container.
  containerRef?: React.RefObject<HTMLElement | null>
  reserveForOther?: number
  // Fires with the exact px change actually applied to `width` (after
  // min/max/container clamping) on every drag step. For a panel nested
  // inside another resizable one — e.g. the files-list panel inside the file
  // browser sidebar — this lets the *outer* panel grow/shrink by the same
  // amount, so dragging the inner divider resizes just this panel instead of
  // eating into its flex-1 sibling's space (the function list).
  onResize?: (delta: number) => void
}

// Drag-to-resize for a fixed-pixel-width panel sitting next to a flexible
// (flex-1) remainder — e.g. the file browser / graph split, or the
// files-list / functions-list split inside the file browser. Tracks the
// divider's own movement from where the drag started rather than measuring
// the resized panel itself, so it works the same way regardless of what
// it's resizing.
export function useResizableWidth({ initial, min, max, containerRef, reserveForOther = 0, onResize }: Options) {
  const [width, setWidth] = useState(initial)
  const dragStart = useRef<{ x: number; width: number } | null>(null)

  const clamp = useCallback(
    (candidate: number) => {
      let upperBound = max
      const container = containerRef?.current
      if (container) {
        upperBound = Math.min(max, container.getBoundingClientRect().width - reserveForOther)
      }
      return Math.min(upperBound, Math.max(min, candidate))
    },
    [min, max, containerRef, reserveForOther],
  )

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragStart.current = { x: e.clientX, width }
      let lastWidth = width

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStart.current) return
        const next = dragStart.current.width + (moveEvent.clientX - dragStart.current.x)
        const clamped = clamp(next)
        setWidth(clamped)
        if (onResize && clamped !== lastWidth) {
          onResize(clamped - lastWidth)
          lastWidth = clamped
        }
      }
      const onMouseUp = () => {
        dragStart.current = null
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [width, clamp, onResize],
  )

  // Lets another panel's own drag (see `onResize` above) grow/shrink this one
  // by a matching delta, subject to this panel's own min/max/container clamp.
  const grow = useCallback((delta: number) => {
    setWidth((w) => clamp(w + delta))
  }, [clamp])

  return { width, onMouseDown, grow }
}
