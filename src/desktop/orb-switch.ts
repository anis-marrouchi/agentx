import { join } from 'node:path'

// `agentx desktop orb` (#2265): the Electron app with the orb takes the
// place of the Swift AgentX Voice widget on this Mac. Rules only; the
// command in src/commands/desktop.ts does the building and the moves.

/** The Electron app's bundle name (productName in apps/desktop/package.json). */
export const ORB_APP = 'AgentX.app'
/** Its bundle id (build.appId in apps/desktop/package.json). */
export const ORB_BUNDLE_ID = 'dev.agentx.desktop'
/** Every other place the same app may already be installed. Two copies would
 *  both run and both start at login, since they share one settings file. */
export function otherOrbApps(home: string, dest: string): string[] {
  return [join(home, 'Applications', ORB_APP), join('/Applications', ORB_APP)].filter(app => app !== dest)
}
/** Where another copy is moved aside to: no longer ending in .app, so macOS
 *  does not start it; renaming it back gives it back. `taken` says whether a
 *  name is used already (a second switch on the same day). */
export function retiredOrbApp(app: string, now: Date, taken: (path: string) => boolean): string {
  const base = retiredLoginItem(app, now)
  let name = base
  for (let i = 2; taken(name); i++) name = `${base}-${i}`
  return name
}
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
const RETIRED = /^(.+\.plist)\.disabled-orb-\d{8}$/
/** The original name of a login item `retiredLoginItem` moved, or null for
 *  any other file. `agentx desktop orb --undo` renames it back. */
export function restoredLoginItem(file: string): string | null {
  return RETIRED.exec(file)?.[1] ?? null
}
/** The app's settings after the undo: it no longer starts at login, and the
 *  orb stays hidden so the one launch that turns the login item off shows
 *  nothing. A new switch turns both back on. */
export function undoOrbSettings(existing: unknown): Record<string, unknown> {
  const kept = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {}
  return { ...kept, openAtLogin: false, orbVisible: false, showOnLaunch: false }
}
