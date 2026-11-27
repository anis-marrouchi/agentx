import { join } from 'node:path'

// `agentx desktop orb` (#2265): the Electron app with the orb takes the
// place of the Swift AgentX Voice widget on this Mac. Rules only; the
// command in src/commands/desktop.ts does the building and the moves.

/** The Electron app's bundle name (productName in apps/desktop/package.json). */
export const ORB_APP = 'AgentX.app'
/** Its settings file: Electron's userData folder is named after productName. */
export function orbSettingsFile(home: string): string {
  return join(home, 'Library/Application Support/AgentX/settings.json')
}
/** electron-builder arguments: an unpacked arm64 app, no dmg, nothing published. */
export const ORB_BUILD_ARGS = ['electron-builder', '--mac', 'dir', '--arm64', '--publish', 'never']
/** Where electron-builder leaves that app inside the staged apps/desktop. */
export function builtOrbApp(stage: string): string {
  return join(stage, 'release', 'mac-arm64', ORB_APP)
}
/** The app's settings after the switch: it starts at login with the orb
 *  shown and no window; every other choice the owner made is kept. */
export function orbSettings(existing: unknown): Record<string, unknown> {
  const kept = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {}
  return { ...kept, openAtLogin: true, orbVisible: true, showOnLaunch: false }
}
/** The name a retired widget login item is moved to. It no longer ends in
 *  .plist, so launchd skips it at login and `agentx desktop install` does
 *  not adopt it; renaming it back undoes the switch. */
export function retiredLoginItem(file: string, now: Date): string {
  return `${file}.disabled-orb-${now.toISOString().slice(0, 10).replace(/-/g, '')}`
}
