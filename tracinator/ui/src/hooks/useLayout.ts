import dagre from '@dagrejs/dagre'
import { Node, Edge } from '@xyflow/react'

const NODE_WIDTH = 240
const NODE_HEIGHT = 72
// StatementNode.tsx (the only node type that doesn't truncate to one line —
// it renders grouped sequential statements via `whitespace-pre-wrap`, one
// per `\n`-separated segment) adds roughly one line-height per wrapped
// visual line beyond the first. Matches its `text-xs leading-tight` sizing;
// every other node type stays single-line (`truncate`), so NODE_HEIGHT
// alone already fits it.
const EXTRA_LINE_HEIGHT = 16
// StatementNode is `max-w-[240px]` with `px-3` (12px) padding each side, so
// ~216px of text width; at `font-mono text-xs` (12px), monospace glyphs run
// roughly 0.6x the font size wide — about 7px/char, ~30 chars/line. A single
// long statement (e.g. a call with several kwargs, or a multi-arg literal)
// routinely blows past that and *wraps* within the box — counting only
// `\n`-separated segments (as an earlier version of this function did)
// undercounts badly for exactly that case: a 200-character line isn't "1
// line", it's ~7 wrapped ones, and dagre needs to reserve height for all of
// them or the node overflows into whatever it placed below.
const CHARS_PER_LINE = 30

function estimateWrappedLineCount(label: string): number {
  return label
    .split('\n')
    .reduce((total, segment) => total + Math.max(1, Math.ceil(segment.length / CHARS_PER_LINE)), 0)
}

// Dagre lays out boxes at a fixed size per node; if a node's *actual*
// rendered height (StatementNode's, when it groups several statements or
// just has one long one) exceeds what dagre reserved for it, it visually
// overlaps whatever dagre placed in the rank below — this estimates that
// real height instead of assuming every node is NODE_HEIGHT.
function estimateNodeHeight(n: Node): number {
  if (n.type !== 'STATEMENT') return NODE_HEIGHT
  const label = (n.data as { pyNode?: { label?: string } } | undefined)?.pyNode?.label ?? ''
  const extraLines = Math.max(0, estimateWrappedLineCount(label) - 1)
  return NODE_HEIGHT + extraLines * EXTRA_LINE_HEIGHT
}

export function computeLayout(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes

  // @ts-ignore
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80, marginx: 40, marginy: 40 })

  const heights = new Map<string, number>()
  nodes.forEach((n) => {
    const height = estimateNodeHeight(n)
    heights.set(n.id, height)
    g.setNode(n.id, { width: NODE_WIDTH, height })
  })
  edges.forEach((e) => {
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.setEdge(e.source, e.target)
    }
  })

  dagre.layout(g)

  return nodes.map((n) => {
    const pos = g.node(n.id)
    if (!pos) return n
    const height = heights.get(n.id) ?? NODE_HEIGHT
    return {
      ...n,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - height / 2,
      },
    }
  })
}
