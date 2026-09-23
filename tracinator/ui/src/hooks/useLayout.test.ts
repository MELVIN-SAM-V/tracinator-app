import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { computeLayout } from './useLayout'

function statementNode(id: string, lines: number): Node {
  return {
    id,
    type: 'STATEMENT',
    position: { x: 0, y: 0 },
    data: { pyNode: { label: Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') } },
  }
}

function longLineStatementNode(id: string, charCount: number): Node {
  return {
    id,
    type: 'STATEMENT',
    position: { x: 0, y: 0 },
    data: { pyNode: { label: 'x'.repeat(charCount) } },
  }
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target }
}

describe('computeLayout', () => {
  it('gives every node the same vertical position when all are single-line', () => {
    const nodes = [statementNode('a', 1), statementNode('b', 1)]
    const laid = computeLayout(nodes, [edge('a', 'b')])
    const [a, b] = laid
    expect(b.position.y).toBeGreaterThan(a.position.y)
  })

  it('reserves extra vertical space for a taller grouped-statement node, so the next rank does not overlap it', () => {
    // 'a' groups 5 statements (tall), 'b' follows it in the next rank.
    const nodes = [statementNode('a', 5), statementNode('b', 1)]
    const laid = computeLayout(nodes, [edge('a', 'b')])
    const a = laid.find((n) => n.id === 'a')!
    const b = laid.find((n) => n.id === 'b')!

    const aHeight = 72 + 4 * 16 // NODE_HEIGHT + (lines - 1) * EXTRA_LINE_HEIGHT
    const aBottom = a.position.y + aHeight
    expect(b.position.y).toBeGreaterThanOrEqual(aBottom)
  })

  it('does not add extra height for single-line statement nodes (unchanged baseline)', () => {
    const nodes = [statementNode('a', 1), statementNode('b', 1)]
    const laidTall = computeLayout([statementNode('a', 5), statementNode('b', 1)], [edge('a', 'b')])
    const laidShort = computeLayout(nodes, [edge('a', 'b')])
    const shortGap = laidShort.find((n) => n.id === 'b')!.position.y - laidShort.find((n) => n.id === 'a')!.position.y
    const tallGap = laidTall.find((n) => n.id === 'b')!.position.y - laidTall.find((n) => n.id === 'a')!.position.y
    expect(tallGap).toBeGreaterThan(shortGap)
  })

  // Regression: tests/test_api_graph.py's test_direct_recursion produces a
  // STATEMENT node with a single 205-char `\n`-free line (a long call
  // wrapped across several source lines collapses to one label line) that
  // wraps to ~7 visual lines inside the node's 240px box. An earlier version
  // of estimateNodeHeight only counted `\n`-separated segments (1, here) and
  // badly undercounted the real rendered height, so dagre placed the next
  // node right on top of this one's overflow.
  it('reserves extra vertical space for a single long line that wraps within the node, not just newline-separated ones', () => {
    const nodes = [longLineStatementNode('a', 205), statementNode('b', 1)]
    const laid = computeLayout(nodes, [edge('a', 'b')])
    const a = laid.find((n) => n.id === 'a')!
    const b = laid.find((n) => n.id === 'b')!

    const wrappedLines = Math.ceil(205 / 30) // CHARS_PER_LINE
    const aHeight = 72 + (wrappedLines - 1) * 16
    expect(b.position.y).toBeGreaterThanOrEqual(a.position.y + aHeight)
  })
})
