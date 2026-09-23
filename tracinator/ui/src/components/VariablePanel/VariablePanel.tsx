import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import React from 'react'
import { frameViewSeq, getFrameState, type ViewPoint } from '../../lib/frameQueries'
import type { TraceIndex } from '../../lib/traceIndex'
import type { NavigationState } from '../../lib/traceNavigation'
import type { TraceResult } from '../../types/trace'
import Breadcrumb from './Breadcrumb'
import OccurrenceSelector from './OccurrenceSelector'
import OutputSection from './OutputSection'
import VariableSection from './VariableSection'

interface Props {
  collapsed: boolean
  onToggleCollapse: () => void
  loading: boolean
  error: string | null
  result: TraceResult | null
  index: TraceIndex | null
  nav: NavigationState | null
  breadcrumb: number[]
  notFound: boolean
  viewPoint: ViewPoint
  // The concrete seq `viewPoint` resolved to when it was set — see useTraceView's
  // `viewSeq`. Passed straight through instead of re-resolving here, since a
  // multi-visit loop line has more than one candidate seq and re-resolving with no
  // cursor would silently land on a different (default) pass than the one shown.
  viewSeq: number | null
  onNavigateToFrame: (frameId: number) => void
  onJumpToOccurrence: (index: number) => void
}

export default function VariablePanel({
  collapsed,
  onToggleCollapse,
  loading,
  error,
  result,
  index,
  nav,
  breadcrumb,
  notFound,
  viewPoint,
  viewSeq,
  onNavigateToFrame,
  onJumpToOccurrence,
}: Props) {
  if (collapsed) {
    return (
      <button
        onClick={onToggleCollapse}
        title="Show variable panel"
        className="w-8 shrink-0 flex items-start justify-center pt-3 border-l border-gray-800 bg-gray-900/60 hover:bg-gray-800/60 transition-colors"
      >
        <PanelRightOpen size={15} className="text-gray-500" />
      </button>
    )
  }

  const hasContent = index && nav

  return (
    <div className="w-[320px] shrink-0 border-l border-gray-800 flex flex-col min-h-0 bg-gray-900/40" data-tour="tour-variable-panel">
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-300">Variables</span>
          {viewPoint.kind !== 'exit' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-300 border border-emerald-700/60">
              {viewPoint.kind === 'entry' ? 'at entry' : `at line ${viewPoint.line}`}
            </span>
          )}
        </div>
        <button onClick={onToggleCollapse} className="text-gray-500 hover:text-white transition-colors">
          <PanelRightClose size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!result && !loading && !error && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <p className="text-gray-500 text-xs">Run Trace to inspect variables</p>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-500 text-xs font-mono">Tracing…</p>
          </div>
        )}

        {error && !hasContent && (
          <div className="px-3 py-3">
            <div className="bg-red-950/60 border border-red-700 rounded-lg p-3 text-red-200 text-xs font-mono break-words">
              {error}
            </div>
          </div>
        )}

        {hasContent && (
          <>
            {error && (
              <div className="mx-3 mt-2 bg-red-950/60 border border-red-700 rounded-lg p-2 text-red-200 text-[11px] font-mono break-words">
                {error}
              </div>
            )}
            {notFound && (
              <div className="mx-3 mt-2 bg-amber-950/50 border border-amber-700/60 rounded-lg p-2 text-amber-200 text-[11px]">
                This didn't run in this trace.
              </div>
            )}

            <Breadcrumb index={index} breadcrumb={breadcrumb} onNavigateToFrame={onNavigateToFrame} />
            <OccurrenceSelector
              occurrences={nav.occurrences}
              occurrenceIndex={nav.occurrenceIndex}
              onSelect={onJumpToOccurrence}
            />

            <FrameSections index={index} frameId={nav.frameId} viewSeq={viewSeq} onJumpToFrame={onNavigateToFrame} />
          </>
        )}
      </div>
    </div>
  )
}

function FrameSections({
  index,
  frameId,
  viewSeq,
  onJumpToFrame,
}: {
  index: TraceIndex
  frameId: number
  viewSeq: number | null
  onJumpToFrame: (frameId: number) => void
}) {
  const atSeq = viewSeq ?? frameViewSeq(index, frameId)
  const state = getFrameState(index, frameId, atSeq)
  // The frame's own return value — a property of the whole call, not of `viewPoint`,
  // so (unlike the sections above) this doesn't depend on atSeq.
  const returnValue = index.frameSpans.get(frameId)?.returnValue ?? null
  return (
    <>
      <VariableSection title="Global" values={state.global} index={index} atSeq={atSeq} currentFrameId={frameId} onJumpToFrame={onJumpToFrame} />
      <VariableSection title="Caller" values={state.param} index={index} atSeq={atSeq} currentFrameId={frameId} onJumpToFrame={onJumpToFrame} />
      <VariableSection title="State" values={state.body} index={index} atSeq={atSeq} currentFrameId={frameId} onJumpToFrame={onJumpToFrame} />
      <OutputSection returnValue={returnValue} />
    </>
  )
}
