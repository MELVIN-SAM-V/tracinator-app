import React from 'react'
import { NodeProps, Handle, Position } from '@xyflow/react'
import { motion } from 'framer-motion'
import { NodeData, basename } from './shared'

export default function IfNode({ data, selected }: NodeProps) {
  const nd = data as unknown as NodeData
  const { pyNode } = nd
  const keyword = pyNode.node_type === 'ELIF' ? 'elif' : 'if'
  const label = pyNode.condition ? `${keyword} ${pyNode.condition}` : pyNode.label
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      style={{ width: 160, height: 80 }}
      className="relative flex items-center justify-center cursor-pointer"
      title="Show variables at this line"
    >
      <Handle type="target" position={Position.Top} style={{ background: '#a78bfa', border: '2px solid #0f1117', zIndex: 10 }} />
      {/* Diamond shape via rotated square */}
      <div
        className={`
          absolute inset-0 border-2 border-violet-400 bg-violet-900/60
          transition-all duration-150
          ${selected ? 'outline outline-[3px] outline-white outline-offset-2' : ''}
        `}
        style={{ transform: 'rotate(45deg)', borderRadius: 6 }}
      />
      <div className="relative z-10 text-center px-2" style={{ transform: 'none' }}>
        <div className="text-violet-200 font-mono text-[10px] leading-tight truncate max-w-[120px]">
          {label}
        </div>
        <div className="text-violet-500 text-[9px] mt-0.5">
          {basename(pyNode.source_file)}:{pyNode.start_line}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#a78bfa', border: '2px solid #0f1117', zIndex: 10 }} />
      <Handle type="source" id="false" position={Position.Right} style={{ background: '#f87171', border: '2px solid #0f1117', zIndex: 10 }} />
    </motion.div>
  )
}
