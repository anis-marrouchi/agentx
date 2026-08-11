import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, resolve } from "path"

// --- Installing the attach hooks into Claude Code ---
//
// Attach mode needs four hook events wired into the human's own Claude Code
// settings, not into an agent workspace: the whole point is that the session
// you already have open becomes addressable. So these go to the USER scope
// (~/.claude/settings.json) and apply to every session on the machine.
//
// That sounds invasive; it isn't. The hooks are dumb pipes. They post to the
// daemon and forward whatever comes back. For the overwhelming majority of
// sessions — the ones that never run `agentx attach` — the daemon has no
// binding for them and answers with an empty body, which Claude Code treats
// as "carry on". State lives in the daemon, never in the settings file, so
// attaching and detaching is a runtime operation with no file edits and no
// session restart.
//
// The same install also carries the PreToolUse guard hook. An attached
// session answering as a production identity runs under the human's own
// permissions rather than the agent workspace's settings.json, so without
// this an attached `clawd` would be LESS guarded than a spawned one. That
// asymmetry is exactly the kind of thing that causes the incident the guard
// was built for, so the installer refuses to leave it open.

export const ATTACH_MARKER = "/attach/"
export const GUARD_MARKER = "/guard/check"

type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }

/** One-line curl to the daemon. `--data-binary @-` streams the hook's stdin
 *  payload through unread; `|| true` means a stopped daemon degrades to "no
 *  opinion" instead of erroring in the human's session. */
function hookCommand(route: string, port: string, query = ""): string {
  const url = `http://127.0.0.1:${port}${route}${query}`
  return `curl -s --max-time 3 -H 'Content-Type: application/json' --data-binary @- '${url}' 2>/dev/null || true`
}

function entry(route: string, port: string, matcher?: string): HookEntry {
  const e: HookEntry = { hooks: [{ type: "command", command: hookCommand(route, port), timeout: 10 }] }
  if (matcher !== undefined) e.matcher = matcher
  return e
}

/** The hook block attach mode owns, keyed by event name. */
export function attachHookBlock(port: string): Record<string, HookEntry[]> {
  return {
    SessionStart: [entry("/attach/session-start", port, "")],
    UserPromptSubmit: [entry("/attach/prompt", port)],
    Stop: [entry("/attach/stop", port)],
    SessionEnd: [entry("/attach/session-end", port)],
  }
}

/** PreToolUse guard, user-scope. Mirrors the per-workspace form in
 *  agents/workspace-setup.ts but without an `?agent=` — an attached session's
 *  identity is a runtime binding, so the daemon resolves it per call. */
export function guardHookEntries(port: string): HookEntry[] {
  const command = hookCommand("/guard/check", port)
  return [
    { matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] },
    { matcher: "Write|Edit", hooks: [{ type: "command", command, timeout: 10 }] },
  ]
}

function isOurs(e: any, marker: string): boolean {
  return (
    Array.isArray(e?.hooks) &&
    e.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes(marker))
  )
}

export interface InstallResult {
  path: string
  changed: boolean
  events: string[]
  guardInstalled: boolean
}

export function userSettingsPath(): string {
  return resolve(homedir(), ".claude/settings.json")
}

/**
 * The port the hooks should call. Read from `node.bind` in agentx.json rather
 * than assumed: this is per-install (18800 on one node here, 19900 on
 * another), and a hook pointed at the wrong port fails silently — `|| true`
 * turns it into "no opinion", so a bad default would look like attach mode
 * simply never firing. Falls back to 19900 only when there is no config.
 */
export function configuredDaemonPort(root: string = process.cwd()): string {
  for (const dir of [root, resolve(root, "..")]) {
    const cfg = resolve(dir, "agentx.json")
    if (!existsSync(cfg)) continue
    try {
      const bind = JSON.parse(readFileSync(cfg, "utf-8"))?.node?.bind
      const port = String(bind ?? "").split(":")[1]
      if (port) return port
    } catch {
      /* fall through to the default */
    }
  }
  return "19900"
}

/**
 * Add (or refresh) the attach hooks. Idempotent: existing agentx entries are
 * replaced rather than appended, so a changed port self-heals instead of
 * stacking duplicates. Hooks belonging to anything else are preserved
 * untouched — this file is the human's, and we are a guest in it.
 */
export function installAttachHooks(
  port: string,
  opts: { path?: string; withGuard?: boolean } = {},
): InstallResult {
  const path = opts.path ?? userSettingsPath()
  const withGuard = opts.withGuard !== false

  let settings: Record<string, any> = {}
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf-8"))
    } catch (e: any) {
      throw new Error(`${path} is not valid JSON (${e?.message}) — refusing to overwrite it`)
    }
  }

  const before = JSON.stringify(settings)
  const hooks = (settings.hooks ??= {})
  const events: string[] = []

  for (const [event, desired] of Object.entries(attachHookBlock(port))) {
    const others = Array.isArray(hooks[event])
      ? hooks[event].filter((e: any) => !isOurs(e, ATTACH_MARKER))
      : []
    hooks[event] = [...others, ...desired]
    events.push(event)
  }

  let guardInstalled = false
  if (withGuard) {
    const others = Array.isArray(hooks.PreToolUse)
      ? hooks.PreToolUse.filter((e: any) => !isOurs(e, GUARD_MARKER))
      : []
    hooks.PreToolUse = [...others, ...guardHookEntries(port)]
    guardInstalled = true
  }

  const changed = JSON.stringify(settings) !== before
  if (changed) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
  }
  return { path, changed, events, guardInstalled }
}

/** Remove every hook agentx installed. Leaves the rest of the file alone,
 *  and drops hook events that end up empty rather than leaving `[]` behind. */
export function uninstallAttachHooks(opts: { path?: string; keepGuard?: boolean } = {}): InstallResult {
  const path = opts.path ?? userSettingsPath()
  if (!existsSync(path)) return { path, changed: false, events: [], guardInstalled: false }

  let settings: Record<string, any>
  try {
    settings = JSON.parse(readFileSync(path, "utf-8"))
  } catch (e: any) {
    throw new Error(`${path} is not valid JSON (${e?.message}) — refusing to rewrite it`)
  }

  const before = JSON.stringify(settings)
  const hooks = settings.hooks
  const events: string[] = []
  if (hooks && typeof hooks === "object") {
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue
      const marker = event === "PreToolUse" ? GUARD_MARKER : ATTACH_MARKER
      if (event === "PreToolUse" && opts.keepGuard !== false) continue
      const kept = hooks[event].filter((e: any) => !isOurs(e, marker))
      if (kept.length !== hooks[event].length) events.push(event)
      if (kept.length === 0) delete hooks[event]
      else hooks[event] = kept
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks
  }

  const changed = JSON.stringify(settings) !== before
  if (changed) writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
  return { path, changed, events, guardInstalled: false }
}

/** Are our hooks currently present? Used by `agentx attach status` and doctor. */
export function attachHooksInstalled(path = userSettingsPath()): boolean {
  if (!existsSync(path)) return false
  try {
    const s = JSON.parse(readFileSync(path, "utf-8"))
    return Boolean(s?.hooks?.Stop?.some?.((e: any) => isOurs(e, ATTACH_MARKER)))
  } catch {
    return false
  }
}
