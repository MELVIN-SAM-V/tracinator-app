import { describe, expect, it } from 'vitest'
import { basename } from './shared'

describe('basename', () => {
  it('strips a POSIX directory', () => {
    expect(basename('/home/user/project/app.py')).toBe('app.py')
  })

  it('strips a Windows directory', () => {
    expect(basename('C:\\Users\\Melvin\\AppData\\Local\\Temp\\tmpgxf_q4ag.py')).toBe('tmpgxf_q4ag.py')
  })

  it('handles mixed separators', () => {
    expect(basename('C:\\Users\\me/project/app.py')).toBe('app.py')
  })

  it('returns a bare file name unchanged', () => {
    expect(basename('app.py')).toBe('app.py')
  })
})
