import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { pathToFileURL } from "url"
import { runtimeGuardCommand } from "./runtime-guard"

// --- The guard plugin for OpenCode runs (#2119) ---
//
// OpenCode has no PreToolUse hook setting; it has plugins. AgentX writes one
// small plugin per agent and adds it to the run's OPENCODE_CONFIG_CONTENT.
// Before each tool call the plugin pipes Claude Code's PreToolUse payload to
// the same guard hook command the Claude Code workspace hook runs
// (runtime-guard.ts), and throws on a deny, which stops the call; the model
// sees the reason. The plugin is plain JavaScript with no imports beyond
// node:child_process, since OpenCode loads it in its own runtime.
//
// OpenCode v2 loads a plugin directory from `plugins` and calls `setup(ctx)`;
// v1 loads a file from `plugin` and calls each exported function.

/** Where the plugin for one agent lives, under the install root. */
export function openCodeGuardPluginDir(root: string, agentId: string): string {
  return resolve(root, ".agentx/opencode", agentId.replace(/[^A-Za-z0-9_.-]/g, "_"), "guard")
}

/** The plugin source. `write` guards shell and file edits (refuses when the
 *  guard cannot run), `read` guards reads and searches (runs when it cannot). */
export function openCodeGuardPluginSource(commands: { write: string; read: string }, version: 1 | 2): string {
  const body = `import { spawn } from "node:child_process"

// Written by AgentX (#2119). Runs the AgentX guard before each tool call.
// Rewritten on each run; edits here are lost.
const COMMANDS = ${JSON.stringify(commands)}
const NO_ANSWER = "[agentx-guard] Refused: the AgentX guard could not run for this call."

function patchPaths(text) {
  const out = []
  for (const m of String(text || "").matchAll(/^\\*\\*\\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) out.push(m[1].trim())
  return out
}

// One OpenCode tool call as Claude Code PreToolUse payloads (v1 and v2 names).
export function payloadsFor(tool, args, cwd) {
  const name = String(tool || "").toLowerCase()
  const a = args || {}
  const file = a.filePath ?? a.file_path ?? a.path
  if (name === "bash" || name === "shell") {
    return [{ kind: "write", payload: { tool_name: "Bash", tool_input: { command: String(a.command ?? "") }, cwd: a.workdir || cwd } }]
  }
  if (name === "edit" || name === "write" || name === "multiedit") {
    return [{ kind: "write", payload: { tool_name: name === "write" ? "Write" : "Edit", tool_input: { file_path: String(file ?? "") }, cwd } }]
  }
  if (name === "patch" || name === "apply_patch") {
    const paths = patchPaths(a.patchText ?? a.patch ?? a.input)
    return (paths.length ? paths : [""]).map((p) => ({ kind: "write", payload: { tool_name: "Edit", tool_input: { file_path: p }, cwd } }))
  }
  if (name === "read") return [{ kind: "read", payload: { tool_name: "Read", tool_input: { file_path: String(file ?? "") }, cwd } }]
  if (name === "grep") return [{ kind: "read", payload: { tool_name: "Grep", tool_input: { path: String(a.path ?? cwd ?? "") }, cwd } }]
  return []
}

function runHook(kind, payload) {
  return new Promise((done) => {
    let out = ""
    let child
    try {
      child = spawn("sh", ["-c", COMMANDS[kind]], { env: { ...process.env, AGENTX_GUARD: "required" }, stdio: ["pipe", "pipe", "ignore"] })
    } catch { done({ ok: false, out }); return }
    child.stdout.on("data", (c) => { out += c.toString() })
    child.on("error", () => done({ ok: false, out }))
    child.on("close", (code) => done({ ok: code === 0, out }))
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", ...payload }))
  })
}

// Throws on a deny (or an ask: nobody can answer one in this run).
export async function guard(tool, args, cwd) {
  for (const { kind, payload } of payloadsFor(tool, args, cwd)) {
    const { ok, out } = await runHook(kind, payload)
    if (!ok) {
      if (kind === "read") continue
      throw new Error(NO_ANSWER)
    }
    let decision
    try { decision = JSON.parse(out)?.hookSpecificOutput } catch { decision = undefined }
    if (decision?.permissionDecision === "deny" || decision?.permissionDecision === "ask") {
      throw new Error(String(decision.permissionDecisionReason || "[agentx-guard] Refused by the guard."))
    }
  }
}
`
  const v2 = `
export default {
  id: "agentx.guard",
  async setup(ctx) {
    const cwd = ctx.location?.directory
    await ctx.tool.hook("execute.before", async (event) => { await guard(event.tool, event.input, cwd) })
  },
}
`
  const v1 = `
export const AgentxGuard = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => { await guard(input.tool, output.args, directory) },
})
`
  return body + (version === 2 ? v2 : v1)
}

/** Write (or refresh) the plugin for an agent and return the config change
 *  that loads it. Throws when the file cannot be written: the caller must
 *  then refuse the run. */
export function writeOpenCodeGuardPlugin(
  root: string,
  agentId: string,
  version: 1 | 2,
  commands: { write: string; read: string } = {
    write: runtimeGuardCommand(agentId, "write", root),
    read: runtimeGuardCommand(agentId, "read", root),
  },
): { key: "plugins" | "plugin"; entry: string } {
  const dir = join(openCodeGuardPluginDir(root, agentId), `v${version}`)
  const file = join(dir, "index.js")
  const source = openCodeGuardPluginSource(commands, version)
  let current: string | undefined
  try { current = readFileSync(file, "utf8") } catch { /* first write */ }
  if (current !== source) {
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, source, { mode: 0o644 })
    renameSync(tmp, file)
  }
  // v2 takes a directory and skips a single file; v1 takes a file.
  return version === 2 ? { key: "plugins", entry: dir } : { key: "plugin", entry: pathToFileURL(file).href }
}
