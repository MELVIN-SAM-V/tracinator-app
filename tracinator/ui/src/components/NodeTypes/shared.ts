import { PyGraphNode } from '../../types/graph'

export interface NodeData {
  pyNode: PyGraphNode
}

export function basename(path: string): string {
  return path.split('/').pop() ?? path
}
