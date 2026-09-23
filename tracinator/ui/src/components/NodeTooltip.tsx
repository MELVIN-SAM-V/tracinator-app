import React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import SyntaxHighlighter from 'react-syntax-highlighter'
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs'
import { PyGraphNode } from '../types/graph'

interface Props {
  node: PyGraphNode | null
  x: number
  y: number
}

export default function NodeTooltip({ node, x, y }: Props) {
  return (
    <AnimatePresence>
      {node && (
        <motion.div
          key={node.id}
          initial={{ opacity: 0, scale: 0.92, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 6 }}
          transition={{ duration: 0.15 }}
          style={{ left: x + 16, top: y + 8, maxWidth: 380 }}
          className="fixed z-50 pointer-events-none"
        >
          <div className="bg-gray-900/95 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800">
              <div className="text-white font-mono text-xs font-semibold truncate">{node.label}</div>
              <div className="text-gray-400 text-[10px] mt-0.5 truncate">
                {node.source_file}:{node.start_line}–{node.end_line}
              </div>
            </div>
            {node.raw_code && (
              <div className="max-h-48 overflow-auto text-[10px]">
                <SyntaxHighlighter
                  language="python"
                  style={atomOneDark}
                  customStyle={{ margin: 0, background: 'transparent', fontSize: 10, padding: '8px 12px' }}
                  wrapLongLines
                >
                  {node.raw_code.trim()}
                </SyntaxHighlighter>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
