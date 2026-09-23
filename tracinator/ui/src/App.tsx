import React, { useState, useEffect, useCallback, useRef } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { motion } from 'framer-motion'
import { Zap, Code2, FolderOpen, HelpCircle } from 'lucide-react'
import Logo from './components/Logo'
import { useGraph } from './hooks/useGraph'
import { useTrace } from './hooks/useTrace'
import { useTraceView } from './hooks/useTraceView'
import type { ViewPoint } from './lib/frameQueries'
import GraphCanvas from './components/GraphCanvas'
import FileBrowser from './components/FileBrowser'
import EditorPane from './components/EditorPane'
import VariablePanel from './components/VariablePanel/VariablePanel'
import Onboarding, { type TourStep } from './components/Onboarding'
import DemoGuideModal from './components/DemoGuideModal'
import UpdateBanner from './components/UpdateBanner'
import { check, type Update } from '@tauri-apps/plugin-updater'
import WindowControls from './components/WindowControls'
import ResizeHandles from './components/ResizeHandles'
import ResizeDivider from './components/ResizeDivider'
import { useResizableWidth } from './hooks/useResizableWidth'

type SourceTab = 'editor' | 'file'

// Public demo build (VITE_DEMO_MODE=true): no real filesystem to browse, no
// /api/config to report a project root — the app is always "ready" and the
// Local File tab has nothing to talk to.
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true'

// First-time-only walkthrough of the whole layout — shown once per browser
// (see MAIN_TOUR_SEEN_KEY below), left off the desktop build since it has its
// own Local File tab and different chrome this tour doesn't know about.
const MAIN_TOUR_SEEN_KEY = 'tracinator_main_tour_seen'
const MAIN_TOUR_STEPS: TourStep[] = [
  {
    selector: '[data-tour="tour-editor"]',
    message: 'Write or paste Python code here — the graph on the right updates as you type.',
    kind: 'area',
  },
  {
    selector: '[data-tour="tour-fn-picker"]',
    message: "Pick which function in your code to explore — everything found in this file shows up here.",
    kind: 'point',
    placement: 'right',
  },
  {
    selector: '[data-tour="tour-graph"]',
    message: 'See the function as a flowchart — click a node to open it, drag to rearrange, scroll to zoom.',
    kind: 'area',
  },
  {
    selector: '[data-tour="tour-trace"]',
    message: 'Run the function for real — type in argument values and watch execution flow through the graph.',
    kind: 'point',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="tour-export"]',
    message: 'Save the current graph as a PNG image.',
    kind: 'point',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="tour-refresh"]',
    message: 'Reset back to a clean, untraced graph.',
    kind: 'point',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="tour-variable-panel"]',
    message: 'Once you trace, real argument, return, and variable values show up here as the code runs.',
    kind: 'area',
  },
]

interface NavFrame {
  file: string
  fn: string
}

export default function App() {
  const [sourceTab, setSourceTab] = useState<SourceTab>('editor')
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const leftPanel = useResizableWidth({
    initial: 420,
    min: 280,
    max: 900,
    containerRef: splitContainerRef,
    reserveForOther: 320, // graph panel needs to stay usable, not squeezed to nothing
  })
  const [projectRoot, setProjectRoot] = useState<string>(DEMO_MODE ? 'demo' : '')
  const [navStack, setNavStack] = useState<NavFrame[]>([])
  const { context, loading, error, loadGraph, loadGraphFromSource, clearGraph } = useGraph()
  const trace = useTrace()
  // Demo-mode only: the pasted source itself, so a trace can be re-run
  // against the exact text that produced the current graph (the sandboxed
  // backend has no shared file to re-read by path — see useTrace.runTraceFromSource).
  const lastSourceRef = useRef<string>('')
  const traceView = useTraceView(trace.index, navStack.length, trace.result?.entry_frame_id ?? 1)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [showTour, setShowTour] = useState(() => DEMO_MODE && !localStorage.getItem(MAIN_TOUR_SEEN_KEY))
  const dismissTour = useCallback(() => {
    setShowTour(false)
    localStorage.setItem(MAIN_TOUR_SEEN_KEY, '1')
  }, [])
  const [showGuide, setShowGuide] = useState(false)
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null)
  // Remembers the last args a trace was run with, so editing code (which reloads the
  // graph under a new temp file each time) can re-run the trace automatically instead
  // of losing it and making the user re-type the same values.
  const [lastTrace, setLastTrace] = useState<{ fn: string; args: string[]; constructorArgs: string[] } | null>(null)
  // Set right before a load that starts an unrelated function from scratch (editor
  // run, file-browser pick) — as opposed to graph-internal navigation (drilling into
  // a call, back, breadcrumb), which also changes context.entry_function but should
  // keep the existing trace. Read-and-reset by the effect below.
  const freshLoadRef = useRef(false)

  const handleCallNodeClick = useCallback((callLine: number, atSeq?: number) => {
    traceView.peekCall(callLine, atSeq)
  }, [traceView.peekCall])

  const handleLineNodeClick = useCallback((point: ViewPoint, atSeq?: number) => {
    traceView.viewBaseFrame(point, atSeq)
  }, [traceView.viewBaseFrame])

  const handleRunTrace = useCallback((file: string, fn: string, args: string[], constructorArgs: string[]) => {
    setLastTrace({ fn, args, constructorArgs })
    if (DEMO_MODE) {
      trace.runTraceFromSource(lastSourceRef.current, fn, args, constructorArgs)
    } else {
      trace.runTrace(file, fn, args, constructorArgs)
    }
  }, [trace.runTrace, trace.runTraceFromSource])

  // Re-run the trace after a FRESH graph reload (editor edit / file-browser pick),
  // but only if it's still the same function that was being traced — otherwise stale
  // args could get replayed against an unrelated function's signature.
  // Deliberately keyed on `context` alone: `handleRunTrace` already ran the trace once
  // for its own call, so reacting to `lastTrace` here too would just re-run it twice.
  // If the function no longer matches *and* this was a fresh, unrelated load, the old
  // trace is for a function that's no longer even shown — clear it instead of leaving
  // its variables sitting in the panel.
  //
  // Gated on `isFresh`: plain graph *navigation* (drilling into a call, back,
  // breadcrumb) also changes context.entry_function, but the existing trace already
  // covers the whole call tree — including every level of a recursive call — so it
  // must NOT be re-run there. Re-running would rebuild the TraceIndex under a new
  // object reference, which resets useTraceView's base-frame stack back to the entry
  // frame on every single navigation. For a recursive function this fires on every
  // click (context.entry_function always matches lastTrace.fn, since it's the same
  // function calling itself), silently undoing each "go deeper" the moment it happens
  // — you could never actually reach the base case.
  useEffect(() => {
    if (!context) return
    const isFresh = freshLoadRef.current
    freshLoadRef.current = false
    if (!isFresh) return
    if (lastTrace && lastTrace.fn === context.entry_function) {
      if (DEMO_MODE) {
        trace.runTraceFromSource(lastSourceRef.current, context.entry_function, lastTrace.args, lastTrace.constructorArgs)
      } else {
        trace.runTrace(context.entry_file, context.entry_function, lastTrace.args, lastTrace.constructorArgs)
      }
    } else {
      trace.clearTrace()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context])

  useEffect(() => {
    if (DEMO_MODE) return
    fetch('/api/config')
      .then(r => r.json())
      .then((cfg: { root?: string }) => {
        if (cfg.root) setProjectRoot(cfg.root)
      })
      .catch(() => {})
  }, [])

  // Checked once per launch, not on a timer — a relaunch after installing
  // picks up the next check anyway. check() throws when there's no Tauri
  // IPC bridge at all (the demo build, or this app running in a plain
  // browser during local testing), so this is a no-op there.
  useEffect(() => {
    if (DEMO_MODE) return
    check()
      .then(update => {
        if (update) setAvailableUpdate(update)
      })
      .catch(() => {})
  }, [])

  // When context loads from editor, we don't know the temp file path until then
  useEffect(() => {
    if (context && navStack.length === 0) {
      setNavStack([{ file: context.entry_file, fn: context.entry_function }])
    }
  }, [context])

  const handleEditorRun = useCallback((source: string, fn: string) => {
    lastSourceRef.current = source
    freshLoadRef.current = true
    setNavStack([])
    loadGraphFromSource(source, fn, 1)
  }, [loadGraphFromSource])

  const handleFileSelect = useCallback((file: string, fn: string) => {
    freshLoadRef.current = true
    setNavStack([{ file, fn }])
    loadGraph({ file, function: fn, depth: 1, root: projectRoot })
  }, [loadGraph, projectRoot])

  // Every in-graph navigation (drilling into a call, breadcrumb, refresh, back) reloads
  // by (file, function) — fine for the desktop build's real files, but the demo build's
  // sandboxed backend has no /api/graph route and no file to point at (the pasted source
  // only ever exists as a per-request temp file, already gone by the time you'd navigate).
  // Demo mode instead reloads from the pasted source itself, same as the initial editor
  // load and the trace-preserving effect above — `file` is ignored there since the whole
  // snippet is one self-contained source, so the target function is always in it.
  const loadGraphAny = useCallback((file: string, fn: string, depth: number) => {
    if (DEMO_MODE) {
      loadGraphFromSource(lastSourceRef.current, fn, depth)
    } else {
      loadGraph({ file, function: fn, depth, root: projectRoot })
    }
  }, [loadGraph, loadGraphFromSource, projectRoot])

  const handleNavigate = useCallback((file: string, fn: string, callLine: number) => {
    setNavStack(prev => [...prev, { file, fn }])
    loadGraphAny(file, fn, 1)
    traceView.enterCall(callLine)
  }, [loadGraphAny, traceView.enterCall])

  const handleNavigateTo = useCallback((index: number) => {
    const frame = navStack[index]
    if (!frame) return
    setNavStack(navStack.slice(0, index + 1))
    loadGraphAny(frame.file, frame.fn, 1)
    traceView.exitToDepth(index)
  }, [navStack, loadGraphAny, traceView.exitToDepth])

  const handleRefresh = useCallback(() => {
    const current = navStack[navStack.length - 1]
    if (!current) return
    loadGraphAny(current.file, current.fn, 1)
  }, [navStack, loadGraphAny])

  const handleBack = useCallback(() => {
    if (navStack.length > 1) {
      const target = navStack[navStack.length - 2]
      setNavStack(prev => prev.slice(0, -1))
      loadGraphAny(target.file, target.fn, 1)
      traceView.exitToDepth(navStack.length - 2)
    } else {
      clearGraph()
      setNavStack([])
    }
  }, [navStack, loadGraphAny, clearGraph, traceView.exitToDepth])

  if (!projectRoot) {
    return (
      <div className="flex flex-col h-screen bg-[#0f1117]">
        <ResizeHandles />
        <div data-tauri-drag-region className="h-11 shrink-0 flex items-center">
          <WindowControls />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
            <Zap size={32} className="text-indigo-400" />
          </motion.div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-screen h-screen flex flex-col bg-[#0f1117] text-white overflow-hidden">
      <ResizeHandles />

      {availableUpdate && <UpdateBanner update={availableUpdate} />}

      {/* Global top bar — data-tauri-drag-region makes its empty space
          window-draggable in the desktop build; WindowControls' buttons are
          unaffected since Tauri only drags when the exact mousedown target
          carries the attribute, not an ancestor. */}
      <div
        data-tauri-drag-region
        className="h-11 shrink-0 flex items-center pl-4 gap-3 bg-gray-900/80 backdrop-blur border-b border-gray-800"
      >
        <Logo size={15} />
        <div className="h-4 w-px bg-gray-700 mx-1" />
        <div className="flex gap-1">
          <TabBtn active={sourceTab === 'editor'} onClick={() => setSourceTab('editor')}>
            <Code2 size={12} /> Editor
          </TabBtn>
          {!DEMO_MODE && (
            <TabBtn active={sourceTab === 'file'} onClick={() => setSourceTab('file')}>
              <FolderOpen size={12} /> Local File
            </TabBtn>
          )}
          <button
            onClick={() => setShowGuide(true)}
            title="How to use Tracinator"
            className="flex items-center justify-center w-6 h-6 rounded text-gray-500 hover:text-white hover:bg-gray-700/50 transition-colors"
          >
            <HelpCircle size={14} />
          </button>
        </div>
        <WindowControls />
      </div>

      {/* Split layout */}
      <div ref={splitContainerRef} className="flex flex-1 min-h-0">

        {/* Left panel */}
        <div className="shrink-0 flex flex-col min-h-0" style={{ width: leftPanel.width }}>
          {DEMO_MODE || sourceTab === 'editor'
            ? <EditorPane onRun={handleEditorRun} loading={loading} />
            : <FileBrowser root={projectRoot} onSelect={handleFileSelect} onFilesPanelResize={leftPanel.grow} />
          }
        </div>

        <ResizeDivider onMouseDown={leftPanel.onMouseDown} />

        {/* Right panel — graph */}
        <div className="flex-1 min-h-0 relative bg-[#0f1117]">
          {!context && !loading && !error && <EmptyState />}
          {loading && <LoadingState />}
          {error && !loading && <ErrorState error={error} onDismiss={clearGraph} />}
          {context && !loading && (
            <ReactFlowProvider>
              <GraphCanvas
                context={context}
                navStack={navStack}
                onNavigate={handleNavigate}
                onNavigateTo={handleNavigateTo}
                onBack={handleBack}
                onRefresh={handleRefresh}
                onRunTrace={handleRunTrace}
                lastTrace={lastTrace}
                source={DEMO_MODE ? lastSourceRef.current : undefined}
                onCallNodeClick={handleCallNodeClick}
                onLineNodeClick={handleLineNodeClick}
                traceIndex={trace.index}
                activeFrameId={traceView.baseFrameId}
              />
            </ReactFlowProvider>
          )}
        </div>

        <VariablePanel
          collapsed={panelCollapsed}
          onToggleCollapse={() => setPanelCollapsed((c) => !c)}
          loading={trace.loading}
          error={trace.error}
          result={trace.result}
          index={trace.index}
          nav={traceView.nav}
          breadcrumb={traceView.breadcrumb}
          notFound={traceView.notFound}
          viewPoint={traceView.viewPoint}
          viewSeq={traceView.viewSeq}
          onNavigateToFrame={traceView.navigateToFrame}
          onJumpToOccurrence={traceView.jumpToOccurrence}
        />

      </div>

      {showTour && context && !loading && <Onboarding steps={MAIN_TOUR_STEPS} onDone={dismissTour} />}
      {showGuide && <DemoGuideModal onClose={() => setShowGuide(false)} />}
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
        active
          ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-600/40'
          : 'text-gray-400 hover:text-white hover:bg-gray-700/50 border border-transparent'
      }`}
    >
      {children}
    </button>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
      <div className="w-16 h-16 rounded-2xl bg-gray-800/60 border border-gray-700/60 flex items-center justify-center">
        <Zap size={28} className="text-gray-600" />
      </div>
      <div>
        <p className="text-gray-400 text-sm font-medium mb-1">No graph yet</p>
        <p className="text-gray-600 text-xs leading-relaxed">
          Write or open a Python file,<br />pick a function, and see the flow
        </p>
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
        <Zap size={32} className="text-indigo-400" />
      </motion.div>
      <p className="text-gray-400 text-sm font-mono">Analyzing…</p>
    </div>
  )
}

function ErrorState({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-center h-full px-6">
      <div className="max-w-sm w-full bg-red-950/60 border border-red-700 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-red-400 text-base">✗</span>
          <span className="text-red-300 font-semibold text-sm">Analysis failed</span>
        </div>
        <div className="text-red-200 text-xs font-mono bg-red-900/30 rounded-lg p-3 leading-relaxed break-words">
          {error}
        </div>
        <button onClick={onDismiss} className="mt-3 text-indigo-400 hover:text-indigo-300 text-xs underline">
          Dismiss
        </button>
      </div>
    </div>
  )
}
