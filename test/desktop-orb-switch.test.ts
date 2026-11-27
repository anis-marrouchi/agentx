import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isVoiceLoginItemFile } from '../src/desktop/install'
import { ORB_APP, ORB_BUILD_ARGS, builtOrbApp, orbSettings, orbSettingsFile, retiredLoginItem } from '../src/desktop/orb-switch'

const desktopPkg = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), '../apps/desktop/package.json'), 'utf8'))

describe('agentx desktop orb (#2265)', () => {
  it('names the app and its settings folder after the desktop app productName', () => {
    expect(ORB_APP).toBe(`${desktopPkg.productName}.app`)
    expect(orbSettingsFile('/Users/a')).toBe(`/Users/a/Library/Application Support/${desktopPkg.productName}/settings.json`)
  })
  it('builds an unpacked arm64 app and finds it where electron-builder leaves it', () => {
    expect(ORB_BUILD_ARGS).toEqual(['electron-builder', '--mac', 'dir', '--arm64', '--publish', 'never'])
    expect(desktopPkg.build.directories.output).toBe('release')
    expect(builtOrbApp('/tmp/s')).toBe(join('/tmp/s', 'release', 'mac-arm64', ORB_APP))
  })
  it('turns on login start and the orb, no window, and keeps the other choices', () => {
    expect(orbSettings({ orbAgent: 'cx', globalKey: true, openAtLogin: false, orbVisible: false, showOnLaunch: true }))
      .toEqual({ orbAgent: 'cx', globalKey: true, openAtLogin: true, orbVisible: true, showOnLaunch: false })
    expect(orbSettings(null)).toEqual({ openAtLogin: true, orbVisible: true, showOnLaunch: false })
    expect(orbSettings(['x'])).toEqual({ openAtLogin: true, orbVisible: true, showOnLaunch: false })
  })
  it('moves a widget login item to a name launchd and desktop install both skip', () => {
    const file = '/Users/a/Library/LaunchAgents/tn.noqta.agentx.voice.plist'
    const moved = retiredLoginItem(file, new Date('2026-11-27T23:00:00Z'))
    expect(moved).toBe(`${file}.disabled-orb-20261127`)
    expect(moved.endsWith('.plist')).toBe(false)
    expect(isVoiceLoginItemFile('tn.noqta.agentx.voice.plist.disabled-orb-20261127')).toBe(false)
  })
})
