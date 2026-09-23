import React from 'react'
import { NodeProps, Handle, Position } from '@xyflow/react'
import { motion } from 'framer-motion'
import { NodeData, basename } from './shared'

export default function TryNode({ data, selected }: NodeProps) {
  const nd = data as unknown as NodeData
  const { pyNode } = nd
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={`
        relative px-3 py-2 rounded-lg border-2 border-dashed border-amber-500/60
        bg-amber-950/30 min-w-[180px] max-w-[240px]
        transition-all duration-150 cursor-pointer select-none
        hover:scale-105
        ${selected ? 'outline outline-[3px] outline-white outline-offset-2' : ''}
      `}
      title="Show variables at this line"
    >
      <Handle type="target" position={Position.Top} style={{ background: '#fbbf24', border: '2px solid #0f1117' }} />
      <div className="text-amber-100 font-mono text-xs leading-tight truncate">{pyNode.label}</div>
      <div className="text-amber-600 text-[10px] mt-0.5 truncate">
        {basename(pyNode.source_file)}:{pyNode.start_line}
        {pyNode.end_line !== pyNode.start_line ? `–${pyNode.end_line}` : ''}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#fbbf24', border: '2px solid #0f1117' }} />
    </motion.div>
  )
}
