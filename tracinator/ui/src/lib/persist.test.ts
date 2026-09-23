import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// No jsdom in this project's test setup (other lib tests are pure-logic, no
// DOM needed) — fake just enough of `window`/`localStorage` for persist.ts.
function fakeLocalStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    clear: () => data.clear(),
  }
}

const storeData = new Map<string, unknown>()
const fakeStore = {
  get: vi.fn(async (key: string) => storeData.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    storeData.set(key, value)
  }),
  save: vi.fn(async () => {}),
}

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: vi.fn(async () => fakeStore) },
}))

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).window = globalThis
  ;(globalThis as Record<string, unknown>).localStorage = fakeLocalStorage()
})

afterEach(() => {
  storeData.clear()
  vi.clearAllMocks()
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).localStorage
  vi.resetModules()
})

describe('outside Tauri', () => {
  it('falls back to localStorage', async () => {
    const { getFlag, setFlag } = await import('./persist')
    expect(await getFlag('tour-seen')).toBeNull()
    await setFlag('tour-seen', 'true')
    expect(localStorage.getItem('tour-seen')).toBe('true')
    expect(await getFlag('tour-seen')).toBe('true')
  })
})

describe('inside Tauri', () => {
  it('reads and writes through the plugin store instead of localStorage', async () => {
    window.isTauri = true
    const { getFlag, setFlag } = await import('./persist')
    expect(await getFlag('tour-seen')).toBeNull()
    await setFlag('tour-seen', 'true')
    expect(fakeStore.set).toHaveBeenCalledWith('tour-seen', 'true')
    expect(fakeStore.save).toHaveBeenCalled()
    expect(localStorage.getItem('tour-seen')).toBeNull()
    expect(await getFlag('tour-seen')).toBe('true')
  })
})
