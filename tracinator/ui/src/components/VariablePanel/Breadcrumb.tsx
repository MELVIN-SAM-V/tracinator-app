import { ChevronRight } from 'lucide-react'
import React from 'react'
import type { TraceIndex } from '../../lib/traceIndex'

interface Props {
  index: TraceIndex
  breadcrumb: number[]
  onNavigateToFrame: (frameId: number) => void
}

export default function Breadcrumb({ index, breadcrumb, onNavigateToFrame }: Props) {
  return (
    <div className="flex items-center gap-1 px-3 py-2 text-xs font-mono overflow-x-auto border-b border-gray-800">
      {breadcrumb.map((frameId, i) => {
        const span = index.frameSpans.get(frameId)
        const label = span?.func ?? `frame ${frameId}`
        const isLast = i === breadcrumb.length - 1
        return (
          <React.Fragment key={frameId}>
            {i > 0 && <ChevronRight size={11} className="text-gray-600 shrink-0" />}
            {isLast ? (
              <span className="text-indigo-300 font-semibold shrink-0">{label}</span>
            ) : (
              <button
                onClick={() => onNavigateToFrame(frameId)}
                className="text-gray-400 hover:text-indigo-300 transition-colors shrink-0"
              >
                {label}
              </button>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
