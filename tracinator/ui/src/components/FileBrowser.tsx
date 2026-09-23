import React, { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Folder, FileCode, ChevronRight, ArrowLeft, Play, FunctionSquare, Zap,
} from 'lucide-react'
import type { FunctionInfo } from '../types/graph'
import ResizeDivider from './ResizeDivider'
import { useResizableWidth } from '../hooks/useResizableWidth'

interface BrowseResult {
  path: string
  parent: string | null
  dirs: string[]
  files: string[]
}

interface Props {
  root: string
  onSelect: (file: string, fn: string) => void
  // Called with the files-panel's own resize delta as it's dragged, so the
  // sidebar that contains this whole file browser can grow/shrink by the
  // same amount — otherwise widening the files list eats directly into the
  // function list's width instead of pushing the sidebar's outer edge.
  onFilesPanelResize?: (delta: number) => void
}

export default function FileBrowser({ root, onSelect, onFilesPanelResize }: Props) {
  const [currentPath, setCurrentPath] = useState<string>(root)
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [functions, setFunctions] = useState<FunctionInfo[] | null>(null)
  const [loadingFns, setLoadingFns] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const filesPanel = useResizableWidth({
    initial: 252,
    min: 160,
    max: 700,
    containerRef: splitContainerRef,
    reserveForOther: 160, // function list needs to stay usable, not squeezed to nothing
    onResize: onFilesPanelResize,
  })

  const fetchDir = useCallback((path: string) => {
    setBrowseError(null)
    fetch(`/api/browse?path=${encodeURIComponent(path)}`)
      .then(r => r.json())
      .then((data: BrowseResult) => {
        setBrowse(data)
        setCurrentPath(data.path)
        setSelectedFile(null)
        setFunctions(null)
      })
      .catch(() => setBrowseError('Failed to load directory'))
  }, [])

  useEffect(() => {
    fetchDir(root)
  }, [root, fetchDir])

  const handleFileClick = (filename: string) => {
    const fullPath = `${currentPath}/${filename}`
    setSelectedFile(fullPath)
    setFunctions(null)
    setLoadingFns(true)
    fetch(`/api/functions?file=${encodeURIComponent(fullPath)}`)
      .then(r => r.json())
      .then((data: { functions: FunctionInfo[] }) => {
        setFunctions(data.functions)
        setLoadingFns(false)
      })
      .catch(() => {
        setFunctions([])
        setLoadingFns(false)
      })
  }

  // Build breadcrumb segments relative to root
  const crumbs = buildCrumbs(currentPath, root)

  return (
    <div className="flex flex-col h-full bg-[#0f1117] text-white">
      <div ref={splitContainerRef} className="flex flex-1 min-h-0">
        {/* Left panel — file browser */}
        <div className="flex flex-col shrink-0 min-h-0" style={{ width: filesPanel.width }}>
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 px-4 py-2.5 border-b border-gray-800/60 bg-gray-900/40 shrink-0 overflow-x-auto">
            {browse?.parent && (
              <button
                onClick={() => fetchDir(browse.parent!)}
                className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors shrink-0"
                title="Go up"
              >
                <ArrowLeft size={13} />
              </button>
            )}
            {crumbs.map((crumb, i) => (
              <React.Fragment key={crumb.path}>
                {i > 0 && <ChevronRight size={11} className="text-gray-600 shrink-0" />}
                <button
                  onClick={() => fetchDir(crumb.path)}
                  className={`text-xs font-mono px-1 rounded hover:text-white transition-colors shrink-0 ${
                    i === crumbs.length - 1 ? 'text-indigo-300 font-semibold' : 'text-gray-400 hover:bg-gray-700/50'
                  }`}
                >
                  {crumb.label}
                </button>
              </React.Fragment>
            ))}
          </div>

          {/* Directory listing */}
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {browseError && (
              <div className="text-red-400 text-xs px-3 py-2">{browseError}</div>
            )}
            {browse && (
              <motion.div
                key={currentPath}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.15 }}
              >
                {/* Dirs */}
                {browse.dirs.map((dir, i) => (
                  <motion.button
                    key={dir}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.02 }}
                    onClick={() => fetchDir(`${currentPath}/${dir}`)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-gray-800/70 text-left group transition-colors"
                  >
                    <Folder size={15} className="text-indigo-400 shrink-0" />
                    <span className="text-gray-300 text-sm font-mono group-hover:text-white transition-colors truncate min-w-0 flex-1">
                      {dir}
                    </span>
                    <ChevronRight size={12} className="shrink-0 text-gray-600 group-hover:text-gray-400 transition-colors" />
                  </motion.button>
                ))}

                {/* .py files */}
                {browse.files.map((file, i) => {
                  const fullPath = `${currentPath}/${file}`
                  const isSelected = selectedFile === fullPath
                  return (
                    <motion.button
                      key={file}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: (browse.dirs.length + i) * 0.02 }}
                      onClick={() => handleFileClick(file)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                        isSelected
                          ? 'bg-indigo-900/50 border border-indigo-700/60'
                          : 'hover:bg-gray-800/70'
                      }`}
                    >
                      <FileCode size={15} className={isSelected ? 'text-indigo-300 shrink-0' : 'text-emerald-400 shrink-0'} />
                      <span className={`text-sm font-mono transition-colors truncate min-w-0 ${isSelected ? 'text-indigo-200 font-semibold' : 'text-gray-300'}`}>
                        {file}
                      </span>
                    </motion.button>
                  )
                })}

                {browse.dirs.length === 0 && browse.files.length === 0 && (
                  <div className="text-gray-600 text-xs px-3 py-4 text-center">
                    No Python files here
                  </div>
                )}

                {browse.dirs.length > 0 && browse.files.length === 0 && (
                  <div className="text-gray-600 text-xs px-3 py-2 text-center">
                    No Python files in this folder
                  </div>
                )}
              </motion.div>
            )}
          </div>
        </div>

        <ResizeDivider onMouseDown={filesPanel.onMouseDown} />

        {/* Right panel — function list */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <AnimatePresence mode="wait">
            {!selectedFile && (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center justify-center h-full gap-3 text-center px-6"
              >
                <FileCode size={36} className="text-gray-700" />
                <p className="text-gray-600 text-sm">Select a Python file to see its functions</p>
              </motion.div>
            )}

            {selectedFile && loadingFns && (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center justify-center h-full"
              >
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                >
                  <Zap size={24} className="text-indigo-400" />
                </motion.div>
              </motion.div>
            )}

            {selectedFile && !loadingFns && functions !== null && (
              <motion.div
                key="functions"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="flex flex-col h-full min-h-0"
              >
                {/* File header */}
                <div className="px-4 py-3 border-b border-gray-800/60 bg-gray-900/40 shrink-0">
                  <div className="flex items-center gap-2">
                    <FileCode size={14} className="text-emerald-400" />
                    <span className="text-sm font-mono text-gray-300 truncate">
                      {selectedFile.split('/').pop()}
                    </span>
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">
                    {functions.length} function{functions.length !== 1 ? 's' : ''}
                  </div>
                </div>

                {/* Function list */}
                <div className="flex-1 overflow-y-auto px-2 py-2">
                  {functions.length === 0 && (
                    <div className="text-gray-600 text-xs px-3 py-4 text-center">
                      No functions found
                    </div>
                  )}
                  {functions.map((fn, i) => (
                    <motion.button
                      key={fn.qualified_name}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.03 }}
                      onClick={() => onSelect(selectedFile, fn.qualified_name)}
                      className="w-full text-left px-3 py-3 rounded-lg hover:bg-indigo-900/30 border border-transparent hover:border-indigo-700/40 transition-all group mb-1"
                    >
                      <div className="flex items-center gap-2">
                        <FunctionSquare size={13} className="text-indigo-400 shrink-0" />
                        <span className="text-sm font-mono font-semibold text-white group-hover:text-indigo-200 transition-colors">
                          {fn.class_name ? `${fn.class_name}.${fn.name}` : fn.name}
                        </span>
                        <Play
                          size={11}
                          className="ml-auto text-gray-700 group-hover:text-indigo-400 transition-colors shrink-0"
                        />
                      </div>
                      {fn.args.length > 0 && (
                        <div className="text-xs text-gray-500 font-mono mt-0.5 ml-5">
                          ({fn.args.join(', ')})
                        </div>
                      )}
                      <div className="text-[10px] text-gray-700 font-mono mt-0.5 ml-5">
                        line {fn.line}
                      </div>
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function buildCrumbs(currentPath: string, root: string): { label: string; path: string }[] {
  const rootParts = root.split('/')
  const currentParts = currentPath.split('/')
  const crumbs: { label: string; path: string }[] = []

  for (let i = rootParts.length - 1; i < currentParts.length; i++) {
    crumbs.push({
      label: currentParts[i] || '/',
      path: currentParts.slice(0, i + 1).join('/') || '/',
    })
  }
  return crumbs
}
