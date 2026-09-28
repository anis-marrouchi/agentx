import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_LABEL, LAUNCHD_PATH, adoptLoginItem, desktopPath, isVoiceLoginItemFile, desktopPlatformError, desktopPlist, findOnPath, plistPathEnv, selectDesktopAgent, shellQuote, resolveHelper, packageRoot, installedHelper } from '../src/desktop/install'

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
    const plist = desktopPlist({ executable: '/tmp/AgentX Desktop.app/bin', cwd: "/tmp/a&b'c", agent: 'coder', url: 'http://127.0.0.1:18800', helper: '/tmp/helper', cli: '/tmp/cli.js', node: '/tmp/node', log: '/tmp/log', path: '/opt/x:/usr/bin' })
    expect(plist).toContain('<key>AGENTX_VOICE_AGENT</key><string>coder</string>')
    const unpinned = desktopPlist({ executable: '/a', cwd: '/b', url: 'http://x', helper: '/h', cli: '/c', node: '/n', log: '/l', path: '/usr/bin' })
    expect(unpinned).not.toContain('AGENTX_VOICE_AGENT')
    expect(plist).toContain('a&amp;b&apos;c')
    expect(plist).toContain('<key>AGENTX_MAC_HELPER</key>')
    if (process.platform === 'darwin') expect(execFileSync('plutil', ['-lint', '-'], { input: plist, encoding: 'utf8' })).toContain('OK')
  })
  it('gives the login item a PATH that reaches the ffmpeg found at install time', () => {
    expect(desktopPath('/opt/homebrew/bin/ffmpeg')).toBe(`/opt/homebrew/bin:${LAUNCHD_PATH}`)
    expect(desktopPath('/usr/bin/ffmpeg')).toBe(LAUNCHD_PATH)
    expect(desktopPath(null)).toBe(LAUNCHD_PATH)
    expect(desktopPath('/opt/homebrew/bin/ffmpeg', '/custom/bin')).toBe('/custom/bin')
    const plist = desktopPlist({ executable: '/a', cwd: '/b', agent: 'coder', url: 'http://x', helper: '/h', cli: '/c', node: '/n', log: '/l', path: desktopPath('/o&p/bin/ffmpeg') })
    expect(plistPathEnv(plist)).toBe(`/o&p/bin:${LAUNCHD_PATH}`)
  })
  it("reads the PATH a login item gets, defaulting to launchd's", () => {
    expect(plistPathEnv('<dict><key>Label</key><string>x</string></dict>')).toBe(LAUNCHD_PATH)
    expect(plistPathEnv('<key>PATH</key>\n  <string>/opt/homebrew/bin:/usr/bin</string>')).toBe('/opt/homebrew/bin:/usr/bin')
    const exe = (f: string) => f === '/opt/homebrew/bin/ffmpeg'
    expect(findOnPath('ffmpeg', LAUNCHD_PATH, exe)).toBeNull()
    expect(findOnPath('ffmpeg', `/opt/homebrew/bin:${LAUNCHD_PATH}`, exe)).toBe('/opt/homebrew/bin/ffmpeg')
  })
  it('adopts an older voice login item and retires the duplicates', () => {
    const item = (label: string, exe: string) => desktopPlist({ label, executable: exe, cwd: '/b', url: 'http://x', helper: '/h', cli: '/c', node: '/n', log: '/l', path: '/usr/bin' })
    const desktop = '/Users/me/Applications/AgentX Desktop.app/Contents/MacOS/AgentXVoice'
    const script = '/Applications/AgentX Voice.app/Contents/MacOS/AgentXVoice'
    const dir = '/Users/me/Library/LaunchAgents'
    // install.sh writes an indented plist; the adopted label is written back as-is.
    const old = `<dict>\n  <key>Label</key><string>tn.example.agentx.voice</string>\n  <key>ProgramArguments</key>\n  <array><string>${script}</string></array>\n</dict>`
    const { keep, remove } = adoptLoginItem(dir, [
      { file: `${dir}/tn.example.agentx.voice.plist`, plist: old },
      { file: `${dir}/tn.acme.agentx.voice.plist`, plist: item(DESKTOP_LABEL, desktop) },
      { file: `${dir}/x.agentx.voice.other.plist`, plist: item('x.agentx.voice.other', '/usr/bin/true') },
    ])
    expect(keep).toEqual({ file: `${dir}/tn.acme.agentx.voice.plist`, label: DESKTOP_LABEL })
    expect(remove).toEqual([{ file: `${dir}/tn.example.agentx.voice.plist`, label: 'tn.example.agentx.voice' }])
    const only = adoptLoginItem(dir, [{ file: `${dir}/tn.example.agentx.voice.plist`, plist: old }])
    expect(only).toEqual({ keep: { file: `${dir}/tn.example.agentx.voice.plist`, label: 'tn.example.agentx.voice' }, remove: [] })
    expect(item(only.keep.label, desktop)).toContain('<key>Label</key><string>tn.example.agentx.voice</string>')
    expect(adoptLoginItem(dir, [])).toEqual({ keep: { file: `${dir}/${DESKTOP_LABEL}.plist`, label: DESKTOP_LABEL }, remove: [] })
    expect(['tn.example.agentx.voice.plist', 'tn.acme.agentx.voice.plist.disabled-20260928', 'tn.example.agentx.voice.plist.bak-1', 'other.plist'].filter(isVoiceLoginItemFile)).toEqual(['tn.example.agentx.voice.plist'])
  })
  it('honors an explicit helper path', () => {
    expect(resolveHelper('/tmp/repo', '/tmp/home', '/custom/helper')).toBe('/custom/helper')
  })
  it('finds a package-built helper from any working folder, not only the checkout', () => {
    const repo = resolve(fileURLToPath(import.meta.url), '../..')
    const before = process.cwd()
    try {
      process.chdir(tmpdir())
      const root = packageRoot()
      expect(root).toBe(repo)
      expect(resolveHelper(root, '/nonexistent-home')).toBe(join(root!, 'apps/mac-helper/build/AgentX Helper.app/Contents/MacOS/agentx-mac-helper'))
    } finally { process.chdir(before) }
  })
  it('falls back to the ~/Applications path when there is no package folder', () => {
    expect(packageRoot('/')).toBeNull()
    expect(resolveHelper(null, '/tmp/home')).toBe(installedHelper('/tmp/home'))
  })
})
