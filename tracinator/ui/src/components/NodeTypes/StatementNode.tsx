import React from 'react'
import { NodeProps, Handle, Position } from '@xyflow/react'
import { motion } from 'framer-motion'
import { NodeData, basename } from './shared'

export default function StatementNode({ data, selected }: NodeProps) {
  const nd = data as unknown as NodeData
  const { pyNode } = nd
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={`
        relative px-3 py-2 rounded-lg border border-slate-600
        bg-slate-800/80 min-w-[180px] max-w-[240px]
        transition-all duration-150 cursor-pointer select-none
        hover:scale-105 hover:border-slate-400
        ${selected ? 'outline outline-[3px] outline-white outline-offset-2' : ''}
      `}
      title="Show variables at this line"
    >
      <Handle type="target" position={Position.Top} style={{ background: '#6366f1', border: '2px solid #0f1117' }} />
      {/* `pyNode.label` can be several statements joined with "\n" (grouped
          sequential statements) — `whitespace-pre-wrap` renders each on its own
          line instead of `truncate`'s `white-space: nowrap` collapsing them all
          onto one. */}
      <div className="text-white font-mono text-xs leading-tight whitespace-pre-wrap break-words">{pyNode.label}</div>
      <div className="text-gray-500 text-[10px] mt-0.5 truncate">
        {basename(pyNode.source_file)}:{pyNode.start_line}
        {pyNode.end_line !== pyNode.start_line ? `–${pyNode.end_line}` : ''}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#6366f1', border: '2px solid #0f1117' }} />
    </motion.div>
  )
}
