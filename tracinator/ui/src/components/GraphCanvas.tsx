import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  // MiniMap, // removed — blocked the view without adding much value; kept for easy re-add
  useNodesState,
  useEdgesState,
  useReactFlow,
  Node,
  Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AnimatePresence } from 'framer-motion'

import { nodeTypes } from './NodeTypes'
import LabeledEdge from './EdgeTypes/LabeledEdge'
import Toolbar from './Toolbar'
import NodeTooltip from './NodeTooltip'
import ContextMenu from './ContextMenu'

import { PyProjectContext, PyGraphNode } from '../types/graph'
import { flattenGraph } from '../hooks/useExpandCollapse'
import { computeLayout } from '../hooks/useLayout'
import { frameEntrySeq, frameViewSeq, type ViewPoint } from '../lib/frameQueries'
import { frameLineKey, type TraceIndex } from '../lib/traceIndex'

const edgeTypes = { labeled: LabeledEdge }

interface NavFrame {
  file: string
  fn: string
}

interface Props {
  context: PyProjectContext
  navStack: NavFrame[]
  onNavigate: (file: string, fn: string, callLine: number) => void
  onNavigateTo: (index: number) => void
  onBack: () => void
  onRefresh: () => void
  onRunTrace: (file: string, fn: string, args: string[], constructorArgs: string[]) => void
  lastTrace: { fn: string; args: string[]; constructorArgs: string[] } | null
  // Demo build only: the pasted source, threaded down to TraceArgsForm so it can
  // get a function's signature without /api/source (no real file for it to read).
  source?: string
  // `atSeq`, when given, overrides the implicit "wherever we were looking" cursor
  // with an exact target pass — used by seq-based arrow-key navigation below, which
  // (unlike a plain click) needs to jump to a specific occurrence/iteration, including
  // backward in time.
  onCallNodeClick?: (callLine: number, atSeq?: number) => void
  onLineNodeClick?: (point: ViewPoint, atSeq?: number) => void
  // Trace data for the currently displayed function, if any — used only to decide
  // which branch edge actually ran (see takenEdgeIds below).
  traceIndex?: TraceIndex | null
  activeFrameId?: number | null
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return true
  return !!target.closest('.monaco-editor')
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function getDescendants(nodeId: string, edgeList: Edge[]): Set<string> {
  const visited = new Set<string>()
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const edge of edgeList) {
      if (edge.source === current && !visited.has(edge.target) && edge.target !== nodeId) {
        visited.add(edge.target)
        queue.push(edge.target)
      }
    }
  }
  return visited
}

export default function GraphCanvas({ context, navStack, onNavigate, onNavigateTo, onBack, onRefresh, onRunTrace, lastTrace, source, onCallNodeClick, onLineNodeClick, traceIndex, activeFrameId }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const { fitView, getNode, getNodes } = useReactFlow()

  const dragRef = useRef<{
    nodeId: string
    initialPositions: Map<string, { x: number; y: number }>
  } | null>(null)

  // Every branch edge runs a continuous CSS animation (see `.edge-animated` /
  // `flowDot` in index.css) that repaints its dashed stroke every frame — not
  // GPU-compositable the way a transform is, so it competes for main-thread
  // time with the zoom transform itself while the user is actively scrolling
  // to zoom. On a big function (lots of branch edges) that's the difference
  // between smooth and terrible-feeling scroll. Toggled via direct DOM class
  // (not React state) so pausing/resuming doesn't itself trigger a render.
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null)
  const handleMoveStart = useCallback(() => {
    canvasWrapperRef.current?.classList.add('rf-interacting')
  }, [])
  const handleMoveEnd = useCallback(() => {
    canvasWrapperRef.current?.classList.remove('rf-interacting')
  }, [])

  const [tooltip, setTooltip] = useState<{ node: PyGraphNode; x: number; y: number } | null>(null)
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [ctxMenu, setCtxMenu] = useState<{ node: PyGraphNode; x: number; y: number } | null>(null)

  // Tracked separately from React Flow's own `.selected` node flag (which only moves
  // on pointer interaction) so arrow-key navigation has a stable "current" node to
  // step from, and to sync the ring highlight after a programmatic selection change.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // Which of the selected node's (possibly several) executed passes is current — e.g.
  // a loop-body line has one seq per iteration. Only meaningful under seq-based nav
  // (see moveSelectionSeq); null under structural nav or when nothing's selected yet.
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)

  // Node ids are derived from source location (qualified_name + node_type +
  // line), not per-visit — navigating into a recursive call reloads the same
  // function's graph with the exact same ids and (since it's the same shape)
  // the exact same dagre-computed positions. React Flow then just updates
  // the already-mounted node elements in place: no unmount/remount, so the
  // motion.div fade-in never replays and nothing *looks* like it changed —
  // reads as the new graph being silently stuck on top of the old one.
  // loadKey forces a full remount of the canvas below on every navigation
  // (recursive or not) so it's always visually obvious a fresh graph loaded.
  const [loadKey, setLoadKey] = useState(0)

  // Rebuild graph whenever context changes
  useEffect(() => {
    const { nodes: rawNodes, edges: rawEdges } = flattenGraph(context)
    const laid = computeLayout(rawNodes as Node[], rawEdges as Edge[])
    setNodes(laid as Node[])
    setEdges(rawEdges as Edge[])
    setSelectedNodeId(null)
    setSelectedSeq(null)
    setLoadKey((k) => k + 1)
    setTimeout(() => fitView({ duration: 400, padding: 0.15 }), 50)
  }, [context])

  // A fresh trace run (or navigating to a different call) assigns new frame ids and
  // seq numbers — any previously selected pass would silently point at a coincidental,
  // unrelated seq in the new trace, so drop the selection rather than keep it.
  useEffect(() => {
    setSelectedNodeId(null)
    setSelectedSeq(null)
  }, [activeFrameId])

  // Parent/child adjacency for arrow-key navigation, excluding LOOP_BACK edges — a
  // loop header's "parent" for Up should be whatever precedes the loop, not the
  // back-edge from its own last body statement, and that back-edge isn't a "child" either.
  const adjacency = useMemo(() => {
    const parents = new Map<string, string[]>()
    const children = new Map<string, string[]>()
    for (const e of edges) {
      const edgeType = (e.data as { edgeType?: string } | undefined)?.edgeType
      if (edgeType === 'LOOP_BACK') continue
      if (!children.has(e.source)) children.set(e.source, [])
      children.get(e.source)!.push(e.target)
      if (!parents.has(e.target)) parents.set(e.target, [])
      parents.get(e.target)!.push(e.source)
    }
    return { parents, children }
  }, [edges])

  // Every seq at which each node actually ran this trace, in execution order — the
  // basis for seq-based arrow-key navigation (see moveSelectionSeq). Empty/absent for
  // a node the trace never reached (e.g. a branch not taken), which simply drops it
  // from that navigation rather than leaving a dead end.
  const nodeSeqs = useMemo(() => {
    const map = new Map<string, number[]>()
    if (!traceIndex || activeFrameId == null) return map
    for (const n of nodes) {
      const pyNode = (n.data as { pyNode: PyGraphNode }).pyNode
      let seqs: number[]
      if (pyNode.node_type === 'ENTRY') {
        seqs = [frameEntrySeq(traceIndex, activeFrameId)]
      } else if (pyNode.node_type === 'EXIT') {
        seqs = [frameViewSeq(traceIndex, activeFrameId)]
      } else if (pyNode.node_type === 'CALL') {
        // One pass per call occurrence at this call site, keyed by the callee frame's
        // own start — not the call line's lineExitSeq, which records the point right
        // *after* each occurrence already returned and so would resolve one occurrence
        // late when used as a target (see peekCall's atSeq).
        const occurrences = traceIndex.callSites.get(`${activeFrameId}:${pyNode.start_line}`) ?? []
        seqs = occurrences
          .map((frameId) => traceIndex.frameSpans.get(frameId)?.startSeq)
          .filter((s): s is number => s != null)
        if (seqs.length === 0) {
          // Not a traced call (e.g. a builtin) — nothing to peek into, but it still
          // ran, so fall back to its own line's exit seq to keep it reachable by Up/Down.
          seqs = traceIndex.lineExitSeq.get(frameLineKey(activeFrameId, pyNode.start_line)) ?? []
        }
      } else {
        seqs = traceIndex.lineExitSeq.get(frameLineKey(activeFrameId, pyNode.end_line)) ?? []
      }
      if (seqs.length > 0) map.set(n.id, seqs)
    }
    return map
  }, [nodes, traceIndex, activeFrameId])

  // Flattened, chronologically sorted (node, pass) timeline across the whole graph —
  // what Up/Down step through under seq-based nav.
  const timeline = useMemo(() => {
    const entries: { nodeId: string; seq: number }[] = []
    for (const [nodeId, seqs] of nodeSeqs) {
      for (const seq of seqs) entries.push({ nodeId, seq })
    }
    entries.sort((a, b) => a.seq - b.seq)
    return entries
  }, [nodeSeqs])

  // Which branch edges the active trace frame actually followed, so the graph can
  // stop animating (and dim) the one it didn't. A branch edge is "taken" if its
  // target node's line was reached in this frame — imprecise for loop-back vs. a
  // loop's very first entry (both light up the header's line), but exactly right for
  // the common if/else case this is meant to help with.
  const takenEdgeIds = useMemo(() => {
    const taken = new Set<string>()
    if (!traceIndex || activeFrameId == null) return taken
    const visited = traceIndex.visitedLines.get(activeFrameId)
    if (!visited) return taken
    const lineById = new Map(nodes.map((n) => [n.id, (n.data as { pyNode: PyGraphNode }).pyNode.start_line]))
    for (const e of edges) {
      const targetLine = lineById.get(e.target)
      if (targetLine != null && visited.has(targetLine)) taken.add(e.id)
    }
    return taken
  }, [edges, nodes, traceIndex, activeFrameId])

  const isTraced = !!traceIndex && activeFrameId != null
  const renderEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        data: { ...e.data, isTraced, isTaken: takenEdgeIds.has(e.id) },
      })),
    [edges, isTraced, takenEdgeIds],
  )

  // Dispatches the same "show variables at this point" behavior a click does — shared
  // by mouse clicks and arrow-key navigation. `atSeq`, when given, targets one exact
  // pass (seq-based nav); omitted, it resolves against the implicit cursor (a plain
  // click's behavior, unchanged).
  const selectNode = useCallback((pyNode: PyGraphNode, atSeq?: number) => {
    if (pyNode.node_type === 'CALL') {
      if (pyNode.sub_graph) onCallNodeClick?.(pyNode.start_line, atSeq)
    } else if (pyNode.node_type === 'ENTRY') {
      onLineNodeClick?.({ kind: 'entry' })
    } else if (pyNode.node_type === 'EXIT') {
      onLineNodeClick?.({ kind: 'exit' })
    } else {
      // end_line, not start_line — for a node that groups several statements (e.g.
      // a STATEMENT node covering `cat = Cat()` then `dog = Dog()`), start_line
      // would resolve to the state right after only the *first* one ran, before
      // later assignments in the same node happened. Single-line node types
      // (IF/FOR/RETURN/...) always have start_line === end_line, so this is a
      // no-op for them.
      onLineNodeClick?.({ kind: 'line', line: pyNode.end_line }, atSeq)
    }
  }, [onCallNodeClick, onLineNodeClick])

  // Single click selects the node and shows the variable state at that point;
  // navigating into a callee's definition needs a second, deliberate click.
  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
    setSelectedSeq(null)
    selectNode((node.data as { pyNode: PyGraphNode }).pyNode)
  }, [selectNode])

  // Selects a node programmatically (arrow-key navigation): syncs the ring highlight
  // and runs the same dispatch a click would. Deliberately doesn't touch the viewport —
  // stepping through nodes shouldn't pan/zoom the canvas out from under the user.
  // `atSeq` is set for seq-based nav (see moveSelectionSeq) so later Up/Down/Left/Right
  // presses know exactly which pass they're stepping from; left null for structural nav.
  const selectNodeById = useCallback((id: string, atSeq?: number) => {
    const node = getNode(id)
    if (!node) return
    setSelectedNodeId(id)
    setSelectedSeq(atSeq ?? null)
    setNodes((nds) => nds.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })))
    selectNode((node.data as { pyNode: PyGraphNode }).pyNode, atSeq)
  }, [getNode, setNodes, selectNode])

  const moveSelection = useCallback((direction: 'up' | 'down' | 'left' | 'right') => {
    if (!selectedNodeId) {
      const entry = nodes.find((n) => n.type === 'ENTRY')
      if (entry) selectNodeById(entry.id)
      return
    }
    const current = getNode(selectedNodeId)
    if (!current) return

    let candidateIds: string[]
    if (direction === 'up') {
      candidateIds = adjacency.parents.get(selectedNodeId) ?? []
    } else if (direction === 'down') {
      candidateIds = adjacency.children.get(selectedNodeId) ?? []
    } else {
      // Siblings: other children of the same parent(s) — lets you move sideways
      // between an if/else's branches without going back up first.
      const siblingSet = new Set<string>()
      for (const parentId of adjacency.parents.get(selectedNodeId) ?? []) {
        for (const c of adjacency.children.get(parentId) ?? []) {
          if (c !== selectedNodeId) siblingSet.add(c)
        }
      }
      candidateIds = Array.from(siblingSet)
    }
    if (candidateIds.length === 0) return

    const centerOf = (n: Node) => ({
      x: n.position.x + (n.measured?.width ?? 0) / 2,
      y: n.position.y + (n.measured?.height ?? 0) / 2,
    })
    const currentCenter = centerOf(current)
    const candidates = candidateIds
      .map((id) => getNode(id))
      .filter((n): n is Node => !!n)
      .map((n) => ({ node: n, center: centerOf(n) }))

    // Strictly one-directional — no wrap-around. If nothing sits to that exact side
    // (e.g. siblings stacked vertically instead of side-by-side), the key just does
    // nothing rather than jumping across to the far side.
    let pool = candidates
    if (direction === 'left') pool = candidates.filter((c) => c.center.x < currentCenter.x)
    else if (direction === 'right') pool = candidates.filter((c) => c.center.x > currentCenter.x)
    if (pool.length === 0) return

    const target = pool.sort((a, b) => distance(currentCenter, a.center) - distance(currentCenter, b.center))[0]
    if (target) selectNodeById(target.node.id)
  }, [selectedNodeId, adjacency, getNode, nodes, selectNodeById])

  // Arrow-key navigation once a trace is loaded: follows the order the code actually
  // ran in, instead of the graph's static parent/child shape. Up/Down step to the
  // previous/next node in the chronological timeline (across the whole graph); Left/
  // Right instead stay on the current node and cycle between ITS OWN repeated passes
  // (e.g. a loop-body line's separate iterations, or a call site's separate
  // occurrences) — a direct jump to another iteration without walking every node in
  // between. No wrap-around on any of the four, matching the structural nav above.
  const moveSelectionSeq = useCallback((direction: 'up' | 'down' | 'left' | 'right') => {
    if (timeline.length === 0) return

    const currentIndex = selectedNodeId != null && selectedSeq != null
      ? timeline.findIndex((t) => t.nodeId === selectedNodeId && t.seq === selectedSeq)
      : -1

    // No current position (nothing selected yet, or the previous selection doesn't
    // belong to this trace) — land on the very first thing that ran and stop there,
    // same as the structural fallback landing on ENTRY before actually moving.
    if (currentIndex === -1) {
      const first = timeline[0]
      selectNodeById(first.nodeId, first.seq)
      return
    }

    if (direction === 'up' || direction === 'down') {
      const nextIndex = currentIndex + (direction === 'down' ? 1 : -1)
      const entry = timeline[nextIndex]
      if (entry) selectNodeById(entry.nodeId, entry.seq)
      return
    }

    const passes = nodeSeqs.get(selectedNodeId!) ?? []
    const passIndex = passes.indexOf(selectedSeq!)
    const nextPass = passes[passIndex + (direction === 'right' ? 1 : -1)]
    if (nextPass != null) selectNodeById(selectedNodeId!, nextPass)
  }, [timeline, nodeSeqs, selectedNodeId, selectedSeq, selectNodeById])

  const handleNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    const pyNode = (node.data as { pyNode: PyGraphNode }).pyNode
    if (pyNode.node_type === 'CALL' && pyNode.sub_graph) {
      onNavigate(pyNode.sub_graph.source_file, pyNode.sub_graph.function_name, pyNode.start_line)
    }
  }, [onNavigate])

  const handleNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    const pyNode = (node.data as { pyNode: PyGraphNode }).pyNode
    tooltipTimer.current = setTimeout(() => {
      const rect = document.querySelector(`[data-id="${node.id}"]`)?.getBoundingClientRect()
      if (rect) {
        setTooltip({ node: pyNode, x: rect.right, y: rect.top })
      }
    }, 300)
  }, [])

  const handleNodeMouseLeave = useCallback(() => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current)
    setTooltip(null)
  }, [])

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault()
    const pyNode = (node.data as { pyNode: PyGraphNode }).pyNode
    setCtxMenu({ node: pyNode, x: e.clientX, y: e.clientY })
  }, [])

  const handleNodeDragStart = useCallback((_: unknown, node: Node) => {
    const descendants = getDescendants(node.id, edges)
    const initialPositions = new Map<string, { x: number; y: number }>()
    initialPositions.set(node.id, { ...node.position })
    for (const n of getNodes()) {
      if (descendants.has(n.id)) {
        initialPositions.set(n.id, { ...n.position })
      }
    }
    dragRef.current = { nodeId: node.id, initialPositions }
  }, [edges, getNodes])

  const handleNodeDrag = useCallback((_: unknown, node: Node) => {
    if (!dragRef.current || dragRef.current.nodeId !== node.id) return
    const startPos = dragRef.current.initialPositions.get(node.id)
    if (!startPos) return
    const dx = node.position.x - startPos.x
    const dy = node.position.y - startPos.y
    if (dx === 0 && dy === 0) return
    setNodes((nds) =>
      nds.map((n) => {
        const descStart = dragRef.current?.initialPositions.get(n.id)
        if (!descStart || n.id === node.id) return n
        return { ...n, position: { x: descStart.x + dx, y: descStart.y + dy } }
      })
    )
  }, [setNodes])

  const handleNodeDragStop = useCallback(() => {
    dragRef.current = null
  }, [])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'f' || e.key === 'F') fitView({ duration: 400 })
    if (e.key === 'Escape') {
      if (ctxMenu) setCtxMenu(null)
      else onBack()
    }
    const arrowDir =
      e.key === 'ArrowUp' ? 'up' :
      e.key === 'ArrowDown' ? 'down' :
      e.key === 'ArrowLeft' ? 'left' :
      e.key === 'ArrowRight' ? 'right' :
      null
    if (arrowDir && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)) {
      e.preventDefault()
      // Once a trace is loaded, arrows follow execution order (moveSelectionSeq)
      // instead of the graph's static shape — see its comment for the mapping. With
      // no trace there's no execution order to follow, so this falls back to the
      // original structural nav.
      if (traceIndex && activeFrameId != null) moveSelectionSeq(arrowDir)
      else moveSelection(arrowDir)
    }
  }, [fitView, ctxMenu, onBack, moveSelection, moveSelectionSeq, traceIndex, activeFrameId])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const handleFitNode = useCallback((id: string) => {
    const n = getNode(id)
    if (n) fitView({ nodes: [n], duration: 400, padding: 0.3 })
  }, [getNode, fitView])

  const largeGraph = nodes.length > 50

  return (
    <div className="w-full h-full relative">
      <Toolbar
        context={context}
        nodeCount={nodes.length}
        navStack={navStack}
        onNavigateTo={onNavigateTo}
        onBack={onBack}
        onRefresh={onRefresh}
        onRunTrace={onRunTrace}
        lastTrace={lastTrace}
        source={source}
      />

      {largeGraph && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 z-30 bg-amber-900/95 border border-amber-600 text-amber-200 text-xs px-3 py-1.5 rounded-full">
          Large graph
        </div>
      )}

      <div className="pt-12 h-full" data-tour="tour-graph" ref={canvasWrapperRef}>
        <ReactFlow
          key={loadKey}
          nodes={nodes}
          edges={renderEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeMouseEnter={handleNodeMouseEnter}
          onNodeMouseLeave={handleNodeMouseLeave}
          onNodeContextMenu={handleNodeContextMenu}
          onNodeDragStart={handleNodeDragStart}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onMoveStart={handleMoveStart}
          onMoveEnd={handleMoveEnd}
          fitView
          minZoom={0.1}
          maxZoom={2}
          panActivationKeyCode={null}
          disableKeyboardA11y
          onlyRenderVisibleElements={largeGraph}
          defaultEdgeOptions={{ type: 'labeled' }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="#1e2130"
          />
          <Controls showInteractive={false} />
          {/* Removed: blocked the view most of the time without adding much value.
          <MiniMap
            nodeColor={minimapColor}
            maskColor="rgba(15,17,23,0.7)"
            style={{ background: '#1a1d27' }}
          />
          */}
        </ReactFlow>
      </div>

      <AnimatePresence>
        {tooltip && (
          <NodeTooltip node={tooltip.node} x={tooltip.x} y={tooltip.y} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {ctxMenu && (
          <ContextMenu
            node={ctxMenu.node}
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
            onNavigate={onNavigate}
            onFitNode={handleFitNode}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/* Used by the removed <MiniMap> above.
function minimapColor(node: Node): string {
  const type = node.type as string
  const map: Record<string, string> = {
    ENTRY: '#34d399', EXIT: '#34d399', RETURN: '#34d399',
    IF: '#a78bfa', ELIF: '#a78bfa',
    FOR: '#22d3ee', WHILE: '#22d3ee',
    CALL: '#818cf8',
    RAISE: '#f87171',
    EXCEPT: '#fb923c',
    TRY: '#fbbf24',
    STATEMENT: '#475569',
  }
  return map[type] ?? '#475569'
}
*/
