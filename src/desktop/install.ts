import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
export function desktopPlist(opts: { executable: string; cwd: string; agent: string; url: string; helper: string; cli: string; node: string; log: string }): string {
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  const env = {
    AGENTX_VOICE_AGENT: opts.agent,
    AGENTX_DAEMON_URL: opts.url,
    AGENTX_MAC_HELPER: opts.helper,
    AGENTX_PASTE_COMMAND: `cd ${shellQuote(opts.cwd)} && ${shellQuote(opts.node)} ${shellQuote(opts.cli)} paste`,
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${DESKTOP_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(opts.executable)}</string></array>
<key>WorkingDirectory</key><string>${xml(opts.cwd)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>StandardErrorPath</key><string>${xml(opts.log)}</string>
</dict></plist>\n`
}
export function installedHelper(home: string): string {
  return join(home, 'Applications', HELPER_APP, 'Contents/MacOS/agentx-mac-helper')
}
export function resolveHelper(cwd: string, home: string, override?: string): string {
  if (override) return override
  const installed = installedHelper(home)
  return existsSync(installed) ? installed : join(cwd, 'apps/mac-helper/build/AgentX Helper.app/Contents/MacOS/agentx-mac-helper')
}
