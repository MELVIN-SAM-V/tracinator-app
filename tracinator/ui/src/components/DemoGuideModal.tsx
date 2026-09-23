import React from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Bug, Code2, Eraser, FolderOpen, Image, Play, RefreshCw, X, type LucideIcon } from 'lucide-react'

interface Props {
  onClose: () => void
}

// Public demo build (VITE_DEMO_MODE=true) has no Local File tab and no real
// filesystem to browse — see App.tsx's own DEMO_MODE constant, duplicated
// here (existing convention — TraceArgsForm/AppRouter each read this
// directly too) so this modal can read differently for the two builds
// without threading a prop through App.tsx just for that.
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true'

// The in-app walkthrough. Originally the demo build's guide only (same
// content as the published "Tracinator Demo Guide" artifact) — un-gated for
// the real desktop/local-file build too, with the code-entry steps and the
// closing note adapted per build so it doesn't describe a Local File tab
// that isn't there (demo) or claim Local File browsing "isn't in this demo"
// when it's the real app (everything else — Trace/Run trace/Export
// PNG/Refresh — works identically in both, so those steps are unchanged).
export default function DemoGuideModal({ onClose }: Props) {
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-[560px] max-w-full max-h-[85vh] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h2 className="text-sm font-semibold text-gray-100">
            {DEMO_MODE ? 'Running the demo' : 'How Tracinator works'}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-5 text-sm">
          <ol className="flex flex-col gap-4">
            {DEMO_MODE ? (
              <>
                <Step n={1} title="Write or paste code">
                  The Editor on the left is Python. The graph on the right regenerates about
                  0.7s after you stop typing.
                </Step>
                <Step n={2} title="Pick a function">
                  The dropdown under the editor lists every function found in the code. Pick
                  one to draw its flowchart.
                </Step>
              </>
            ) : (
              <>
                <Step n={1} title={<>Write code, or browse to a file</>}>
                  <IconChip icon={Code2} label="Editor" /> works like the demo — paste Python
                  and the graph regenerates about 0.7s after you stop typing.{' '}
                  <IconChip icon={FolderOpen} label="Local File" /> instead browses your own
                  project on disk.
                </Step>
                <Step n={2} title="Pick a function">
                  In <IconChip icon={Code2} label="Editor" />, the dropdown under the editor
                  lists every function found in the code. In{' '}
                  <IconChip icon={FolderOpen} label="Local File" />, pick a file, then click a
                  function in its list. Either way, picking one draws its flowchart.
                </Step>
              </>
            )}
            <Step n={3} title={<><IconChip icon={Bug} label="Trace" /> to run it for real</>}>
              Opens a form asking for the function's actual argument values.
            </Step>
            <Step n={4} title={<><IconChip icon={Play} label="Run trace" /> after filling in values</>}>
              The graph highlights the path execution took, and the panel on the right
              fills in with real argument, return, and variable values at every step.
              <IconChip icon={Eraser} label="Clear" /> wipes the form back to empty.
            </Step>
            <Step n={5} title={<><IconChip icon={Image} label="Export PNG" /> to save</>}>
              Downloads the current graph as an image.
            </Step>
            <Step n={6} title={<><IconChip icon={RefreshCw} label="Refresh" /> to reset</>}>
              Re-renders the graph from the code currently in the editor, clearing the
              trace overlay back to a clean, untraced flowchart.
            </Step>
          </ol>

          <div className="border border-amber-700/60 bg-amber-950/40 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <AlertTriangle size={14} className="text-amber-400 shrink-0" />
              <h3 className="text-amber-200 font-semibold text-xs">The thing everyone types wrong first</h3>
            </div>
            <p className="text-amber-100/80 text-xs leading-relaxed mb-3">
              Argument fields aren't free text — they're spliced straight into a real
              Python call. A bare word isn't a string, it's a variable name.
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono mb-3">
              <div className="bg-gray-900/70 border border-amber-700/40 rounded px-2.5 py-2">
                <div className="text-gray-300">anage</div>
                <div className="text-amber-400 text-[11px] mt-1">✕ NameError — read as an unknown variable</div>
              </div>
              <div className="bg-gray-900/70 border border-emerald-700/40 rounded px-2.5 py-2">
                <div className="text-gray-300">'anage'</div>
                <div className="text-emerald-400 text-[11px] mt-1">✓ Parsed as the string "anage"</div>
              </div>
            </div>
            <ul className="text-amber-100/70 text-[11px] leading-relaxed list-disc list-inside space-y-0.5">
              <li>Numbers are typed plain — <code className="text-gray-200">42</code>, <code className="text-gray-200">3.14</code></li>
              <li><code className="text-gray-200">True</code> / <code className="text-gray-200">False</code> / <code className="text-gray-200">None</code> — capitalized, Python-style</li>
              <li>Dicts and lists work as normal Python literals — <code className="text-gray-200">{'{"a": 1}'}</code>, <code className="text-gray-200">[1, 2, 3]</code></li>
            </ul>
          </div>

          {DEMO_MODE && (
            <div className="flex items-start gap-3 border border-dashed border-gray-700 rounded-lg p-4">
              <FolderOpen size={16} className="text-gray-600 shrink-0 mt-0.5" />
              <p className="text-gray-500 text-xs leading-relaxed">
                <span className="text-gray-300 font-medium">Local File browsing isn't in this demo.</span> The
                desktop app adds a tab for browsing your own project folder — this sandboxed
                demo only has whatever's pasted into the editor.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Step({ n, title, children }: { n: number; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <div className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-300 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
        {n}
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-gray-200 font-medium flex flex-wrap items-center gap-1.5">{title}</div>
        <p className="text-gray-500 text-xs leading-relaxed">{children}</p>
      </div>
    </li>
  )
}

function IconChip({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-gray-300 text-xs font-semibold">
      <Icon size={11} />
      {label}
    </span>
  )
}
