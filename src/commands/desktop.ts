import { Command } from 'commander'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, release, tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadDaemonConfig } from '@/daemon/config'
import { type VoiceWarning, appVersion, macVoiceWarnings, startedApp } from '@/desktop/voice-checks'
import { DESKTOP_APP, HELPER_APP, OLD_DESKTOP_APP, type LoginItem, adoptLoginItem, desktopPath, desktopPlatformError, desktopPlist, findOnPath, helperBuildArgs, installedHelper, isNativeExecutable, isVoiceLoginItemFile, packageRoot, selectDesktopAgent } from '@/desktop/install'
import { ORB_APP, ORB_BUILD_ARGS, ORB_BUNDLE_ID, builtOrbApp, orbSettings, orbSettingsFile, otherOrbApps, restoredLoginItem, retiredLoginItem, retiredOrbApp, undoOrbSettings } from '@/desktop/orb-switch'

function checkPlatform() {
  const error = desktopPlatformError(process.platform, process.arch, release())
  if (error) throw new Error(error)
}
/** The voice app's login item, adopting one an older install left under
 *  another label, and any duplicates of it. */
function loginItems(): { keep: LoginItem; remove: LoginItem[]; items: { file: string; plist: string }[] } {
  const dir = join(homedir(), 'Library/LaunchAgents')
  let names: string[] = []
  try { names = readdirSync(dir).filter(isVoiceLoginItemFile) } catch { /* no LaunchAgents folder yet */ }
  const items = names.flatMap(name => {
    const file = join(dir, name)
    // plutil also reads binary plists.
    try { return [{ file, plist: execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }] }
    catch { return [] }
  })
  return { ...adoptLoginItem(dir, items), items }
}
/** This package's version, from the package.json at its root. */
function cliVersion(root: string | null): string {
  try { return JSON.parse(readFileSync(join(root ?? '', 'package.json'), 'utf8')).version ?? '0.0.0' }
  catch { return '0.0.0' }
}
/** The checkout's short commit, or '' for an npm install. */
function gitCommit(root: string): string {
  try { return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { return '' }
}
function printWarnings(warnings: VoiceWarning[]) {
  for (const w of warnings) console.warn(`Warning: ${w.title}
  ${w.detail}
  Fix: ${w.fix}`)
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
export const desktop = new Command('desktop').description('install and control AgentX Voice, the macOS voice assistant')
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
    const { keep, remove, items } = loginItems()
    const version = cliVersion(root)
    printWarnings(macVoiceWarnings(items, homedir(), version))
    // The app was installed as "AgentX Desktop" before it had one name (#2095).
    const oldApp = join(apps, OLD_DESKTOP_APP)
    const replacesOld = existsSync(join(oldApp, 'Contents/MacOS/AgentXVoice'))
    console.log(`${replacesOld ? `Replaces ${oldApp}\n` : ''}AgentX Voice → ${join(apps, DESKTOP_APP)}\nComputer-use helper → ${join(apps, HELPER_APP)}\nAgent → ${pinned ? `${agent} (pinned)` : 'picked from the menu-bar icon'}\nDaemon → ${url}\nStarts at login → ${keep.file}${remove.map(r => `\nRemoves duplicate login item → ${r.file}`).join('')}`)
    if (opts.dryRun) return
    try { execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' }) }
    catch { throw new Error('Apple command-line tools are required. Run xcode-select --install, finish installation, then retry.') }
    // A login item gets launchd's bare PATH, where local Whisper cannot find ffmpeg.
    const ffmpeg = findOnPath('ffmpeg', process.env.PATH || '', isNativeExecutable)
    if (!ffmpeg && !process.env.AGENTX_VOICE_PATH) console.warn('ffmpeg was not found. Local Whisper transcription needs it: install ffmpeg (for example brew install ffmpeg), then rerun this install.')
    // Compile in a temporary directory: npm installations may be read-only.
    const stage = mkdtempSync(join(tmpdir(), 'agentx-desktop-'))
    try {
      for (const name of ['mac-helper', 'mac-voice']) {
        cpSync(join(root, 'apps', name), join(stage, name), { recursive: true, filter: source => !source.split('/').includes('build') })
        const args = name === 'mac-helper' ? helperBuildArgs(config.notifications.local.icon) : []
        // The staged copy has no package.json or git: build.sh stamps these into the app.
        const env = { ...process.env, AGENTX_VERSION: version, AGENTX_COMMIT: gitCommit(root) }
        execFileSync('/bin/bash', [join(stage, name, 'build.sh'), ...args], { stdio: 'inherit', env })
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
      if (replacesOld) rmSync(oldApp, { recursive: true, force: true })
      mkdirSync(apps, { recursive: true })
      for (const [name, built, dest] of [['mac-voice', 'AgentX Voice.app', DESKTOP_APP], ['mac-helper', HELPER_APP, HELPER_APP]]) {
        cpSync(join(stage, name, 'build', built), join(apps, dest), { recursive: true })
      }
      mkdirSync(dirname(keep.file), { recursive: true })
      mkdirSync(dirname(log), { recursive: true })
      writeFileSync(keep.file, plist, { mode: 0o600 })
      start(keep)
      // What the install can't fix itself: other copies of the app.
      printWarnings(macVoiceWarnings(loginItems().items, homedir(), version))
      console.log('AgentX Voice is running. Hold Option–Space to speak; Command–Option–V for smart paste.\nAllow Microphone for the app and Accessibility / Screen Recording for the helper when macOS asks.\nThe AgentX daemon and a speech transcription backend must also be available. Run agentx desktop status to inspect the login service.')
    } finally { rmSync(stage, { recursive: true, force: true }) }
  })
/** Quits the installed orb app, matched by its full executable path so the
 *  Electron helpers and AgentX Voice are left alone, and waits until it is gone. */
async function quitOrbApp(dest: string) {
  const exe = join(dest, 'Contents/MacOS/AgentX')
  try { execFileSync('pkill', ['-f', exe], { stdio: 'pipe' }) } catch { return /* not running */ }
  for (let i = 0; i < 25; i++) {
    try { execFileSync('pgrep', ['-f', exe], { stdio: 'pipe' }) } catch { return }
    await sleep(200)
  }
  throw new Error(`${dest} did not quit. Quit AgentX from its menu, then retry.`)
}
function bundleId(app: string): string | null {
  try { return execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Contents/Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { return null /* no Info.plist or no id */ }
}
/** Other installed copies of the orb app, split into ours (to quit and move
 *  aside) and apps that only share the name (left alone). */
function otherOrbCopies(home: string, dest: string) {
  const found = otherOrbApps(home, dest).filter(app => existsSync(app))
  return { ours: found.filter(app => bundleId(app) === ORB_BUNDLE_ID), foreign: found.filter(app => bundleId(app) !== ORB_BUNDLE_ID) }
}
function readOrbSettings(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null /* first run: defaults */ }
}
function writeOrbSettings(file: string, settings: Record<string, unknown>) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
}
/** `agentx desktop orb --undo`: AgentX Voice back at login, the orb app's own
 *  login item off, so only one of them starts. */
async function undoOrb(home: string, dest: string, dryRun: boolean) {
  const dir = join(home, 'Library/LaunchAgents')
  let names: string[] = []
  try { names = readdirSync(dir) } catch { /* no LaunchAgents folder */ }
  const retired = names.flatMap(name => {
    const back = restoredLoginItem(join(dir, name))
    return back ? [{ file: join(dir, name), back }] : []
  })
  const installed = existsSync(dest)
  const asides = [...otherOrbApps(home, dest), dest].flatMap(app => {
    try { return readdirSync(dirname(app)).filter(name => name.startsWith(`${ORB_APP}.disabled-orb-`)).map(name => join(dirname(app), name)) } catch { return [] }
  })
  console.log(`${installed ? `Desktop app ${dest}: Open at login off, orb hidden, quit (the app stays installed)` : `No desktop app at ${dest}`}${retired.map(r => `\nWidget login item back on → ${r.back}${existsSync(r.back) ? ' (already there: left as it is)' : ''}`).join('')}${asides.map(a => `\nOther copy the switch moved aside stays there → ${a}`).join('')}\nThen: agentx desktop start`)
  if (dryRun) return
  if (installed) {
    writeOrbSettings(orbSettingsFile(home), undoOrbSettings(readOrbSettings(orbSettingsFile(home))))
    await quitOrbApp(dest)
    // Only the app can remove its own login item (macOS keeps it for the app,
    // not in a file): it applies the saved Open at login when it starts.
    // Start it once in the background with the orb hidden, then quit it.
    execFileSync('open', ['-g', dest], { stdio: 'pipe' })
    await sleep(6000)
    await quitOrbApp(dest)
  }
  for (const r of retired) if (!existsSync(r.back)) renameSync(r.file, r.back)
  const { keep } = loginItems()
  if (!existsSync(keep.file)) {
    console.log('The orb app is off at login. No AgentX Voice login item was found: run agentx desktop install to put it back.')
    return
  }
  start(keep)
  console.log('AgentX Voice is back and starts at login; the orb app no longer does. Check it under System Settings → General → Login Items if you want to be sure.')
}
desktop.command('orb').description('switch this Mac from the AgentX Voice widget to the desktop app with the orb (#2265)')
  .option('--dry-run', 'show what changes without building or moving anything')
  .option('--undo', 'go back: AgentX Voice starts at login again and the orb app does not')
  .action(async opts => {
    checkPlatform()
    if (opts.undo) return undoOrb(homedir(), join(homedir(), 'Applications', ORB_APP), !!opts.dryRun)
    const root = packageRoot()
    if (!root || !existsSync(join(root, 'apps/desktop/package.json'))) throw new Error('apps/desktop is missing from this installation. Update AgentX to a release containing it.')
    const home = homedir()
    const dest = join(home, 'Applications', ORB_APP)
    const { keep, remove } = loginItems()
    const widgets = [keep, ...remove].filter(item => existsSync(item.file))
    const now = new Date()
    const copies = otherOrbCopies(home, dest)
    console.log(`Desktop app with the orb → ${dest} (starts at login, orb shown, no window)\nSettings → ${orbSettingsFile(home)}${widgets.map(w => `\nWidget login item off → ${retiredLoginItem(w.file, now)}`).join('')}${copies.ours.map(app => `\nOther copy quit and moved aside → ${retiredOrbApp(app, now, existsSync)}`).join('')}${copies.foreign.map(app => `\nLeft alone (another app with the same name) → ${app}`).join('')}\nKept: ${join(home, 'Applications', DESKTOP_APP)} and ${HELPER_APP} (undo: agentx desktop orb --undo)`)
    if (opts.dryRun) return
    const stage = mkdtempSync(join(tmpdir(), 'agentx-orb-'))
    try {
      cpSync(join(root, 'apps/desktop'), stage, { recursive: true, filter: source => !/\/(node_modules|release|dist)(\/|$)/.test(source.slice(root.length)) })
      const run = (args: string[]) => execFileSync('npx', ['--no-install', ...args], { cwd: stage, stdio: 'inherit' })
      execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' })
      run(['tsc', '-p', 'tsconfig.json'])
      run(ORB_BUILD_ARGS)
      const built = builtOrbApp(stage)
      if (!existsSync(built)) throw new Error(`The build left no app at ${built}.`)
      // Only one copy may run: another one would start at login too.
      for (const app of copies.ours) {
        await quitOrbApp(app)
        renameSync(app, retiredOrbApp(app, now, existsSync))
      }
      // Quit a running copy before it is replaced; it may not be running.
      await quitOrbApp(dest)
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(built, dest, { recursive: true })
    } finally { rmSync(stage, { recursive: true, force: true }) }
    writeOrbSettings(orbSettingsFile(home), orbSettings(readOrbSettings(orbSettingsFile(home))))
    // Never both: the widget's login items go off before the app starts.
    for (const item of widgets) {
      await stop(item)
      renameSync(item.file, retiredLoginItem(item.file, now))
    }
    execFileSync('open', [dest], { stdio: 'pipe' })
    console.log('The orb is running and starts at login. Allow Microphone when macOS asks.\nOption–Space is off for now: hold the orb to talk, or turn on the talk key in the AgentX menu (macOS then asks for Input Monitoring).\nIncoming agent calls ring on the phone until the orb answers them (#2523).\nTo go back: agentx desktop orb --undo')
  })
desktop.command('start').description('start the installed AgentX Voice').action(() => { checkPlatform(); start(loginItems().keep); console.log('AgentX Voice started.') })
desktop.command('stop').description('stop AgentX Voice until started again or next login').action(async () => { checkPlatform(); await stop(loginItems().keep); console.log('AgentX Voice stopped.') })
desktop.command('status').description('show the desktop login service status').action(() => {
  checkPlatform()
  const { keep, items } = loginItems()
  try { console.log(execFileSync('launchctl', ['print', launchTarget(keep)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }
  catch { console.log(existsSync(keep.file) ? 'Installed, but not running. Run agentx desktop start.' : 'Not installed. Run agentx desktop install.') }
  const started = startedApp(items)
  const version = started?.infoPlist ? appVersion(started.infoPlist) : null
  if (started) console.log(`AgentX Voice ${version ?? '(version unknown)'} → ${started.app}`)
  printWarnings(macVoiceWarnings(items, homedir(), cliVersion(packageRoot())))
})
