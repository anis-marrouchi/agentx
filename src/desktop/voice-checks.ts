import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** What `agentx desktop status`, `agentx desktop install` and `agentx
 *  doctor` warn about on a Mac with AgentX Voice (#2094, #2091). */
export type VoiceWarning = { title: string; detail: string; fix: string }

const INSTALL = 'Run agentx desktop install.'

/** The app a login item starts, as its .app folder, or null. */
export function loginItemApp(plist: string): string | null {
  const program = plist.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1]
  if (!program?.endsWith('/Contents/MacOS/AgentXVoice')) return null
  return dirname(dirname(dirname(program.replace(/&amp;/g, '&'))))
}

/** A plain `KeepAlive = true` makes launchd start the app again after
 *  every Quit. Current installs restart it only after a crash. */
export function restartsAfterQuit(plist: string): boolean {
  return /<key>KeepAlive<\/key>\s*<true\s*\/>/.test(plist)
}

/** The version the build stamped into the app's Info.plist, or null. */
export function appVersion(infoPlist: string): string | null {
  return infoPlist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? null
}

/** Negative when a is older than b. Compares the numeric parts only. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** Folders where an AgentX Voice copy may be installed, old names included. */
export function voiceAppCandidates(home: string): string[] {
  const names = ['AgentX Voice.app', 'AgentX Desktop.app']
  return [join(home, 'Applications'), '/Applications'].flatMap(dir => names.map(name => join(dir, name)))
}

/** Warnings for one Mac. `loginItems` are the voice login item plists (XML),
 *  `copies` the installed .app folders, `infoPlist` the Info.plist of the
 *  copy the login item starts, `cli` this CLI's version. */
export function voiceWarnings(opts: { loginItems: { file: string; plist: string }[]; copies: string[]; infoPlist: string | null; cli: string }): VoiceWarning[] {
  const warnings: VoiceWarning[] = []
  for (const { file, plist } of opts.loginItems) {
    if (restartsAfterQuit(plist)) warnings.push({
      title: 'AgentX Voice starts again after every Quit',
      detail: `${file} keeps it alive even after a clean Quit (KeepAlive = true). It was made by an older install.`,
      fix: `${INSTALL} It rewrites the login item so Quit leaves the app closed.`,
    })
  }
  const starts = opts.loginItems.map(i => loginItemApp(i.plist)).find(Boolean) ?? null
  if (opts.copies.length > 1) warnings.push({
    title: `${opts.copies.length} copies of AgentX Voice are installed`,
    detail: `${opts.copies.join(', ')}. ${starts ? `The one that starts at login is ${starts}.` : 'None of them starts at login.'}`,
    fix: `Keep the one that starts at login and move the others to the Bin.${starts ? '' : ` ${INSTALL}`}`,
  })
  const version = opts.infoPlist ? appVersion(opts.infoPlist) : null
  if (starts && version && compareVersions(version, opts.cli) < 0) warnings.push({
    title: `AgentX Voice ${version} is older than the CLI ${opts.cli}`,
    detail: `${starts} was built before this AgentX version, so recent fixes are missing from it.`,
    fix: INSTALL,
  })
  return warnings
}

/** A plist as XML text (plutil also reads binary plists), or null. */
export function readPlist(file: string): string | null {
  try { return execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch { return null }
}

/** voiceWarnings for this Mac: reads the login items, the copies and the
 *  Info.plist of the copy that starts at login. */
export function macVoiceWarnings(loginItems: { file: string; plist: string }[], home: string, cli: string): VoiceWarning[] {
  const copies = voiceAppCandidates(home).filter(app => existsSync(join(app, 'Contents/MacOS/AgentXVoice')))
  return voiceWarnings({ loginItems, copies, infoPlist: startedApp(loginItems)?.infoPlist ?? null, cli })
}

/** The copy the login item starts and its Info.plist, or null. */
export function startedApp(loginItems: { plist: string }[]): { app: string; infoPlist: string | null } | null {
  const app = loginItems.map(i => loginItemApp(i.plist)).find(Boolean)
  return app ? { app, infoPlist: readPlist(join(app, 'Contents/Info.plist')) } : null
}
