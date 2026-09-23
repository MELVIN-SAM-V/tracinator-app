import React from 'react'

interface Props {
  occurrences: number[]
  occurrenceIndex: number
  onSelect: (index: number) => void
}

export default function OccurrenceSelector({ occurrences, occurrenceIndex, onSelect }: Props) {
  if (occurrences.length <= 1) return null
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-800 flex-wrap">
      <span className="text-gray-500 text-[10px] uppercase tracking-wide mr-1 shrink-0">Call</span>
      {occurrences.map((_, i) => (
        <button
          key={i}
          onClick={() => onSelect(i)}
          title={`Occurrence ${i + 1} of ${occurrences.length}`}
          className={`w-6 h-6 rounded text-[11px] font-mono transition-colors shrink-0 ${
            i === occurrenceIndex
              ? 'bg-indigo-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
          }`}
        >
          {i + 1}
        </button>
      ))}
      <span className="text-gray-600 text-[10px] ml-1 shrink-0">of {occurrences.length}</span>
    </div>
  )
}
