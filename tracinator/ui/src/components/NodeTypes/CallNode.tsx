import React from 'react'
import { NodeProps, Handle, Position } from '@xyflow/react'
import { motion } from 'framer-motion'
import { NodeData, basename } from './shared'

export default function CallNode({ data, selected }: NodeProps) {
  const nd = data as unknown as NodeData
  const { pyNode } = nd
  const canNavigate = pyNode.sub_graph != null
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={`
        relative px-3 py-2 rounded-lg border border-indigo-400
        bg-indigo-900/50 min-w-[180px] max-w-[240px]
        transition-all duration-150 select-none
        hover:scale-105 hover:border-indigo-300 node-glow-indigo
        ${canNavigate ? 'cursor-pointer' : 'cursor-default'}
        ${selected ? 'outline outline-[3px] outline-white outline-offset-2' : ''}
      `}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#818cf8', border: '2px solid #0f1117' }} />
      <div className="flex items-start gap-1 pr-5">
        <span className="text-indigo-400 text-xs mt-0.5">→</span>
        <div className="flex-1 min-w-0">
          <div className="text-indigo-100 font-mono text-xs leading-tight truncate">{pyNode.label}</div>
          <div className="text-indigo-400 text-[10px] mt-0.5 truncate">
            {basename(pyNode.source_file)}:{pyNode.start_line}
            {pyNode.end_line !== pyNode.start_line ? `–${pyNode.end_line}` : ''}
          </div>
        </div>
      </div>
      {canNavigate && (
        <div
          className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center rounded text-[10px] bg-indigo-700 text-indigo-200"
          title="Double-click to navigate into"
        >
          ↗
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: '#818cf8', border: '2px solid #0f1117' }} />
    </motion.div>
  )
}
