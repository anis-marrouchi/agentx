import { describe, expect, it } from 'vitest'
import { appVersion, compareVersions, loginItemApp, restartsAfterQuit, voiceAppCandidates, voiceWarnings } from '../src/desktop/voice-checks'

const item = (app: string, keepAlive: string) => `<plist><dict><key>Label</key><string>tn.noqta.agentx.voice</string>
<key>ProgramArguments</key><array><string>${app}/Contents/MacOS/AgentXVoice</string></array>
<key>KeepAlive</key>${keepAlive}</dict></plist>`
const crashOnly = '<dict><key>SuccessfulExit</key><false/></dict>'
const info = (v: string) => `<dict><key>CFBundleShortVersionString</key><string>${v}</string></dict>`

describe('AgentX Voice checks (#2094, #2091)', () => {
  it('reads the app a login item starts', () => {
    expect(loginItemApp(item('/Applications/AgentX Voice.app', '<true/>'))).toBe('/Applications/AgentX Voice.app')
    expect(loginItemApp('<key>ProgramArguments</key><array><string>/usr/bin/true</string></array>')).toBeNull()
  })
  it('spots a login item that starts the app again after Quit', () => {
    expect(restartsAfterQuit(item('/A.app', '<true/>'))).toBe(true)
    expect(restartsAfterQuit(item('/A.app', crashOnly))).toBe(false)
  })
  it('compares versions by their numbers', () => {
    expect(compareVersions('0.1.0', '0.250.0')).toBeLessThan(0)
    expect(compareVersions('0.250.0', '0.250.0')).toBe(0)
    expect(compareVersions('0.251.0', '0.250.9')).toBeGreaterThan(0)
    expect(appVersion(info('0.250.0'))).toBe('0.250.0')
  })
  it('looks for copies under both names in both Applications folders', () => {
    expect(voiceAppCandidates('/Users/me')).toEqual([
      '/Users/me/Applications/AgentX Voice.app', '/Users/me/Applications/AgentX Desktop.app',
      '/Applications/AgentX Voice.app', '/Applications/AgentX Desktop.app',
    ])
  })
  it('warns about the owner\'s Mac: always-restart item, two copies, old build', () => {
    const app = '/Applications/AgentX Voice.app'
    const warnings = voiceWarnings({
      loginItems: [{ file: '/LA/tn.noqta.agentx.voice.plist', plist: item(app, '<true/>') }],
      copies: [app, '/Users/me/Applications/AgentX Desktop.app'],
      infoPlist: info('0.1.0'),
      cli: '0.250.0',
    })
    expect(warnings.map(w => w.title)).toEqual([
      'AgentX Voice starts again after every Quit',
      '2 copies of AgentX Voice are installed',
      'AgentX Voice 0.1.0 is older than the CLI 0.250.0',
    ])
    expect(warnings[1].detail).toContain(`The one that starts at login is ${app}.`)
    expect(warnings.every(w => w.fix.length > 0)).toBe(true)
  })
  it('says nothing for a current install', () => {
    const app = '/Users/me/Applications/AgentX Voice.app'
    expect(voiceWarnings({
      loginItems: [{ file: '/LA/x.plist', plist: item(app, crashOnly) }], copies: [app], infoPlist: info('0.250.0'), cli: '0.250.0',
    })).toEqual([])
  })
})
