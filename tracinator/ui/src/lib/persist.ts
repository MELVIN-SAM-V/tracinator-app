// Origin-scoped storage (localStorage) silently resets in the desktop build:
// the webview's port is chosen at launch (see docs/deployment.md Part 2), so
// "same app, different run" can mean "different origin" to the browser. This
// picks a storage backend that's stable across that: `localStorage` on the
// web/demo build, a JSON file under the OS app-data dir (via
// `@tauri-apps/plugin-store`) inside the packaged desktop app.
//
// Nothing consumes this yet — DEMO_MODE's onboarding tour still uses
// `localStorage` directly and is untouched by this file.

import type { Store } from '@tauri-apps/plugin-store'
import { inTauri } from './tauri'

const STORE_FILE = 'tracinator-settings.json'

let storePromise: Promise<Store> | null = null

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = import('@tauri-apps/plugin-store').then(({ Store }) => Store.load(STORE_FILE))
  }
  return storePromise
}

export async function getFlag(key: string): Promise<string | null> {
  if (!inTauri()) {
    return localStorage.getItem(key)
  }
  const store = await getStore()
  const value = await store.get<string>(key)
  return value ?? null
}

export async function setFlag(key: string, value: string): Promise<void> {
  if (!inTauri()) {
    localStorage.setItem(key, value)
    return
  }
  const store = await getStore()
  await store.set(key, value)
  await store.save() // autosave isn't guaranteed by default
}
