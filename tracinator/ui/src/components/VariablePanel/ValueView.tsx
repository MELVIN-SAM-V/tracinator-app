import { ChevronRight } from 'lucide-react'
import React, { useState } from 'react'
import type { CapturedValue } from '../../types/trace'

interface Props {
  value: CapturedValue
  depth?: number
}

// Recursively renders a captured value — a flat repr for primitives, or an
// expandable tree for objects/containers so the user can see what's inside
// instead of Python's `<Module.Class object at 0x...>` default repr.
export default function ValueView({ value, depth = 0 }: Props) {
  const hasChildren = !!(value.fields || value.items || value.entries)
  // Auto-expand only the first level: a variable's own fields/items are visible
  // immediately, but anything nested inside those starts collapsed.
  const [expanded, setExpanded] = useState(depth < 1)

  if (value.circular) {
    return <span className="italic text-gray-500 break-all">↩ {value.repr}</span>
  }

  if (!hasChildren) {
    return <span className="text-gray-300 text-xs font-mono break-all">{value.repr}</span>
  }

  return (
    <div className="min-w-0">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1 text-indigo-300 hover:text-indigo-200 text-xs font-mono break-all text-left"
      >
        <ChevronRight size={10} className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        {value.repr}
      </button>
      {expanded && (
        <div className="ml-3 pl-2 border-l border-gray-800 mt-0.5 space-y-0.5">
          {value.fields &&
            Object.entries(value.fields).map(([name, child]) => (
              <div key={name} className="flex items-baseline gap-1.5">
                <span className="text-gray-500 text-xs font-mono shrink-0">{name}:</span>
                <ValueView value={child} depth={depth + 1} />
              </div>
            ))}
          {value.items &&
            value.items.map((child, i) => (
              <div key={i} className="flex items-baseline gap-1.5">
                <span className="text-gray-600 text-xs font-mono shrink-0">[{i}]</span>
                <ValueView value={child} depth={depth + 1} />
              </div>
            ))}
          {value.entries &&
            value.entries.map((entry, i) => (
              <div key={i} className="flex items-baseline gap-1.5">
                <ValueView value={entry.key} depth={depth + 1} />
                <span className="text-gray-500 text-xs shrink-0">:</span>
                <ValueView value={entry.value} depth={depth + 1} />
              </div>
            ))}
          {value.truncated && <div className="text-gray-600 italic text-[10px]">… truncated</div>}
        </div>
      )}
    </div>
  )
}
