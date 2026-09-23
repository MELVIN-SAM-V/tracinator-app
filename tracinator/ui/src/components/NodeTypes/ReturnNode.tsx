import React from 'react'
import { NodeProps, Handle, Position } from '@xyflow/react'
import { motion } from 'framer-motion'
import { NodeData, basename } from './shared'

export default function ReturnNode({ data, selected }: NodeProps) {
  const nd = data as unknown as NodeData
  const { pyNode } = nd
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={`
        relative px-4 py-2 rounded-full border-2 border-emerald-500
        bg-emerald-900/40 min-w-[140px] text-center
        transition-all duration-150 cursor-pointer select-none
        hover:scale-105 node-glow-green
        ${selected ? 'outline outline-[3px] outline-white outline-offset-2' : ''}
      `}
      title="Show variables at this line"
    >
      <Handle type="target" position={Position.Top} style={{ background: '#34d399', border: '2px solid #0f1117' }} />
      <div className="text-emerald-200 font-mono text-xs leading-tight truncate">{pyNode.label}</div>
      <div className="text-emerald-600 text-[10px] mt-0.5">
        {basename(pyNode.source_file)}:{pyNode.start_line}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#34d399', border: '2px solid #0f1117' }} />
    </motion.div>
  )
}
