import { PyGraphNode } from '../../types/graph'

export interface NodeData {
  pyNode: PyGraphNode
}

// IfNode's diamond fills exactly this box, so React Flow's default handle
// positions (top/bottom/right centre) land on its tips. useLayout reserves
// the same size for it.
export const IF_NODE_WIDTH = 240
export const IF_NODE_HEIGHT = 120

export function basename(path: string): string {
  // Split on both separators: the desktop app on Windows reports paths
  // like C:\Users\...\file.py, and splitting on '/' alone returned the
  // whole path, which widened nodes past their layout slot.
  return path.split(/[\\/]/).pop() ?? path
}
