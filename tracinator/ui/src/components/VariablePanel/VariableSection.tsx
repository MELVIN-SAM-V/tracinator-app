import React from 'react'
import type { TraceIndex } from '../../lib/traceIndex'
import type { LocalValue } from '../../types/trace'
import SharedBadge from './SharedBadge'
import ValueView from './ValueView'

interface Props {
  title: string
  values: Record<string, LocalValue>
  index: TraceIndex
  atSeq: number
  currentFrameId: number
  onJumpToFrame: (frameId: number) => void
}

export default function VariableSection({ title, values, index, atSeq, currentFrameId, onJumpToFrame }: Props) {
  const entries = Object.entries(values)
  return (
    <div className="border-b border-gray-800">
      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-900/40">
        {title}
      </div>
      {entries.length === 0 ? (
        <div className="px-3 py-2 text-gray-600 text-xs italic">—</div>
      ) : (
        <div className="px-1 py-1">
          {entries.map(([name, value]) => (
            <div key={name} className="flex items-baseline gap-2 px-2 py-1 rounded hover:bg-gray-800/60">
              <span className="text-indigo-300 text-xs font-mono shrink-0">{name}</span>
              <div className="flex-1 min-w-0">
                <ValueView value={value} />
              </div>
              {value.id !== null && (
                <SharedBadge
                  index={index}
                  objectId={value.id}
                  atSeq={atSeq}
                  currentFrameId={currentFrameId}
                  currentName={name}
                  onJumpToFrame={onJumpToFrame}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
