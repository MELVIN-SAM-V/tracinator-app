// Every request to the local backend's /api routes carries the per-launch
// token it was started with (see require_api_token in tracinator/server/app.py),
// so other web pages open in the browser can't drive it. The token never
// comes from the backend itself — a DNS-rebinding page could read anything
// the backend serves — but from one of:
//   - the desktop window, where the Rust shell injects it as
//     window.__TRACINATOR_API_TOKEN__ before this code runs;
//   - the ?token= in the link `tracinator ui` / dev_app.sh opens, which
//     captureTokenFromUrl() moves into sessionStorage.
// With no token (the public demo, whose backend has no such check) requests
// go out unchanged.

declare global {
  interface Window {
    __TRACINATOR_API_TOKEN__?: string
  }
}

export const API_TOKEN_HEADER = 'X-Tracinator-Token'
const SESSION_KEY = 'tracinator_api_token'

// Kept in memory too, for when sessionStorage throws (blocked site data).
let capturedToken: string | null = null

// Call once at startup, before the first request. Removes the token from the
// address bar so it doesn't end up in bookmarks, history or screenshots.
export function captureTokenFromUrl(): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const token = url.searchParams.get('token')
  if (!token) return
  capturedToken = token
  try {
    window.sessionStorage.setItem(SESSION_KEY, token)
  } catch {
    // capturedToken still covers this page load.
  }
  url.searchParams.delete('token')
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
}

export function apiToken(): string | null {
  if (typeof window === 'undefined') return null
  if (window.__TRACINATOR_API_TOKEN__) return window.__TRACINATOR_API_TOKEN__
  if (capturedToken) return capturedToken
  try {
    return window.sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = apiToken()
  if (!token) return fetch(input, init)
  const headers = new Headers(init.headers)
  headers.set(API_TOKEN_HEADER, token)
  return fetch(input, { ...init, headers })
}

// Only for tests: module state otherwise persists across cases.
export function resetCapturedTokenForTests(): void {
  capturedToken = null
}
