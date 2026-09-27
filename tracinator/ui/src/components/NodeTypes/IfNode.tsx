import React from 'react'
import { NodeProps, Handle, Position } from '@xyflow/react'
import { motion } from 'framer-motion'
import { NodeData, basename, IF_NODE_WIDTH, IF_NODE_HEIGHT } from './shared'

// Inset by half the stroke width so the border isn't clipped at the tips.
const INSET = 2
const DIAMOND_POINTS = [
  `${IF_NODE_WIDTH / 2},${INSET}`,
  `${IF_NODE_WIDTH - INSET},${IF_NODE_HEIGHT / 2}`,
  `${IF_NODE_WIDTH / 2},${IF_NODE_HEIGHT - INSET}`,
  `${INSET},${IF_NODE_HEIGHT / 2}`,
].join(' ')

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
      style={{ width: IF_NODE_WIDTH, height: IF_NODE_HEIGHT }}
      className="relative flex items-center justify-center cursor-pointer"
      title="Show variables at this line"
    >
      <Handle type="target" position={Position.Top} style={{ background: '#a78bfa', border: '2px solid #0f1117', zIndex: 10 }} />
      {/* A real diamond: a polygon filling the node's box, not a rotated
          rectangle (which only forms a diamond when the box is square). */}
      <svg
        className="absolute inset-0"
        width={IF_NODE_WIDTH}
        height={IF_NODE_HEIGHT}
        viewBox={`0 0 ${IF_NODE_WIDTH} ${IF_NODE_HEIGHT}`}
      >
        <polygon
          points={DIAMOND_POINTS}
          strokeLinejoin="round"
          className={`fill-violet-900/60 transition-all duration-150 ${selected ? 'stroke-white' : 'stroke-violet-400'}`}
          strokeWidth={selected ? 3 : 2}
        />
      </svg>
      {/* Text stays within the diamond's middle band, ~180px wide at ±14px
          from centre, so cap it well inside that. */}
      <div className="relative z-10 text-center max-w-[150px]">
        <div className="text-violet-200 font-mono text-[11px] leading-tight truncate">
          {label}
        </div>
        <div className="text-violet-400 text-[10px] mt-0.5 truncate">
          {basename(pyNode.source_file)}:{pyNode.start_line}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#a78bfa', border: '2px solid #0f1117', zIndex: 10 }} />
      <Handle type="source" id="false" position={Position.Right} style={{ background: '#f87171', border: '2px solid #0f1117', zIndex: 10 }} />
    </motion.div>
  )
}
