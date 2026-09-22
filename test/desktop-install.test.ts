import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { desktopPlatformError, desktopPlist, selectDesktopAgent, shellQuote, resolveHelper } from '../src/desktop/install'

describe('desktop installation', () => {
  it('rejects unsupported systems and supports macOS 14 on Apple Silicon', () => {
    expect(desktopPlatformError('linux', 'arm64', '6.8')).toBeTruthy()
    expect(desktopPlatformError('darwin', 'x64', '24.1')).toBeTruthy()
    expect(desktopPlatformError('darwin', 'arm64', '22.6')).toBeTruthy()
    expect(desktopPlatformError('darwin', 'arm64', '23.0')).toBeNull()
  })
  it('selects an existing agent and refuses missing agents', () => {
    expect(selectDesktopAgent({ coder: {} })).toBe('coder')
    expect(selectDesktopAgent({ coder: {}, writer: {} }, 'writer')).toBe('writer')
    expect(() => selectDesktopAgent({}, undefined)).toThrow('No agents')
    expect(() => selectDesktopAgent({ coder: {} }, 'wrong')).toThrow('Unknown agent')
  })
  it('quotes shell paths without expanding substitutions', () => {
    const path = "/tmp/a b'$(printf injected)`printf bad`"
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(path)}`], { encoding: 'utf8' })).toBe(path)
  })
  it('persists the agent, daemon and paths in a valid plist', () => {
    const plist = desktopPlist({ executable: '/tmp/AgentX Desktop.app/bin', cwd: "/tmp/a&b'c", agent: 'coder', url: 'http://127.0.0.1:18800', helper: '/tmp/helper', cli: '/tmp/cli.js', node: '/tmp/node', log: '/tmp/log' })
    expect(plist).toContain('<key>AGENTX_VOICE_AGENT</key><string>coder</string>')
    expect(plist).toContain('a&amp;b&apos;c')
    expect(plist).toContain('<key>AGENTX_MAC_HELPER</key>')
    if (process.platform === 'darwin') expect(execFileSync('plutil', ['-lint', '-'], { input: plist, encoding: 'utf8' })).toContain('OK')
  })
  it('honors an explicit helper path', () => {
    expect(resolveHelper('/tmp/repo', '/tmp/home', '/custom/helper')).toBe('/custom/helper')
  })
})
