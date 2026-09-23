import React, { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'

export interface TourStep {
  // CSS selector for the element this step is about.
  selector: string
  message: string
  // 'point' (default) — a precise target (a button, a field): tight spotlight,
  // brightened icon/text, and a thick arrow running straight into it.
  // 'area' — a whole panel: roomier spotlight outline, bubble docked inside it,
  // no arrow (an arrow into the middle of a 400px-wide panel points at nothing
  // in particular, and force-brightening a whole panel's text would fight
  // Monaco's own syntax-highlight colors).
  kind?: 'point' | 'area'
  // Arrow direction for 'point' steps — which side of the target the bubble sits on.
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

interface Props {
  steps: TourStep[]
  onDone: () => void
}

const POINT_PADDING = 6
const AREA_PADDING = 4
const ARROW_LEN = 40
const ARROW_LEAD = 6
const BUBBLE_WIDTH = 240

// A sequential, one-shot coachmark: highlights exactly one real element at a time
// with a spotlight cutout, an explanation bubble, and (for precise targets) a
// thick arrow pointing straight at it. Any click anywhere advances to the next
// step; the last click hands off to onDone, after which the overlay is gone and
// the real UI responds to clicks normally again.
export default function Onboarding({ steps, onDone }: Props) {
  const maskId = useId()
  const arrowId = useId()
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const step = steps[i]

  useEffect(() => {
    if (!step) return
    const measure = () => {
      const el = document.querySelector(step.selector)
      setRect(el ? el.getBoundingClientRect() : null)
    }
    measure()
    // Layout (Monaco mount, modal open animation) can still be settling a frame
    // after a step first becomes active — remeasure once more to catch it.
    const raf = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [step])

  // Brighten the real element for a 'point' step only — see the TourStep doc
  // comment for why 'area' steps skip this.
  useEffect(() => {
    if (!step || step.kind === 'area') return
    const el = document.querySelector(step.selector) as HTMLElement | null
    el?.classList.add('tour-spotlight-active')
    return () => el?.classList.remove('tour-spotlight-active')
  }, [step])

  if (!step || !rect) return null

  const advance = () => {
    if (i < steps.length - 1) setI((n) => n + 1)
    else onDone()
  }

  const kind = step.kind ?? 'point'
  const padding = kind === 'area' ? AREA_PADDING : POINT_PADDING
  const hx = rect.x - padding
  const hy = rect.y - padding
  const hw = rect.width + padding * 2
  const hh = rect.height + padding * 2
  const isLast = i === steps.length - 1

  return createPortal(
    <div
      className="fixed inset-0 z-[100] cursor-pointer"
      onClick={advance}
      role="button"
      aria-label={isLast ? 'Finish walkthrough' : 'Next step'}
    >
      <svg className="absolute inset-0 w-full h-full pointer-events-none">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            <rect x={hx} y={hy} width={hw} height={hh} rx={12} fill="black" />
          </mask>
          <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#818cf8" />
          </marker>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(9,10,15,0.8)" mask={`url(#${maskId})`} />
        <rect x={hx} y={hy} width={hw} height={hh} rx={12} fill="none" stroke="#818cf8" strokeOpacity={0.85} strokeWidth={2} />
        {kind === 'point' && (
          <Arrow rect={rect} padding={padding} placement={step.placement ?? 'bottom'} markerId={arrowId} />
        )}
      </svg>

      <Bubble rect={rect} step={step} kind={kind} padding={padding} index={i} total={steps.length} onSkip={onDone} />
    </div>,
    document.body,
  )
}

// The point on the target's padded edge the arrow terminates at, and the point
// ARROW_LEN further out where it starts — also where the bubble docks, so the
// bubble reads as continuing the same straight line down into the target.
function arrowPoints(rect: DOMRect, padding: number, placement: NonNullable<TourStep['placement']>) {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  switch (placement) {
    case 'bottom': {
      const endY = rect.bottom + padding + ARROW_LEAD
      return { start: { x: cx, y: endY + ARROW_LEN }, end: { x: cx, y: endY } }
    }
    case 'top': {
      const endY = rect.top - padding - ARROW_LEAD
      return { start: { x: cx, y: endY - ARROW_LEN }, end: { x: cx, y: endY } }
    }
    case 'right': {
      const endX = rect.right + padding + ARROW_LEAD
      return { start: { x: endX + ARROW_LEN, y: cy }, end: { x: endX, y: cy } }
    }
    case 'left': {
      const endX = rect.left - padding - ARROW_LEAD
      return { start: { x: endX - ARROW_LEN, y: cy }, end: { x: endX, y: cy } }
    }
  }
}

function Arrow({
  rect,
  padding,
  placement,
  markerId,
}: {
  rect: DOMRect
  padding: number
  placement: NonNullable<TourStep['placement']>
  markerId: string
}) {
  const { start, end } = arrowPoints(rect, padding, placement)
  return (
    <line
      x1={start.x}
      y1={start.y}
      x2={end.x}
      y2={end.y}
      stroke="#818cf8"
      strokeWidth={4}
      strokeLinecap="round"
      markerEnd={`url(#${markerId})`}
    />
  )
}

function Bubble({
  rect,
  step,
  kind,
  padding,
  index,
  total,
  onSkip,
}: {
  rect: DOMRect
  step: TourStep
  kind: 'point' | 'area'
  padding: number
  index: number
  total: number
  onSkip: () => void
}) {
  const isLast = index === total - 1
  const style: React.CSSProperties = { width: BUBBLE_WIDTH }

  if (kind === 'area') {
    const w = Math.max(180, Math.min(BUBBLE_WIDTH, rect.width - 40))
    style.width = w
    style.left = Math.max(rect.left + 20, 12)
    style.bottom = Math.max(window.innerHeight - rect.bottom + 20, 12)
  } else {
    const placement = step.placement ?? 'bottom'
    const { start } = arrowPoints(rect, padding, placement)
    const half = BUBBLE_WIDTH / 2 + 10

    if (placement === 'bottom' || placement === 'top') {
      style.left = Math.min(Math.max(start.x, half), window.innerWidth - half)
      style.transform = 'translateX(-50%)'
      if (placement === 'bottom') style.top = start.y
      else style.bottom = window.innerHeight - start.y
    } else {
      // Bubble height is dynamic (message length), so this is an estimate rather
      // than a measured value — good enough to keep it from clipping off-screen
      // for a target sitting near the very top or bottom of the viewport.
      const halfV = 70
      style.top = Math.min(Math.max(start.y, halfV), window.innerHeight - halfV)
      style.transform = 'translateY(-50%)'
      if (placement === 'right') style.left = start.x
      else style.right = window.innerWidth - start.x
    }
  }

  return (
    <div className="absolute pointer-events-none" style={style}>
      <div className="bg-gray-900 border border-indigo-400/70 rounded-lg px-3.5 py-3 text-xs text-gray-200 shadow-2xl leading-snug">
        <div className="flex items-center justify-between mb-1.5 gap-3">
          <span className="text-[10px] font-semibold tracking-wide text-indigo-300 shrink-0">
            {index + 1} / {total}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onSkip()
            }}
            className="pointer-events-auto text-[10px] text-gray-500 hover:text-gray-300 transition-colors shrink-0"
          >
            Skip
          </button>
        </div>
        <p>{step.message}</p>
        <p className="mt-1.5 text-[10px] text-gray-500">{isLast ? 'Click to finish' : 'Click to continue'}</p>
      </div>
    </div>
  )
}
