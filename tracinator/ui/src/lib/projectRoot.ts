// The desktop app's "Open folder" flow: pick a folder with the native
// dialog, point the backend at it (/api/project-root), and remember it so
// the next launch opens the same folder instead of the home directory.

import { getFlag, setFlag } from './persist'
import { apiFetch } from './api'

const PROJECT_ROOT_KEY = 'tracinator_project_root'

// Resolves to null when the user cancels the dialog.
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, multiple: false, defaultPath: defaultPath || undefined })
  return typeof picked === 'string' ? picked : null
}

// Returns the root as the server normalised it; throws with the server's
// message (e.g. "Folder not found: ...") when it refuses.
export async function setServerProjectRoot(path: string): Promise<string> {
  const resp = await apiFetch('/api/project-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not open that folder')
  }
  return data.root as string
}

export function rememberProjectRoot(root: string): Promise<void> {
  return setFlag(PROJECT_ROOT_KEY, root)
}

// Re-applies the last opened folder at launch. Returns the new root, or
// null when nothing was saved or the folder no longer exists (the server's
// default root then stays in place).
export async function restoreProjectRoot(): Promise<string | null> {
  const saved = await getFlag(PROJECT_ROOT_KEY)
  if (!saved) return null
  try {
    return await setServerProjectRoot(saved)
  } catch {
    return null
  }
}
