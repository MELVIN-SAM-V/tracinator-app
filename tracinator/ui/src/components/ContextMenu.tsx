import React, { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { PyGraphNode } from '../types/graph'

interface Props {
  node: PyGraphNode | null
  x: number
  y: number
  onClose: () => void
  onNavigate: (file: string, fn: string, callLine: number) => void
  onFitNode: (id: string) => void
}

export default function ContextMenu({ node, x, y, onClose, onNavigate, onFitNode }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  if (!node) return null

  const items = [
    node.node_type === 'CALL' && node.sub_graph && {
      label: 'Navigate into',
      icon: '↗',
      action: () => { onNavigate(node.sub_graph!.source_file, node.sub_graph!.function_name, node.start_line); onClose() },
    },
    {
      label: 'Fit to node',
      icon: '⊡',
      action: () => { onFitNode(node.id); onClose() },
    },
    {
      label: 'Copy node ID',
      icon: '⎘',
      action: () => { navigator.clipboard.writeText(node.id); onClose() },
    },
  ].filter(Boolean) as { label: string; icon: string; action: () => void }[]

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={{ duration: 0.1 }}
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-[180px] bg-gray-900/95 border border-gray-700 rounded-xl shadow-2xl overflow-hidden backdrop-blur"
    >
      <div className="px-3 py-1.5 border-b border-gray-800">
        <div className="text-gray-400 text-[10px] font-mono truncate">{node.label}</div>
      </div>
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.action}
          className="
            w-full flex items-center gap-2 px-3 py-2
            text-gray-300 text-xs hover:bg-indigo-600/30 hover:text-white
            transition-colors duration-100 text-left
          "
        >
          <span className="text-gray-500 text-[10px] w-4">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </motion.div>
  )
}
