import React, { useState, useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import { ChevronDown, Zap } from 'lucide-react'
import { motion } from 'framer-motion'
import type { FunctionInfo } from '../types/graph'

interface Props {
  onRun: (source: string, fn: string) => void
  loading: boolean
}

const DEFAULT_CODE = `def greet(name: str) -> str:
    if not name:
        return "Hello, stranger!"
    return f"Hello, {name}!"


def absolute_value(n: float) -> float:
    if n >= 0:
        return n
    else:
        return -n
`

export default function EditorPane({ onRun, loading }: Props) {
  const [source, setSource] = useState(DEFAULT_CODE)
  const [functions, setFunctions] = useState<FunctionInfo[]>([])
  const [selectedFn, setSelectedFn] = useState<string>('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedFnRef = useRef<string>('')

  // Keep ref in sync so fetchFunctions closure can read latest value
  useEffect(() => { selectedFnRef.current = selectedFn }, [selectedFn])

  const fetchAndRun = (code: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetch('/api/functions-from-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: code }),
      })
        .then(r => r.json())
        .then((data: { functions: FunctionInfo[] }) => {
          setFunctions(data.functions)
          // Keep current selection if still valid, else pick first
          const fn = data.functions.find(f => f.qualified_name === selectedFnRef.current)
            ? selectedFnRef.current
            : (data.functions[0]?.qualified_name ?? '')
          setSelectedFn(fn)
          if (fn && code.trim()) onRun(code, fn)
        })
        .catch(() => {})
    }, 700)
  }

  useEffect(() => { fetchAndRun(DEFAULT_CODE) }, [])

  const handleChange = (val: string | undefined) => {
    const code = val ?? ''
    setSource(code)
    fetchAndRun(code)
  }

  const handleFnChange = (fn: string) => {
    setSelectedFn(fn)
    if (fn && source.trim()) onRun(source, fn)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0" data-tour="tour-editor">
        <Editor
          height="100%"
          defaultLanguage="python"
          value={source}
          onChange={handleChange}
          theme="vs-dark"
          options={{
            fontSize: 13,
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            minimap: { enabled: false },
            // Minimap being off doesn't touch this — Monaco's overview ruler
            // (scroll-position marker strip) is a separate feature that's on
            // by default and draws its own static border, which just reads
            // as a second, inert vertical line sitting right next to the
            // actual (draggable) panel divider.
            overviewRulerBorder: false,
            overviewRulerLanes: 0,
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
            lineNumbers: 'on',
            renderLineHighlight: 'line',
            tabSize: 4,
            wordWrap: 'on',
            acceptSuggestionOnCommitCharacter: false,
          }}
        />
      </div>

      {/* Bottom bar — function picker + loading indicator */}
      <div className="shrink-0 border-t border-gray-800 px-3 py-2.5 flex items-center gap-2 bg-gray-900/70" data-tour="tour-fn-picker">
        {functions.length === 0 ? (
          <span className="text-gray-600 text-xs font-mono flex-1 italic">No functions detected</span>
        ) : (
          <div className="relative flex-1">
            <select
              value={selectedFn}
              onChange={e => handleFnChange(e.target.value)}
              className="w-full appearance-none bg-gray-800 border border-gray-700 text-gray-200 text-xs font-mono rounded px-3 py-1.5 pr-7 focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              {functions.map(fn => (
                <option key={fn.qualified_name} value={fn.qualified_name}>
                  {fn.class_name ? `${fn.class_name}.${fn.name}` : fn.name}({fn.args.join(', ')})
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          </div>
        )}

        {loading && (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            className="shrink-0"
          >
            <Zap size={14} className="text-indigo-400" />
          </motion.div>
        )}
      </div>
    </div>
  )
}
