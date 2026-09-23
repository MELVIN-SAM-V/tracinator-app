import { describe, expect, it } from 'vitest'
import type { CapturedValue, TraceEvent } from '../types/trace'
import { buildTraceIndex } from './traceIndex'
import { getBreadcrumb, navigateIntoCall, navigateToFrame, stepOccurrence } from './traceNavigation'

let seqCounter = 0
function resetSeq() {
  seqCounter = 0
}
function ev(
  partial: Partial<Omit<TraceEvent, 'return_value'>> &
    Pick<TraceEvent, 'event' | 'frame_id' | 'func'> & { return_value?: string | null },
): TraceEvent {
  const { return_value, ...rest } = partial
  return {
    seq: seqCounter++,
    parent_frame_id: null,
    file: 'f.py',
    line: 1,
    call_line: null,
    locals: {},
    return_value: return_value === undefined || return_value === null ? null : retval(return_value),
    global_scope_id: null,
    ...rest,
  }
}
function retval(repr: string): CapturedValue {
  return { repr, id: null }
}

function loopFixture() {
  resetSeq()
  const events = [
    ev({ event: 'call', frame_id: 1, func: 'run' }),
    ev({ event: 'call', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5 }),
    ev({ event: 'return', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '0' }),
    ev({ event: 'call', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5 }),
    ev({ event: 'return', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '1' }),
    ev({ event: 'call', frame_id: 4, func: 'noop', parent_frame_id: 1, call_line: 5 }),
    ev({ event: 'return', frame_id: 4, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '2' }),
    ev({ event: 'return', frame_id: 1, func: 'run', return_value: 'None' }),
  ]
  return buildTraceIndex(events)
}

describe('navigateIntoCall', () => {
  it('defaults to the first occurrence of a repeated call site', () => {
    const index = loopFixture()
    const state = navigateIntoCall(index, { parentFrameId: 1, callLine: 5 })
    expect(state).toEqual({ frameId: 2, occurrenceIndex: 0, occurrences: [2, 3, 4] })
  })

  it('resolves to the occurrence nearest-after a cursor seq — not always the first', () => {
    const index = loopFixture()
    // Call 2 (frame 3) returns at seq 4 — stepping from there should land on call 3
    // (frame 4, which starts at seq 5), not reset back to call 1.
    const state = navigateIntoCall(index, { parentFrameId: 1, callLine: 5 }, 4)
    expect(state?.frameId).toBe(4)
    expect(state?.occurrenceIndex).toBe(2)
  })

  it('returns null for a call site with no occurrences', () => {
    const index = loopFixture()
    expect(navigateIntoCall(index, { parentFrameId: 1, callLine: 999 })).toBeNull()
  })
})

// A real recursive fibonacci_nth(4) call tree (parent/call_line exactly as
// event_tracer.py produces it — every call shares call_line 4, since both
// recursive calls live on one `return fibonacci_nth(n-1) + fibonacci_nth(n-2)` line).
function fibonacciFixture() {
  resetSeq()
  const n = (v: string) => ({ n: { repr: v, id: null, kind: 'param' as const } })
  const events = [
    ev({ event: 'call', frame_id: 1, func: 'fibonacci_nth', locals: n('4') }),
    ev({ event: 'call', frame_id: 2, func: 'fibonacci_nth', parent_frame_id: 1, call_line: 4, locals: n('3') }),
    ev({ event: 'call', frame_id: 3, func: 'fibonacci_nth', parent_frame_id: 2, call_line: 4, locals: n('2') }),
    ev({ event: 'call', frame_id: 4, func: 'fibonacci_nth', parent_frame_id: 3, call_line: 4, locals: n('1') }),
    ev({ event: 'return', frame_id: 4, func: 'fibonacci_nth', parent_frame_id: 3, call_line: 4, return_value: '1' }),
    ev({ event: 'call', frame_id: 5, func: 'fibonacci_nth', parent_frame_id: 3, call_line: 4, locals: n('0') }),
    ev({ event: 'return', frame_id: 5, func: 'fibonacci_nth', parent_frame_id: 3, call_line: 4, return_value: '0' }),
    ev({ event: 'return', frame_id: 3, func: 'fibonacci_nth', parent_frame_id: 2, call_line: 4, return_value: '1' }),
    ev({ event: 'call', frame_id: 6, func: 'fibonacci_nth', parent_frame_id: 2, call_line: 4, locals: n('1') }),
    ev({ event: 'return', frame_id: 6, func: 'fibonacci_nth', parent_frame_id: 2, call_line: 4, return_value: '1' }),
    ev({ event: 'return', frame_id: 2, func: 'fibonacci_nth', parent_frame_id: 1, call_line: 4, return_value: '2' }),
    ev({ event: 'call', frame_id: 7, func: 'fibonacci_nth', parent_frame_id: 1, call_line: 4, locals: n('2') }),
    ev({ event: 'call', frame_id: 8, func: 'fibonacci_nth', parent_frame_id: 7, call_line: 4, locals: n('1') }),
    ev({ event: 'return', frame_id: 8, func: 'fibonacci_nth', parent_frame_id: 7, call_line: 4, return_value: '1' }),
    ev({ event: 'call', frame_id: 9, func: 'fibonacci_nth', parent_frame_id: 7, call_line: 4, locals: n('0') }),
    ev({ event: 'return', frame_id: 9, func: 'fibonacci_nth', parent_frame_id: 7, call_line: 4, return_value: '0' }),
    ev({ event: 'return', frame_id: 7, func: 'fibonacci_nth', parent_frame_id: 1, call_line: 4, return_value: '1' }),
    ev({ event: 'return', frame_id: 1, func: 'fibonacci_nth', return_value: '3' }),
  ]
  return buildTraceIndex(events)
}

describe('navigateIntoCall — recursion', () => {
  // Regression test for a bug where the app re-ran the trace (rebuilding the
  // TraceIndex under a new object reference) on every navigation into a
  // recursive call, since context.entry_function always equals lastTrace.fn for
  // a function calling itself — silently resetting navigation back to the top
  // on every click, so the base case could never be reached. That was an
  // App.tsx wiring bug, not a navigateIntoCall bug, but this pins the contract
  // the fix depends on: repeated navigateIntoCall calls against the SAME index
  // must walk all the way down to the base case.
  it('repeatedly navigating with no cursor (the n-1 branch, always first) reaches the base case', () => {
    const index = fibonacciFixture()
    let parentFrameId = 1
    const nAtEachStep: string[] = []
    for (let i = 0; i < 10; i++) {
      const n = index.history.get(`${parentFrameId}:n`)?.[0]?.value.repr
      if (n) nAtEachStep.push(n)
      const next = navigateIntoCall(index, { parentFrameId, callLine: 4 })
      if (!next) break
      parentFrameId = next.frameId
    }
    expect(nAtEachStep).toEqual(['4', '3', '2', '1'])
    // frame 4 (n=1) is the base case — no further calls at its own call site.
    expect(navigateIntoCall(index, { parentFrameId: 4, callLine: 4 })).toBeNull()
  })

  it('a cursor past the n-1 branch resolves to the n-2 branch, independently at every depth', () => {
    const index = fibonacciFixture()
    // At each level, the n-1 branch (occurrence 0) returns before the n-2 branch
    // (occurrence 1) is even called — stepping from just past that return seq lands on
    // the n-2 branch, the same way "next" would after finishing the n-1 subtree.
    expect(navigateIntoCall(index, { parentFrameId: 1, callLine: 4 }, 10)?.frameId).toBe(7) // frame 2 (n-1) returns at seq 10
    expect(navigateIntoCall(index, { parentFrameId: 2, callLine: 4 }, 7)?.frameId).toBe(6) // frame 3 (n-1) returns at seq 7
    expect(navigateIntoCall(index, { parentFrameId: 3, callLine: 4 }, 4)?.frameId).toBe(5) // frame 4 (n-1) returns at seq 4
  })
})

describe('navigateIntoCall — nested calls inside a loop', () => {
  // run() loops twice, calling process(x) -> validate(x) each time. Both process()
  // calls share one call site (line 5), and both validate() calls share one call site
  // (line 20) — the graph has exactly one CALL node for each, same as a real loop body.
  function loopWithNestedCallFixture() {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'run' }), // seq 0
      // iteration 1: process(items[0]) -> validate(items[0])
      ev({ event: 'call', frame_id: 2, func: 'process', parent_frame_id: 1, call_line: 5 }), // seq 1
      ev({ event: 'call', frame_id: 3, func: 'validate', parent_frame_id: 2, call_line: 20 }), // seq 2
      ev({ event: 'return', frame_id: 3, func: 'validate', parent_frame_id: 2, call_line: 20, return_value: 'True' }), // seq 3
      ev({ event: 'return', frame_id: 2, func: 'process', parent_frame_id: 1, call_line: 5, return_value: 'None' }), // seq 4
      // iteration 2: process(items[1]) -> validate(items[1])
      ev({ event: 'call', frame_id: 4, func: 'process', parent_frame_id: 1, call_line: 5 }), // seq 5
      ev({ event: 'call', frame_id: 5, func: 'validate', parent_frame_id: 4, call_line: 20 }), // seq 6
      ev({ event: 'return', frame_id: 5, func: 'validate', parent_frame_id: 4, call_line: 20, return_value: 'True' }), // seq 7
      ev({ event: 'return', frame_id: 4, func: 'process', parent_frame_id: 1, call_line: 5, return_value: 'None' }), // seq 8
      ev({ event: 'return', frame_id: 1, func: 'run', return_value: 'None' }), // seq 9
    ]
    return buildTraceIndex(events)
  }

  it('a cursor past iteration 1 lands the outer call on iteration 2, not back on iteration 1', () => {
    const index = loopWithNestedCallFixture()
    // Stepping "next" right after iteration 1's process() finished (seq 4) should land
    // on iteration 2's process() (frame 4) — the second call, not the first.
    const outer = navigateIntoCall(index, { parentFrameId: 1, callLine: 5 }, 4)
    expect(outer?.frameId).toBe(4)
    expect(outer?.occurrenceIndex).toBe(1)
  })

  it('once inside iteration 2, the nested call resolves within that same iteration', () => {
    const index = loopWithNestedCallFixture()
    const outer = navigateIntoCall(index, { parentFrameId: 1, callLine: 5 }, 4)
    // validate() is scoped to whichever process() frame we're inside — parentFrameId 4
    // (iteration 2) — so this must resolve to frame 5 (iteration 2's validate), never
    // frame 3 (iteration 1's validate), even though both share call_line 20.
    const inner = navigateIntoCall(index, { parentFrameId: outer!.frameId, callLine: 20 })
    expect(inner?.frameId).toBe(5)
  })
})

describe('stepOccurrence', () => {
  it('steps forward and backward, clamped to the valid range', () => {
    const index = loopFixture()
    const first = navigateIntoCall(index, { parentFrameId: 1, callLine: 5 })!
    const second = stepOccurrence(first, 1)
    expect(second.frameId).toBe(3)
    const third = stepOccurrence(second, 1)
    expect(third.frameId).toBe(4)
    const stillThird = stepOccurrence(third, 1) // already at the last occurrence
    expect(stillThird).toEqual(third)
    const back = stepOccurrence(third, -2)
    expect(back.frameId).toBe(2)
  })
})

describe('navigateToFrame', () => {
  it('reconstructs which occurrence a frame is, out of its call site siblings', () => {
    const index = loopFixture()
    const state = navigateToFrame(index, 3)
    expect(state).toEqual({ frameId: 3, occurrenceIndex: 1, occurrences: [2, 3, 4] })
  })

  it('handles the entry frame, which has no call site siblings', () => {
    const index = loopFixture()
    const state = navigateToFrame(index, 1)
    expect(state.frameId).toBe(1)
    expect(state.occurrences).toEqual([1])
  })
})

describe('getBreadcrumb', () => {
  it('is entry-frame-first, current-frame-last', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'a' }),
      ev({ event: 'call', frame_id: 2, func: 'b', parent_frame_id: 1, call_line: 2 }),
      ev({ event: 'call', frame_id: 3, func: 'c', parent_frame_id: 2, call_line: 5 }),
      ev({ event: 'return', frame_id: 3, func: 'c', parent_frame_id: 2, call_line: 5, return_value: 'None' }),
      ev({ event: 'return', frame_id: 2, func: 'b', parent_frame_id: 1, call_line: 2, return_value: 'None' }),
      ev({ event: 'return', frame_id: 1, func: 'a', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    expect(getBreadcrumb(index, 3)).toEqual([1, 2, 3])
    expect(getBreadcrumb(index, 1)).toEqual([1])
  })
})
