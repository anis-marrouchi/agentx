import { Command } from 'commander'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, release, tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadDaemonConfig } from '@/daemon/config'
import { DESKTOP_APP, HELPER_APP, type LoginItem, adoptLoginItem, desktopPath, desktopPlatformError, desktopPlist, helperBuildArgs, installedHelper, isVoiceLoginItemFile, packageRoot, selectDesktopAgent } from '@/desktop/install'

function checkPlatform() {
  const error = desktopPlatformError(process.platform, process.arch, release())
  if (error) throw new Error(error)
}
/** The voice app's login item, adopting one an older install left under
 *  another label, and any duplicates of it. */
function loginItems(): { keep: LoginItem; remove: LoginItem[] } {
  const dir = join(homedir(), 'Library/LaunchAgents')
  let names: string[] = []
  try { names = readdirSync(dir).filter(isVoiceLoginItemFile) } catch { /* no LaunchAgents folder yet */ }
  const items = names.flatMap(name => {
    const file = join(dir, name)
    // plutil also reads binary plists.
    try { return [{ file, plist: execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }] }
    catch { return [] }
  })
  return adoptLoginItem(dir, items)
}
function launchTarget(item: LoginItem) { return `gui/${process.getuid!()}/${item.label}` }
async function stop(item: LoginItem) {
  try { execFileSync('launchctl', ['bootout', launchTarget(item)], { stdio: 'pipe' }) } catch { /* may already be stopped */ }
  for (let i = 0; i < 30; i++) {
    try { execFileSync('launchctl', ['print', launchTarget(item)], { stdio: 'pipe' }) }
    catch { return }
    await sleep(200)
  }
  throw new Error('The desktop login service did not stop. Retry agentx desktop stop before installing.')
}
function start(item: LoginItem) {
  if (!existsSync(item.file)) throw new Error('Run agentx desktop install first.')
  let loaded = true
  try { execFileSync('launchctl', ['print', launchTarget(item)], { stdio: 'pipe' }) } catch { loaded = false }
  if (!loaded) execFileSync('launchctl', ['bootstrap', `gui/${process.getuid!()}`, item.file], { stdio: 'pipe' })
  execFileSync('launchctl', ['kickstart', launchTarget(item)], { stdio: 'pipe' })
}
function sourceRoot() {
  const root = packageRoot()
  if (root && existsSync(join(root, 'apps/mac-voice/build.sh'))) return root
  throw new Error('Desktop sources are missing from this installation. Update AgentX to a release containing apps/mac-voice and apps/mac-helper.')
}
export const desktop = new Command('desktop').description('install and control the macOS desktop assistant')
desktop.command('install').description('build, install, and start voice and computer-use helpers at login')
  .option('--agent <id>', 'pin this agent; without it, pick the agent from the menu-bar icon')
  .option('--dry-run', 'show the installation plan without building or changing login items')
  .action(async opts => {
    checkPlatform()
    const config = loadDaemonConfig()
    const agent = selectDesktopAgent(config.agents, opts.agent)
    const pinned: string | undefined = opts.agent
    const url = config.dashboard?.daemonUrl || `http://${config.node.bind.replace(/^0\.0\.0\.0:/, '127.0.0.1:')}`
    const root = sourceRoot()
    const apps = join(homedir(), 'Applications')
    const { keep, remove } = loginItems()
    console.log(`Desktop assistant → ${join(apps, DESKTOP_APP)}\nComputer-use helper → ${join(apps, HELPER_APP)}\nAgent → ${pinned ? `${agent} (pinned)` : 'picked from the menu-bar icon'}\nDaemon → ${url}\nStarts at login → ${keep.file}${remove.map(r => `\nRemoves duplicate login item → ${r.file}`).join('')}`)
    if (opts.dryRun) return
    try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) }
    catch { throw new Error('Apple command-line tools are required. Run xcode-select --install, finish installation, then retry.') }
    // A login item gets launchd's bare PATH, where local Whisper cannot find ffmpeg.
    let ffmpeg: string | null = null
    try { ffmpeg = execFileSync('/bin/sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null } catch { /* not installed */ }
    if (!ffmpeg && !process.env.AGENTX_VOICE_PATH) console.warn('ffmpeg was not found. Local Whisper transcription needs it: install ffmpeg (for example brew install ffmpeg), then rerun this install.')
    // Compile in a temporary directory: npm installations may be read-only.
    const stage = mkdtempSync(join(tmpdir(), 'agentx-desktop-'))
    try {
      for (const name of ['mac-helper', 'mac-voice']) {
        cpSync(join(root, 'apps', name), join(stage, name), { recursive: true, filter: source => !source.split('/').includes('build') })
        const args = name === 'mac-helper' ? helperBuildArgs(config.notifications.local.icon) : []
        execFileSync('/bin/bash', [join(stage, name, 'build.sh'), ...args], { stdio: 'inherit' })
      }
      const log = join(homedir(), 'Library/Logs/agentx-desktop.err.log')
      const plist = desktopPlist({ label: keep.label, executable: join(apps, DESKTOP_APP, 'Contents/MacOS/AgentXVoice'), cwd: process.cwd(), agent: pinned, url,
        helper: installedHelper(homedir()), cli: join(root, 'dist/cli.js'), node: process.execPath, log,
        path: desktopPath(ffmpeg, process.env.AGENTX_VOICE_PATH) })
      const stagedPlist = join(stage, 'desktop.plist')
      writeFileSync(stagedPlist, plist, { mode: 0o600 })
      execFileSync('plutil', ['-lint', stagedPlist], { stdio: 'pipe' })
      await stop(keep)
      for (const item of remove) {
        if (item.label !== keep.label) await stop(item)
        rmSync(item.file, { force: true })
      }
      mkdirSync(apps, { recursive: true })
      for (const [name, built, dest] of [['mac-voice', 'AgentX Voice.app', DESKTOP_APP], ['mac-helper', HELPER_APP, HELPER_APP]]) {
        cpSync(join(stage, name, 'build', built), join(apps, dest), { recursive: true })
      }
      mkdirSync(dirname(keep.file), { recursive: true })
      mkdirSync(dirname(log), { recursive: true })
      writeFileSync(keep.file, plist, { mode: 0o600 })
      start(keep)
      console.log('Desktop assistant is running. Hold Option–Space to speak; Command–Option–V for smart paste.\nAllow Microphone for the app and Accessibility / Screen Recording for the helper when macOS asks.\nThe AgentX daemon and a speech transcription backend must also be available. Run agentx desktop status to inspect the login service.')
    } finally { rmSync(stage, { recursive: true, force: true }) }
  })
desktop.command('start').description('start the installed desktop assistant').action(() => { checkPlatform(); start(loginItems().keep); console.log('Desktop assistant started.') })
desktop.command('stop').description('stop the desktop assistant until started again or next login').action(async () => { checkPlatform(); await stop(loginItems().keep); console.log('Desktop assistant stopped.') })
desktop.command('status').description('show the desktop login service status').action(() => {
  checkPlatform()
  const { keep } = loginItems()
  try { console.log(execFileSync('launchctl', ['print', launchTarget(keep)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }
  catch { console.log(existsSync(keep.file) ? 'Installed, but not running. Run agentx desktop start.' : 'Not installed. Run agentx desktop install.') }
})
