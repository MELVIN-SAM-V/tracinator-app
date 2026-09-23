// Shared runtime detection for the desktop build. `window.isTauri` was added
// in Tauri 2.0 specifically for this — present regardless of the
// `withGlobalTauri` config flag — so every desktop-only code path (storage
// backend, window chrome) can gate on the same check.

declare global {
  interface Window {
    isTauri?: boolean
  }
}

export function inTauri(): boolean {
  return typeof window !== 'undefined' && window.isTauri === true
}

let windowModulePromise: Promise<typeof import('@tauri-apps/api/window')> | null = null

// Cached dynamic import: keeps the web/demo build from ever needing
// @tauri-apps/api on its critical path, and avoids re-resolving the module
// on every window-control click.
export function tauriWindowModule() {
  if (!windowModulePromise) {
    windowModulePromise = import('@tauri-apps/api/window')
  }
  return windowModulePromise
}
