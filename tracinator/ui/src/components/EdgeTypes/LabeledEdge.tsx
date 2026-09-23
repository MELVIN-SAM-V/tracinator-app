import React from 'react'
import { EdgeProps, BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'

interface EdgeData {
  edgeType: string
  label: string | null
  // Set only while a trace is active for the currently displayed function — lets the
  // branch edge trace actually followed settle into a still, solid line instead of
  // looking like just another moving branch, while the untaken one is left exactly
  // as it always looks. (A still solid line reads as "the confirmed path" — a moving
  // dashed one reads as "provisional" — so the taken edge, not the untaken one, is
  // the one that should stop moving.)
  isTraced?: boolean
  isTaken?: boolean
}

const edgeStyle: Record<string, { stroke: string; strokeDasharray?: string; animated?: boolean }> = {
  SEQUENTIAL: { stroke: '#64748b' },
  TRUE:       { stroke: '#22c55e' },
  FALSE:      { stroke: '#ef4444' },
  EXCEPTION:  { stroke: '#f97316', strokeDasharray: '6 4' },
  LOOP_BACK:  { stroke: '#a855f7', strokeDasharray: '6 4' },
  LOOP_EXIT:  { stroke: '#64748b' },
}

const defaultLabel: Record<string, string> = {
  TRUE: 'True',
  FALSE: 'False',
  LOOP_EXIT: 'exit',
}

export default function LabeledEdge({
  id,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const ed = data as unknown as EdgeData
  const et = ed?.edgeType ?? 'SEQUENTIAL'
  const style = edgeStyle[et] ?? edgeStyle.SEQUENTIAL
  const displayLabel = ed?.label ?? defaultLabel[et] ?? null
  const branchEdge = et !== 'SEQUENTIAL' && et !== 'LOOP_EXIT'
  const taken = branchEdge && !!ed?.isTraced && !!ed?.isTaken
  // The untaken branch (or either branch when nothing is traced) keeps the default
  // moving look; the one trace actually took settles into a still, solid line.
  const animated = branchEdge && !taken

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    curvature: et === 'LOOP_BACK' ? 0.8 : 0.25,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: style.stroke,
          strokeWidth: 1.5,
          strokeDasharray: style.strokeDasharray,
        }}
        className={animated ? 'edge-animated' : ''}
      />
      {displayLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan"
          >
            <span
              style={{ color: style.stroke }}
              className="text-[9px] font-mono font-semibold bg-[#0f1117] px-1 py-0.5 rounded"
            >
              {displayLabel}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
