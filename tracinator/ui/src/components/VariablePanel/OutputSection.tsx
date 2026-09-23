import type { CapturedValue } from '../../types/trace'
import ValueView from './ValueView'

interface Props {
  returnValue: CapturedValue | null
}

// Shows the currently-viewed frame's own return value — most useful when the
// return statement is an expression (`return a * b + 1`) rather than a bare
// variable, so the actual result doesn't have to be worked out by eye.
export default function OutputSection({ returnValue }: Props) {
  return (
    <div className="border-b border-gray-800">
      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-900/40">
        Output
      </div>
      {returnValue === null ? (
        <div className="px-3 py-2 text-gray-600 text-xs italic">—</div>
      ) : (
        <div className="px-1 py-1">
          <div className="flex items-start px-2 py-1 rounded hover:bg-gray-800/60">
            <div className="flex-1 min-w-0">
              <ValueView value={returnValue} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
