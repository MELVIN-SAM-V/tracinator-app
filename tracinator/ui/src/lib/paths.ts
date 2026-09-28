// Path helpers for the file browser. The server reports paths in the OS's
// own form, so on Windows they use backslashes and a drive letter
// (C:\Users\me\project) — splitting on '/' alone treated such a path as one
// segment, so the breadcrumb showed the whole path as a single crumb.

function separatorOf(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

// 'C:\' and '/' are roots; any other trailing separator is dropped so
// splitting doesn't produce an empty last segment.
function trimTrailingSeparator(path: string): string {
  if (path === '/' || /^[A-Za-z]:[\\/]$/.test(path)) return path
  return path.replace(/[\\/]+$/, '')
}

function segments(path: string): string[] {
  const trimmed = trimTrailingSeparator(path)
  if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return [trimmed.slice(0, 2)]
  if (trimmed === '/') return ['']
  return trimmed.split(/[\\/]/)
}

function join(parts: string[], sep: string): string {
  if (parts.length === 1 && parts[0] === '') return '/'
  if (parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) return parts[0] + sep
  return parts.join(sep)
}

export function joinPath(dir: string, name: string): string {
  const sep = separatorOf(dir)
  return trimTrailingSeparator(dir).replace(/[\\/]$/, '') + sep + name
}

export interface Crumb {
  label: string
  path: string
}

// Breadcrumbs from the root folder down to the current one — the root is
// the first crumb, so the user can't click above it.
export function buildCrumbs(currentPath: string, root: string): Crumb[] {
  const sep = separatorOf(root || currentPath)
  const rootParts = segments(root)
  const currentParts = segments(currentPath)
  const crumbs: Crumb[] = []

  for (let i = rootParts.length - 1; i < currentParts.length; i++) {
    const parts = currentParts.slice(0, i + 1)
    crumbs.push({
      label: currentParts[i] || '/',
      path: join(parts, sep),
    })
  }
  return crumbs
}
