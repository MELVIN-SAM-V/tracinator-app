import { describe, expect, it } from 'vitest'
import { buildCrumbs, joinPath } from './paths'

describe('buildCrumbs', () => {
  it('starts at the root folder on POSIX', () => {
    expect(buildCrumbs('/home/me/proj/pkg', '/home/me/proj')).toEqual([
      { label: 'proj', path: '/home/me/proj' },
      { label: 'pkg', path: '/home/me/proj/pkg' },
    ])
  })

  it('splits Windows paths into separate crumbs', () => {
    expect(buildCrumbs('C:\\Users\\me\\proj\\pkg', 'C:\\Users\\me\\proj')).toEqual([
      { label: 'proj', path: 'C:\\Users\\me\\proj' },
      { label: 'pkg', path: 'C:\\Users\\me\\proj\\pkg' },
    ])
  })

  it('handles a drive root as the root folder', () => {
    expect(buildCrumbs('C:\\proj', 'C:\\')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'proj', path: 'C:\\proj' },
    ])
  })

  it('handles / as the root folder', () => {
    expect(buildCrumbs('/tmp', '/')).toEqual([
      { label: '/', path: '/' },
      { label: 'tmp', path: '/tmp' },
    ])
  })

  it('shows a single crumb at the root itself', () => {
    expect(buildCrumbs('C:\\Users\\me', 'C:\\Users\\me')).toEqual([
      { label: 'me', path: 'C:\\Users\\me' },
    ])
  })
})

describe('joinPath', () => {
  it('uses the directory\'s own separator', () => {
    expect(joinPath('/home/me', 'a.py')).toBe('/home/me/a.py')
    expect(joinPath('C:\\Users\\me', 'a.py')).toBe('C:\\Users\\me\\a.py')
  })

  it('does not double the separator at a drive or filesystem root', () => {
    expect(joinPath('C:\\', 'proj')).toBe('C:\\proj')
    expect(joinPath('/', 'tmp')).toBe('/tmp')
  })
})
