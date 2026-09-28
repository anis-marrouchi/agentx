import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESKTOP_LABEL = 'tn.acme.agentx.voice'
export const DESKTOP_APP = 'AgentX Desktop.app'
export const HELPER_APP = 'AgentX Helper.app'
export function desktopPlatformError(platform: string, arch: string, release: string): string | null {
  if (platform !== 'darwin' || arch !== 'arm64' || Number(release.split('.')[0]) < 23)
    return 'AgentX Desktop currently requires Apple Silicon and macOS 14 or newer.'
  return null
}
export function selectDesktopAgent(agents: Record<string, unknown>, requested?: string): string {
  if (requested && !Object.hasOwn(agents, requested)) throw new Error(`Unknown agent: ${requested}. Run agentx agent list.`)
  const id = requested || Object.keys(agents)[0]
  if (!id) throw new Error('No agents configured. Run agentx setup first.')
  return id
}
export function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'` }
/** launchd's default PATH, which is all a login item gets unless the plist sets one. */
export const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
/** PATH for the login item: AGENTX_VOICE_PATH when set, else the folder of
 *  the ffmpeg found at install time (mlx_whisper needs it) ahead of launchd's default. */
export function desktopPath(ffmpeg: string | null, override?: string): string {
  if (override) return override
  return [...new Set([...(ffmpeg ? [dirname(ffmpeg)] : []), ...LAUNCHD_PATH.split(':')])].join(':')
}
function unxml(s: string): string {
  const ents: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ents[e])
}
/** The PATH a login item plist sets, or launchd's default when it sets none. */
export function plistPathEnv(plist: string): string {
  const m = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)
  return m ? unxml(m[1]) : LAUNCHD_PATH
}
/** Login item files the voice app may have been installed under. */
export const isVoiceLoginItemFile = (name: string) => /agentx\.voice.*\.plist$/.test(name)
export type LoginItem = { file: string; label: string }
/** One login item per Mac. The label was renamed once and
 *  apps/mac-voice/install.sh writes its own, so adopt the first existing
 *  `*agentx.voice*` item that runs the voice app (any bundle name) and
 *  retire the others; with none, use DESKTOP_LABEL. Plists are XML text. */
export function adoptLoginItem(dir: string, items: { file: string; plist: string }[]): { keep: LoginItem; remove: LoginItem[] } {
  let keep: LoginItem | null = null
  const remove: LoginItem[] = []
  for (const { file, plist } of [...items].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    const label = plist.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/)?.[1]
    const program = plist.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1]
    if (!label || !program || !unxml(program).endsWith('/Contents/MacOS/AgentXVoice')) continue
    if (keep) remove.push({ file, label: unxml(label) })
    else keep = { file, label: unxml(label) }
  }
  return { keep: keep ?? { file: join(dir, `${DESKTOP_LABEL}.plist`), label: DESKTOP_LABEL }, remove }
}
/** The file that a process with this PATH would run, or null. */
export function findOnPath(bin: string, path: string, isExecutable: (file: string) => boolean): string | null {
  for (const dir of path.split(':')) if (dir && isExecutable(join(dir, bin))) return join(dir, bin)
  return null
}
/** Without `agent` the app talks to the agent picked in its menu-bar
 *  icon; with it, that agent is pinned and the menu cannot switch. */
export function desktopPlist(opts: { label?: string; executable: string; cwd: string; agent?: string; url: string; helper: string; cli: string; node: string; log: string; path: string }): string {
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  const env = {
    PATH: opts.path,
    ...(opts.agent ? { AGENTX_VOICE_AGENT: opts.agent } : {}),
    AGENTX_DAEMON_URL: opts.url,
    AGENTX_MAC_HELPER: opts.helper,
    AGENTX_PASTE_COMMAND: `cd ${shellQuote(opts.cwd)} && ${shellQuote(opts.node)} ${shellQuote(opts.cli)} paste`,
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(opts.label ?? DESKTOP_LABEL)}</string>
<key>ProgramArguments</key><array><string>${xml(opts.executable)}</string></array>
<key>WorkingDirectory</key><string>${xml(opts.cwd)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>StandardErrorPath</key><string>${xml(opts.log)}</string>
</dict></plist>\n`
}
/** build.sh arguments for the helper: the banner icon from
 *  notifications.local.icon, or none for the bundled AgentX logo. */
export function helperBuildArgs(icon?: string): string[] {
  return icon ? ['--icon', icon] : []
}
export function installedHelper(home: string): string {
  return join(home, 'Applications', HELPER_APP, 'Contents/MacOS/agentx-mac-helper')
}
/** The AgentX package folder, found by walking up from this file (dist/
 *  when installed, src/ in a checkout) — never from the caller's cwd, so
 *  `agentx notify` finds a repo-built helper from any folder. */
export function packageRoot(from = dirname(fileURLToPath(import.meta.url))): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'agentix-cli') return dir
    } catch { /* no package.json here — keep walking up */ }
    if (dirname(dir) === dir) return null
  }
}
/** The helper to run: an explicit path, else the one `agentx desktop
 *  install` put in ~/Applications, else one built in the package. */
export function resolveHelper(root: string | null, home: string, override?: string): string {
  if (override) return override
  const installed = installedHelper(home)
  if (existsSync(installed) || !root) return installed
  return join(root, 'apps/mac-helper/build', HELPER_APP, 'Contents/MacOS/agentx-mac-helper')
}
