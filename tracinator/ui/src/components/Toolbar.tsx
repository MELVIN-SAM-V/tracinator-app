import React, { useState, useRef, useCallback, useLayoutEffect, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Image, ChevronRight, LayoutGrid, ArrowLeft, Bug, RefreshCw, MoreHorizontal } from 'lucide-react'
import { toPng } from 'html-to-image'
import { PyProjectContext } from '../types/graph'
import TraceArgsForm from './TraceArgsForm'
import Logo from './Logo'

interface NavFrame {
  file: string
  fn: string
}

interface Props {
  context: PyProjectContext
  nodeCount: number
  navStack: NavFrame[]
  onNavigateTo: (index: number) => void
  onBack: () => void
  onRefresh: () => void
  onRunTrace: (file: string, fn: string, args: string[], constructorArgs: string[]) => void
  lastTrace: { fn: string; args: string[]; constructorArgs: string[] } | null
  // Demo build only: passed straight through to TraceArgsForm.
  source?: string
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

export default function Toolbar({ context, nodeCount, navStack, onNavigateTo, onBack, onRefresh, onRunTrace, lastTrace, source }: Props) {
  const [showTraceForm, setShowTraceForm] = useState(false)
  const [visibleCount, setVisibleCount] = useState(Infinity)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const toolbarRef = useRef<HTMLDivElement>(null)
  const breadcrumbRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const collapseBtnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleExport = () => {
    const el = document.querySelector<HTMLElement>('.react-flow__renderer')
    if (!el) return
    toPng(el, { backgroundColor: '#0f1117', pixelRatio: 2 })
      .then((url) => {
        const a = document.createElement('a')
        a.href = url
        a.download = `tracinator-${context.entry_function}.png`
        a.click()
      })
      .catch(console.error)
  }

  const displayStack = navStack.length > 0 ? navStack : [{ file: context.entry_file, fn: context.entry_function }]
  const fileLabel = basename(displayStack[0].file)
  const current = displayStack[displayStack.length - 1]
  const stackKey = displayStack.map((f) => f.fn).join('>')

  const recomputeVisible = useCallback(() => {
    const container = breadcrumbRef.current
    const measurer = measureRef.current
    if (!container || !measurer) return
    const available = container.clientWidth
    const fileLabelWidth = measurer.querySelector<HTMLElement>('[data-measure-file]')?.offsetWidth ?? 0
    const itemWidths = Array.from(measurer.querySelectorAll<HTMLElement>('[data-measure-item]')).map((el) => el.offsetWidth)
    const collapseReserve = 24

    const totalWidth = fileLabelWidth + itemWidths.reduce((a, b) => a + b, 0)
    if (totalWidth <= available) {
      setVisibleCount(Infinity)
      return
    }

    let used = fileLabelWidth
    let count = 0
    for (let i = 0; i < itemWidths.length; i++) {
      const projected = used + itemWidths[i]
      if (projected + collapseReserve <= available) {
        used = projected
        count++
      } else {
        break
      }
    }
    setVisibleCount(count)
  }, [])

  useLayoutEffect(() => {
    recomputeVisible()
  }, [stackKey, recomputeVisible])

  useEffect(() => {
    const container = breadcrumbRef.current
    if (!container) return
    const ro = new ResizeObserver(() => recomputeVisible())
    ro.observe(container)
    return () => ro.disconnect()
  }, [recomputeVisible])

  useEffect(() => {
    if (!menuPos) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || collapseBtnRef.current?.contains(target)) return
      setMenuPos(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuPos])

  const visibleStack = visibleCount === Infinity ? displayStack : displayStack.slice(0, visibleCount)
  const hiddenFrames = visibleCount === Infinity ? [] : displayStack.slice(visibleCount)

  const toggleMenu = () => {
    if (menuPos) {
      setMenuPos(null)
      return
    }
    const barRect = toolbarRef.current?.getBoundingClientRect()
    const crumbRect = breadcrumbRef.current?.getBoundingClientRect()
    if (!barRect || !crumbRect) return
    setMenuPos({ top: barRect.bottom, left: crumbRect.left, width: crumbRect.width })
  }

  // No backdrop-blur here: this bar sits directly over the React Flow
  // canvas (which starts right below it, padded by pt-12 — see
  // GraphCanvas), and panning/zooming constantly moves graph content
  // underneath it. backdrop-filter forces a fresh blur sample of whatever's
  // beneath it on every frame that content changes, which competes with the
  // canvas's own zoom transform for main-thread time — a solid-ish
  // background gets the same "toolbar" look for free.
  return (
    <div ref={toolbarRef} className="absolute top-0 left-0 right-0 z-40 h-12 flex items-center px-4 gap-3 bg-gray-900/95 border-b border-gray-800">
      {/* Back button */}
      <button
        onClick={onBack}
        title="Back"
        className="flex items-center gap-1 px-2 py-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors text-xs shrink-0"
      >
        <ArrowLeft size={13} />
      </button>

      <Logo />

      <div className="h-4 w-px bg-gray-700" />

      {/* Breadcrumb */}
      <div ref={breadcrumbRef} className="flex items-center gap-1 text-xs font-mono min-w-0 flex-1 overflow-hidden">
        <span className="text-gray-500 shrink-0 max-w-[120px] truncate">{fileLabel}</span>

        {visibleStack.map((frame, actualIndex) => (
          <React.Fragment key={actualIndex}>
            <ChevronRight size={12} className="text-gray-600 shrink-0" />
            {actualIndex < displayStack.length - 1 ? (
              <button
                onClick={() => onNavigateTo(actualIndex)}
                className="text-indigo-400 hover:text-indigo-300 transition-colors shrink-0 truncate max-w-[100px]"
                title={`Go to ${frame.fn}`}
              >
                {frame.fn}
              </button>
            ) : (
              <span className="text-indigo-300 font-semibold truncate">{frame.fn}</span>
            )}
          </React.Fragment>
        ))}

        {hiddenFrames.length > 0 && (
          <>
            <ChevronRight size={12} className="text-gray-600 shrink-0" />
            <button
              ref={collapseBtnRef}
              onClick={toggleMenu}
              className="flex items-center shrink-0 text-gray-400 hover:text-white hover:bg-gray-700 rounded px-1 transition-colors"
              title={`Show ${hiddenFrames.length} more`}
            >
              <MoreHorizontal size={14} />
            </button>
          </>
        )}
      </div>

      {/* Hidden measurer used to compute how many breadcrumb segments fit */}
      <div
        ref={measureRef}
        aria-hidden
        className="absolute invisible flex items-center gap-1 text-xs font-mono pointer-events-none"
        style={{ top: -9999, left: -9999, whiteSpace: 'nowrap' }}
      >
        <span data-measure-file className="shrink-0 max-w-[120px] truncate">{fileLabel}</span>
        {displayStack.map((frame, i) => (
          <span key={i} data-measure-item className="inline-flex items-center gap-1 shrink-0">
            <ChevronRight size={12} />
            <span className={i < displayStack.length - 1 ? 'truncate max-w-[100px]' : 'font-semibold truncate'}>{frame.fn}</span>
          </span>
        ))}
      </div>

      {createPortal(
        <AnimatePresence>
          {menuPos && hiddenFrames.length > 0 && (
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, scaleY: 0.85 }}
              animate={{ opacity: 1, scaleY: 1 }}
              exit={{ opacity: 0, scaleY: 0.85 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="fixed z-50 bg-gray-900/95 backdrop-blur border border-t-0 border-gray-800 rounded-b shadow-lg p-2 flex flex-wrap items-center gap-1 text-xs font-mono"
              style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width, transformOrigin: 'top' }}
            >
              <span className="text-gray-500">{fileLabel}</span>
              {displayStack.map((frame, actualIndex) => {
                const isCurrent = actualIndex === displayStack.length - 1
                return (
                  <React.Fragment key={actualIndex}>
                    <ChevronRight size={12} className="text-gray-600 shrink-0" />
                    {isCurrent ? (
                      <span className="text-indigo-300 font-semibold">{frame.fn}</span>
                    ) : (
                      <button
                        onClick={() => {
                          onNavigateTo(actualIndex)
                          setMenuPos(null)
                        }}
                        className="text-indigo-400 hover:text-indigo-300 transition-colors"
                        title={`Go to ${frame.fn}`}
                      >
                        {frame.fn}
                      </button>
                    )}
                  </React.Fragment>
                )
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* Node count badge */}
      <div className="flex items-center gap-1 shrink-0">
        <LayoutGrid size={11} className="text-gray-500" />
        <span className="text-gray-500 text-[10px] font-mono">{nodeCount} nodes</span>
      </div>

      <div className="h-4 w-px bg-gray-700" />

      {/* Controls */}
      <div className="flex items-center gap-1 shrink-0">
        <ToolBtn onClick={handleExport} title="Export PNG" data-tour="tour-export">
          <Image size={13} />
        </ToolBtn>
        <ToolBtn onClick={onRefresh} title="Refresh" data-tour="tour-refresh">
          <RefreshCw size={13} />
        </ToolBtn>
        <ToolBtn onClick={() => setShowTraceForm(true)} title="Trace" data-tour="tour-trace">
          <Bug size={13} /> Trace
        </ToolBtn>
      </div>

      {showTraceForm && (
        <TraceArgsForm
          file={current.file}
          fn={current.fn}
          source={source}
          initialArgs={lastTrace && lastTrace.fn === current.fn ? lastTrace.args : undefined}
          initialConstructorArgs={lastTrace && lastTrace.fn === current.fn ? lastTrace.constructorArgs : undefined}
          onClose={() => setShowTraceForm(false)}
          onSubmit={(args, constructorArgs) => {
            onRunTrace(current.file, current.fn, args, constructorArgs)
            setShowTraceForm(false)
          }}
        />
      )}
    </div>
  )
}

function ToolBtn({
  onClick,
  title,
  children,
  ...rest
}: { onClick: () => void; title?: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      onClick={onClick}
      title={title}
      {...rest}
      className="
        flex items-center gap-1 px-2 py-1 rounded
        text-gray-400 hover:text-white hover:bg-gray-700
        transition-colors duration-100 text-xs
      "
    >
      {children}
    </button>
  )
}
