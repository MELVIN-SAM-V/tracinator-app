import React from 'react'
import { NodeProps, Handle, Position } from '@xyflow/react'
import { motion } from 'framer-motion'
import { NodeData, basename } from './shared'

export default function LoopNode({ data, selected }: NodeProps) {
  const nd = data as unknown as NodeData
  const { pyNode } = nd
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={`
        relative px-3 py-2 rounded-lg border border-cyan-400
        bg-cyan-900/40 min-w-[180px] max-w-[240px]
        transition-all duration-150 cursor-pointer select-none
        hover:scale-105 hover:border-cyan-300
        ${selected ? 'outline outline-[3px] outline-white outline-offset-2' : ''}
      `}
      title="Show variables at this line"
    >
      <Handle type="target" position={Position.Top} style={{ background: '#22d3ee', border: '2px solid #0f1117' }} />
      <div className="flex items-start gap-1">
        <span className="text-cyan-400 text-sm mt-0.5">⟳</span>
        <div className="flex-1 min-w-0">
          <div className="text-cyan-100 font-mono text-xs leading-tight truncate">{pyNode.label}</div>
          <div className="text-cyan-600 text-[10px] mt-0.5 truncate">
            {basename(pyNode.source_file)}:{pyNode.start_line}
            {pyNode.end_line !== pyNode.start_line ? `–${pyNode.end_line}` : ''}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#22d3ee', border: '2px solid #0f1117' }} />
    </motion.div>
  )
}
