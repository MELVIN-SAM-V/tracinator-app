import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TOKEN_HEADER, apiFetch, apiToken, captureTokenFromUrl, resetCapturedTokenForTests } from './api'

// No jsdom in this project's test setup — fake just enough of `window` for
// api.ts: location, history and sessionStorage.
function fakeWindow(href: string) {
  const data = new Map<string, string>()
  const win = {
    location: { href },
    history: {
      state: null,
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
        win.location.href = new URL(url, win.location.href).href
      }),
    },
    sessionStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value)
      },
    },
  } as unknown as Window & { location: { href: string } }
  return win
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Headers {
  const init = fetchMock.mock.calls[0][1] as RequestInit | undefined
  return new Headers(init?.headers)
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetCapturedTokenForTests()
  fetchMock = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('captureTokenFromUrl', () => {
  it('saves ?token= and removes it from the address bar', () => {
    const win = fakeWindow('http://localhost:7331/?token=abc123&x=1#frag')
    vi.stubGlobal('window', win)

    captureTokenFromUrl()

    expect(apiToken()).toBe('abc123')
    expect(win.sessionStorage.getItem('tracinator_api_token')).toBe('abc123')
    expect(win.location.href).toBe('http://localhost:7331/?x=1#frag')
  })

  it('leaves the URL alone when there is no token', () => {
    const win = fakeWindow('http://localhost:7331/')
    vi.stubGlobal('window', win)

    captureTokenFromUrl()

    expect(win.history.replaceState).not.toHaveBeenCalled()
    expect(apiToken()).toBeNull()
  })
})

describe('apiFetch', () => {
  it('sends the token header when a token is known', async () => {
    vi.stubGlobal('window', fakeWindow('http://localhost:7331/?token=abc123'))
    captureTokenFromUrl()

    await apiFetch('/api/config', { headers: { 'Content-Type': 'application/json' } })

    const headers = sentHeaders(fetchMock)
    expect(headers.get(API_TOKEN_HEADER)).toBe('abc123')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it("prefers the desktop window's injected token", async () => {
    const win = fakeWindow('http://127.0.0.1:7331/')
    win.__TRACINATOR_API_TOKEN__ = 'from-desktop'
    vi.stubGlobal('window', win)

    await apiFetch('/api/config')

    expect(sentHeaders(fetchMock).get(API_TOKEN_HEADER)).toBe('from-desktop')
  })

  it('sends no token header without a token (the public demo)', async () => {
    vi.stubGlobal('window', fakeWindow('https://tracinator.com/demo'))

    await apiFetch('/api/graph-from-source', { method: 'POST' })

    expect(sentHeaders(fetchMock).has(API_TOKEN_HEADER)).toBe(false)
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'POST' })
  })
})
