export type NodeType =
  | 'ENTRY'
  | 'EXIT'
  | 'STATEMENT'
  | 'IF'
  | 'ELIF'
  | 'ELSE'
  | 'FOR'
  | 'WHILE'
  | 'TRY'
  | 'EXCEPT'
  | 'FINALLY'
  | 'WITH'
  | 'CALL'
  | 'RETURN'
  | 'RAISE'
  | 'BREAK'
  | 'CONTINUE'

export type EdgeType =
  | 'SEQUENTIAL'
  | 'TRUE'
  | 'FALSE'
  | 'EXCEPTION'
  | 'LOOP_BACK'
  | 'LOOP_EXIT'

// A lightweight pointer to a callee's graph — just enough to navigate to it
// (source_file + function_name) and to know navigation is possible at all. NOT
// the full nested cfg: that's already available, once, flat in
// PyProjectContext.all_graphs. A recursive call's own CALL node refers back to
// the very graph it's part of, so embedding the full structure here would be an
// unserializable cycle on the backend — see serializer.py's _serialize_sub_graph_ref.
export interface PySubGraphRef {
  function_name: string
  qualified_name: string
  source_file: string
}

export interface PyGraphNode {
  id: string
  node_type: NodeType
  label: string
  source_file: string
  start_line: number
  end_line: number
  raw_code: string
  condition: string | null
  is_collapsed: boolean
  called_function: string | null
  // 0-based index among CALL nodes sharing the same start_line, in evaluation
  // order — disambiguates e.g. `cat.speak() + dog.speak()` on one line, since the
  // trace's own call sites are keyed by (parent_frame_id, call_line) alone.
  call_occurrence: number
  sub_graph: PySubGraphRef | null
}

export interface PyGraphEdge {
  id: string
  source_id: string
  target_id: string
  edge_type: EdgeType
  label: string | null
}

export interface PyControlFlowGraph {
  function_name: string
  qualified_name: string
  source_file: string
  start_line: number
  end_line: number
  nodes: PyGraphNode[]
  edges: PyGraphEdge[]
  entry_node_id: string
  exit_node_ids: string[]
}

export interface PyProjectContext {
  project_root: string
  entry_file: string
  entry_function: string
  all_graphs: Record<string, PyControlFlowGraph>
}

export interface TracinatorConfig {
  file: string
  function: string
  depth: number
  root: string
}

export type MethodKind = 'instance' | 'classmethod' | 'staticmethod'

export interface FunctionInfo {
  name: string
  qualified_name: string
  class_name: string | null
  method_kind: MethodKind | null
  line: number
  args: string[]
  constructor_args?: string[]
}
