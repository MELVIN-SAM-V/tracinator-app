import React from 'react'
import { NodeProps, Handle, Position } from '@xyflow/react'
import { motion } from 'framer-motion'
import { NodeData, basename } from './shared'

// Fallback for ELSE, WITH, FINALLY, BREAK, CONTINUE
export default function GenericNode({ data, selected }: NodeProps) {
  const nd = data as unknown as NodeData
  const { pyNode } = nd

  const colorMap: Record<string, string> = {
    ELSE: 'border-purple-500/60 bg-purple-900/30 text-purple-100',
    WITH: 'border-teal-500/60 bg-teal-900/30 text-teal-100',
    FINALLY: 'border-yellow-500/60 bg-yellow-900/30 text-yellow-100',
    BREAK: 'border-gray-500 bg-gray-800/60 text-gray-300',
    CONTINUE: 'border-gray-500 bg-gray-800/60 text-gray-300',
  }
  const cls = colorMap[pyNode.node_type] ?? 'border-gray-600 bg-gray-800/60 text-gray-200'

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={`
        relative px-3 py-2 rounded-lg border
        min-w-[140px] max-w-[240px]
        transition-all duration-150 cursor-pointer select-none
        hover:scale-105 ${cls}
        ${selected ? 'outline outline-[3px] outline-white outline-offset-2' : ''}
      `}
      title="Show variables at this line"
    >
      <Handle type="target" position={Position.Top} style={{ background: '#94a3b8', border: '2px solid #0f1117' }} />
      <div className="font-mono text-xs leading-tight truncate">{pyNode.label}</div>
      <div className="text-gray-500 text-[10px] mt-0.5 truncate">
        {basename(pyNode.source_file)}:{pyNode.start_line}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#94a3b8', border: '2px solid #0f1117' }} />
    </motion.div>
  )
}
