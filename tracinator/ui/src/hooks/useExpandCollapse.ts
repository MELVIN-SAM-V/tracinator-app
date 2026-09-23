import { Node, Edge } from '@xyflow/react'
import { PyProjectContext, PyControlFlowGraph } from '../types/graph'

interface FlatResult {
  nodes: Node[]
  edges: Edge[]
}

export function flattenGraph(context: PyProjectContext): FlatResult {
  const result: FlatResult = { nodes: [], edges: [] }

  let entryCfg: PyControlFlowGraph | undefined
  for (const cfg of Object.values(context.all_graphs)) {
    if (cfg.function_name === context.entry_function && cfg.source_file === context.entry_file) {
      entryCfg = cfg
      break
    }
  }
  if (!entryCfg) entryCfg = Object.values(context.all_graphs)[0]
  if (!entryCfg) return result

  for (const n of entryCfg.nodes) {
    result.nodes.push({
      id: n.id,
      type: n.node_type,
      position: { x: 0, y: 0 },
      data: { pyNode: n },
    })
  }

  for (const e of entryCfg.edges) {
    result.edges.push({
      id: e.id,
      source: e.source_id,
      target: e.target_id,
      type: 'labeled',
      data: { edgeType: e.edge_type, label: e.label },
    })
  }

  return result
}
