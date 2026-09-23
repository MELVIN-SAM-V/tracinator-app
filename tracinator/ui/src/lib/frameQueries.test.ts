import { describe, expect, it } from 'vitest'
import type { CapturedValue, LocalValue, TraceEvent } from '../types/trace'
import { buildTraceIndex } from './traceIndex'
import {
  frameLineSeq,
  frameViewSeq,
  getAncestorChain,
  getFrameState,
  getLiveAliases,
  getOccurrences,
  getOtherLiveAliases,
  nearestOccurrenceIndex,
} from './frameQueries'

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
function local(repr: string, id: number | null, kind: LocalValue['kind']): LocalValue {
  return { repr, id, kind }
}
function retval(repr: string): CapturedValue {
  return { repr, id: null }
}

describe('getFrameState', () => {
  it('buckets params, body locals, and globals into separate sections', () => {
    resetSeq()
    const events = [
      ev({ event: 'line', frame_id: 0, func: '<module>', locals: { TAX_RATE: local('0.08', null, 'global') } }),
      ev({ event: 'call', frame_id: 1, func: 'compute', locals: { amount: local('100.0', null, 'param') } }),
      ev({ event: 'line', frame_id: 1, func: 'compute', locals: { fee: local('8.0', null, 'body') } }),
      ev({ event: 'return', frame_id: 1, func: 'compute', return_value: '8.0' }),
    ]
    const index = buildTraceIndex(events)
    const state = getFrameState(index, 1)
    expect(state.param.amount.repr).toBe('100.0')
    expect(state.body.fee.repr).toBe('8.0')

    const globalState = getFrameState(index, 0)
    expect(globalState.global.TAX_RATE.repr).toBe('0.08')
  })

  it('regression: a function frame shows its module\'s globals even if it never reads them, via global_scope_id', () => {
    resetSeq()
    const events = [
      ev({ event: 'line', frame_id: 0, func: '<module>', locals: { x: local("'hello world'", null, 'global') } }),
      ev({
        event: 'call',
        frame_id: 1,
        func: 'greet',
        global_scope_id: 0,
        locals: { name: local("'world'", null, 'param') },
      }),
      ev({ event: 'return', frame_id: 1, func: 'greet', global_scope_id: 0, return_value: "'Hello, world!'" }),
    ]
    const index = buildTraceIndex(events)
    // Viewing greet's OWN frame (not frame 0 directly) must still surface `x` —
    // getFrameState(1, ...) has to merge in whichever global scope owns frame 1.
    expect(getFrameState(index, 1).global.x.repr).toBe("'hello world'")
  })

  it('answers point-in-time: value as of a given seq, not just the final value', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'run' }),
      ev({ event: 'call', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5 }),
      ev({ event: 'return', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '0' }),
      ev({ event: 'line', frame_id: 1, func: 'run', locals: { count: local('1', null, 'body') } }), // seq 3
      ev({ event: 'call', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5 }),
      ev({ event: 'return', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '1' }),
      ev({ event: 'line', frame_id: 1, func: 'run', locals: { count: local('2', null, 'body') } }), // seq 6
      ev({ event: 'return', frame_id: 1, func: 'run', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    expect(getFrameState(index, 1, 3).body.count.repr).toBe('1')
    expect(getFrameState(index, 1, 5).body.count.repr).toBe('1') // seq 6's update hasn't happened yet
    expect(getFrameState(index, 1, 6).body.count.repr).toBe('2')
    expect(getFrameState(index, 1).body.count.repr).toBe('2') // default: latest
  })

  it('returns empty sections for a frame that has not been called yet as of atSeq', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'main' }),
      ev({ event: 'call', frame_id: 2, func: 'helper', parent_frame_id: 1, call_line: 3, locals: { x: local('1', null, 'param') } }),
      ev({ event: 'return', frame_id: 2, func: 'helper', parent_frame_id: 1, call_line: 3, return_value: '1' }),
      ev({ event: 'return', frame_id: 1, func: 'main', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    expect(getFrameState(index, 2, 0)).toEqual({ global: {}, param: {}, body: {} })
  })
})

describe('getAncestorChain', () => {
  it('is empty for the entry frame and for the global scope', () => {
    resetSeq()
    const events = [
      ev({ event: 'line', frame_id: 0, func: '<module>', locals: { X: local('1', null, 'global') } }),
      ev({ event: 'call', frame_id: 1, func: 'main' }),
      ev({ event: 'return', frame_id: 1, func: 'main', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    expect(getAncestorChain(index, 1)).toEqual([])
    expect(getAncestorChain(index, 0)).toEqual([])
  })

  it('walks parent_frame_id from the entry frame down to the immediate parent', () => {
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
    expect(getAncestorChain(index, 3)).toEqual([1, 2])
  })
})

describe('frameViewSeq', () => {
  it('is the frame\'s own return seq, not the end of the whole trace', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'a' }),
      ev({ event: 'call', frame_id: 2, func: 'b', parent_frame_id: 1, call_line: 2 }),
      ev({ event: 'return', frame_id: 2, func: 'b', parent_frame_id: 1, call_line: 2, return_value: 'None' }), // seq 2
      ev({ event: 'return', frame_id: 1, func: 'a', return_value: 'None' }), // seq 3
    ]
    const index = buildTraceIndex(events)
    expect(frameViewSeq(index, 2)).toBe(2)
    expect(frameViewSeq(index, 1)).toBe(3)
  })

  it('falls back to the trace\'s maxSeq for a frame that never returns (e.g. the global scope)', () => {
    resetSeq()
    const events = [
      ev({ event: 'line', frame_id: 0, func: '<module>', locals: { X: local('1', null, 'global') } }),
      ev({ event: 'call', frame_id: 1, func: 'main' }),
      ev({ event: 'return', frame_id: 1, func: 'main', return_value: 'None' }), // seq 2
    ]
    const index = buildTraceIndex(events)
    expect(frameViewSeq(index, 0)).toBe(2)
  })
})

describe('getOccurrences', () => {
  it('returns every invocation from one call site, in call order — recursion and loops alike', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'run' }),
      ev({ event: 'call', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5 }),
      ev({ event: 'return', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '0' }),
      ev({ event: 'call', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5 }),
      ev({ event: 'return', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '1' }),
      ev({ event: 'return', frame_id: 1, func: 'run', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    expect(getOccurrences(index, 1, 5)).toEqual([2, 3])
    expect(getOccurrences(index, 1, 999)).toEqual([])
  })
})

describe('frameLineSeq — loop-body lines with more than one pass', () => {
  function loopBodyFixture() {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'sum_all' }), // seq 0, line 1 (default)
      ev({ event: 'line', frame_id: 1, func: 'sum_all', line: 4, locals: { total: local('0', null, 'body') } }), // seq 1
      ev({ event: 'line', frame_id: 1, func: 'sum_all', line: 4, locals: { total: local('1', null, 'body') } }), // seq 2 — exits pass 1 of line 4
      ev({ event: 'line', frame_id: 1, func: 'sum_all', line: 4, locals: { total: local('3', null, 'body') } }), // seq 3 — exits pass 2
      ev({ event: 'return', frame_id: 1, func: 'sum_all', return_value: '3' }), // seq 4 — exits pass 3
    ]
    return buildTraceIndex(events)
  }

  it('with no cursor, defaults to the last pass (unchanged behavior for a line visited once)', () => {
    const index = loopBodyFixture()
    expect(frameLineSeq(index, 1, 4)).toBe(4)
  })

  it('with a cursor, resolves to the pass nearest-after it — not always the last', () => {
    const index = loopBodyFixture()
    expect(frameLineSeq(index, 1, 4, 0)).toBe(2) // before any pass: the first pass
    expect(frameLineSeq(index, 1, 4, 2.5)).toBe(3) // between pass 1 (seq 2) and pass 2 (seq 3): pass 2
    expect(frameLineSeq(index, 1, 4, 3.5)).toBe(4) // between pass 2 and pass 3: pass 3
    expect(frameLineSeq(index, 1, 4, 10)).toBe(4) // past every pass: clamped to the last
  })
})

describe('nearestOccurrenceIndex', () => {
  function loopFixture() {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'run' }),
      ev({ event: 'call', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5 }), // seq 1
      ev({ event: 'return', frame_id: 2, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '0' }), // seq 2
      ev({ event: 'call', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5 }), // seq 3
      ev({ event: 'return', frame_id: 3, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '1' }), // seq 4
      ev({ event: 'call', frame_id: 4, func: 'noop', parent_frame_id: 1, call_line: 5 }), // seq 5
      ev({ event: 'return', frame_id: 4, func: 'noop', parent_frame_id: 1, call_line: 5, return_value: '2' }), // seq 6
      ev({ event: 'return', frame_id: 1, func: 'run', return_value: 'None' }),
    ]
    return buildTraceIndex(events)
  }

  it('with no cursor, picks the first occurrence', () => {
    const index = loopFixture()
    expect(nearestOccurrenceIndex(index, getOccurrences(index, 1, 5), null)).toBe(0)
  })

  it('with a cursor mid-loop, picks the next occurrence to start from that point — not the first', () => {
    const index = loopFixture()
    const occurrences = getOccurrences(index, 1, 5) // [2, 3, 4]
    expect(nearestOccurrenceIndex(index, occurrences, 2)).toBe(1) // right after call 1 (frame 2) returned
    expect(nearestOccurrenceIndex(index, occurrences, 4)).toBe(2) // right after call 2 (frame 3) returned
  })

  it('with a cursor past every occurrence, clamps to the last', () => {
    const index = loopFixture()
    const occurrences = getOccurrences(index, 1, 5)
    expect(nearestOccurrenceIndex(index, occurrences, 999)).toBe(2)
  })
})

describe('getLiveAliases', () => {
  it('shows a shared mutable object as live in both frames while the callee is still on the stack', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'collect', locals: { bonus_list: local('[]', 500, 'param') } }),
      ev({
        event: 'call',
        frame_id: 2,
        func: 'add_bonus',
        parent_frame_id: 1,
        call_line: 2,
        locals: { bonus_list: local('[]', 500, 'param'), amount: local('50', null, 'param') },
      }),
      ev({
        event: 'return',
        frame_id: 2,
        func: 'add_bonus',
        parent_frame_id: 1,
        call_line: 2,
        locals: { bonus_list: local('[50]', 500, 'param') },
        return_value: 'None',
      }), // seq 2
      ev({ event: 'line', frame_id: 1, func: 'collect', locals: { bonus_list: local('[50]', 500, 'param') } }), // seq 3
      ev({ event: 'return', frame_id: 1, func: 'collect', return_value: '[50]' }), // seq 4
    ]
    const index = buildTraceIndex(events)

    expect(getLiveAliases(index, 500, 1)).toEqual(
      expect.arrayContaining([
        { frameId: 1, name: 'bonus_list' },
        { frameId: 2, name: 'bonus_list' },
      ]),
    )
    expect(getLiveAliases(index, 500, 1)).toHaveLength(2)

    // add_bonus returned at seq 2 — its binding is gone, even though collect's isn't.
    expect(getLiveAliases(index, 500, 2)).toEqual([{ frameId: 1, name: 'bonus_list' }])

    // collect itself returns at seq 4 — nothing live any more.
    expect(getLiveAliases(index, 500, 4)).toEqual([])
  })

  it('an immutable value never appears in the alias index', () => {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'f', locals: { amount: local('500.0', null, 'param') } }),
      ev({ event: 'return', frame_id: 1, func: 'f', return_value: 'None' }),
    ]
    const index = buildTraceIndex(events)
    expect(index.aliasChanges.size).toBe(0)
  })
})

describe('getOtherLiveAliases — viewing a frame at its own frameViewSeq', () => {
  // Same shape as the collect_bonus/add_bonus fixture above. A frame's own return-
  // triggered unbind fires at the exact seq frameViewSeq uses to view that frame's own
  // state, so a naive getLiveAliases(objectId, frameViewSeq(self)) always finds `self`
  // already removed. This is the bug that fix guards against.
  function mutationFixture() {
    resetSeq()
    const events = [
      ev({ event: 'call', frame_id: 1, func: 'collect', locals: { bonus_list: local('[]', 500, 'param') } }),
      ev({
        event: 'call',
        frame_id: 2,
        func: 'add_bonus',
        parent_frame_id: 1,
        call_line: 2,
        locals: { bonus_list: local('[]', 500, 'param'), amount: local('50', null, 'param') },
      }),
      ev({
        event: 'return',
        frame_id: 2,
        func: 'add_bonus',
        parent_frame_id: 1,
        call_line: 2,
        locals: { bonus_list: local('[50]', 500, 'param') },
        return_value: 'None',
      }), // seq 2
      ev({ event: 'line', frame_id: 1, func: 'collect', locals: { bonus_list: local('[50]', 500, 'param') } }), // seq 3
      ev({ event: 'return', frame_id: 1, func: 'collect', return_value: '[50]' }), // seq 4
    ]
    return buildTraceIndex(events)
  }

  it('viewing add_bonus (the callee) at its own end still shows collect as an other sharer', () => {
    const index = mutationFixture()
    const atSeq = frameViewSeq(index, 2)
    expect(atSeq).toBe(2)
    expect(getOtherLiveAliases(index, 500, atSeq, 2, 'bonus_list')).toEqual([{ frameId: 1, name: 'bonus_list' }])
  })

  it('viewing collect (the caller) at its own end shows no others, since add_bonus already finished', () => {
    const index = mutationFixture()
    const atSeq = frameViewSeq(index, 1)
    expect(atSeq).toBe(4)
    expect(getOtherLiveAliases(index, 500, atSeq, 1, 'bonus_list')).toEqual([])
  })
})
