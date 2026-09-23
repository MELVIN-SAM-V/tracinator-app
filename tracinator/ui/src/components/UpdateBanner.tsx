import { useState } from 'react'
import { Download } from 'lucide-react'
import type { Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

interface Props {
  update: Update
}

type InstallState = 'idle' | 'installing' | 'error'

// Prompt-before-install, not silent — never surprise the user mid-session.
// This has no dismiss button; App.tsx only renders it once per launch after
// check() finds something, so "do nothing" already means "not now" without
// needing a separate control.
export default function UpdateBanner({ update }: Props) {
  const [state, setState] = useState<InstallState>('idle')

  const install = async () => {
    setState('installing')
    try {
      await update.downloadAndInstall()
      await relaunch()
    } catch {
      setState('error')
    }
  }

  return (
    <div className="shrink-0 flex items-center justify-center gap-3 bg-emerald-950/60 border-b border-emerald-800/50 px-3 py-1.5 text-xs">
      <Download size={12} className="text-emerald-400" />
      <span className="text-emerald-200">
        {state === 'error'
          ? "Couldn't install the update — check your connection and try again."
          : `Tracinator ${update.version} is available.`}
      </span>
      <button
        onClick={install}
        disabled={state === 'installing'}
        className="text-emerald-300 hover:text-white font-medium underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
      >
        {state === 'installing' ? 'Installing…' : 'Restart to update'}
      </button>
    </div>
  )
}
