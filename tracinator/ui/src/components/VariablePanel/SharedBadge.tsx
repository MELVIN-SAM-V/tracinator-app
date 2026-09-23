import { Link2 } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { getOtherLiveAliases } from '../../lib/frameQueries'
import type { TraceIndex } from '../../lib/traceIndex'

interface Props {
  index: TraceIndex
  objectId: number
  atSeq: number
  currentFrameId: number
  currentName: string
  onJumpToFrame: (frameId: number) => void
}

export default function SharedBadge({ index, objectId, atSeq, currentFrameId, currentName, onJumpToFrame }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // This row's own binding always counts as "self" — see getOtherLiveAliases' doc
  // comment for why a raw getLiveAliases at this frame's own view-seq can't be trusted
  // to include self.
  const others = getOtherLiveAliases(index, objectId, atSeq, currentFrameId, currentName)
  if (others.length === 0) return null

  return (
    <div className="relative inline-block shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Shared with other frames"
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-violet-900/40 border border-violet-700/50 text-violet-300 text-[10px] hover:bg-violet-800/50 transition-colors"
      >
        <Link2 size={9} /> ×{others.length + 1}
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 right-0 min-w-[170px] bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden">
          <div className="px-2.5 py-1.5 border-b border-gray-800 text-gray-500 text-[10px] uppercase tracking-wide">
            Shared by
          </div>
          {others.map(({ frameId, name }) => {
            const span = index.frameSpans.get(frameId)
            return (
              <button
                key={`${frameId}:${name}`}
                onClick={() => {
                  onJumpToFrame(frameId)
                  setOpen(false)
                }}
                className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-gray-300 hover:bg-indigo-600/30 hover:text-white transition-colors text-left"
              >
                <span className="font-mono">{span?.func ?? `frame ${frameId}`}</span>
                <span className="text-gray-500 font-mono">.{name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
