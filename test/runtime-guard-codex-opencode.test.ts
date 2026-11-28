import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { pathToFileURL } from "url"
import { CodexProcessPool, codexGuardCalls } from "../src/agents/codex-process"
import { executeTask, type AgentTask } from "../src/agents/runtime"
import type { AgentDef } from "../src/daemon/config"
import { hookAnswer, runGuardHook, runtimeGuardCommand } from "../src/guard/runtime-guard"
import { writeOpenCodeGuardPlugin } from "../src/guard/opencode-plugin"
import { buildGuardHookCommand, READ_GUARD_BUDGET } from "../src/guard/hook-command"

// #2119: the `agentx guard` checks Claude Code runs as a PreToolUse hook also
// run on Codex (app-server approval requests) and OpenCode (a plugin).

/** Stands in for the guard hook command: refuses any call whose payload
 *  mentions `rm -rf` or `.agentx/operator.key`, in the hook's JSON form. */
const DENY = JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[agentx-guard] blocked by test rule" },
})
const STUB = `p=$(cat); case "$p" in *'rm -rf'*|*operator.key*) printf '%s' '${DENY}';; esac; exit 0`

function agent(workspace: string, tier: "codex-cli" | "opencode", overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "Guard Test", workspace, tier, mentions: [], intents: [], maxDelegationDepth: 5,
    contextReferences: false, maxConcurrent: 1, maxExecutionMinutes: 1, permissionMode: "bypassPermissions",
    queueMode: "collect", heartbeat: { enabled: false, intervalMinutes: 30, prompt: "", channel: "heartbeat" },
    ...overrides,
  } as AgentDef
}

describe("the guard hook runner", () => {
  it("uses the Claude Code workspace hook command", () => {
    expect(runtimeGuardCommand("a1", "write", "/r")).toBe(buildGuardHookCommand({ port: "0", root: "/r", agentId: "a1", required: true }))
    expect(runtimeGuardCommand("a1", "read", "/r"))
      .toBe(buildGuardHookCommand({ port: "0", root: "/r", agentId: "a1", required: false, budget: READ_GUARD_BUDGET }))
  })

  it("reads deny and ask as a refusal, anything else as allow", () => {
    expect(hookAnswer(DENY)).toEqual({ allow: false, reason: "[agentx-guard] blocked by test rule" })
    expect(hookAnswer(DENY.replace("deny", "ask")).allow).toBe(false)
    expect(hookAnswer("")).toEqual({ allow: true })
    expect(hookAnswer(JSON.stringify({ systemMessage: "warn" }))).toEqual({ allow: true })
  })

  it("refuses a blocked command and passes a safe one", async () => {
    expect(await runGuardHook({ tool: "Bash", input: { command: "rm -rf /srv/data" } }, { agentId: "a1", command: STUB }))
      .toEqual({ allow: false, reason: "[agentx-guard] blocked by test rule" })
    expect(await runGuardHook({ tool: "Bash", input: { command: "ls" } }, { agentId: "a1", command: STUB })).toEqual({ allow: true })
  })

  it("refuses a write call when the command fails, allows a read call", async () => {
    expect((await runGuardHook({ tool: "Bash", input: { command: "ls" } }, { agentId: "a1", command: "exit 3" })).allow).toBe(false)
    expect((await runGuardHook({ tool: "Read", input: { file_path: "x" } }, { agentId: "a1", command: "exit 3" })).allow).toBe(true)
  })
})

/** A fake `codex app-server` that, on turn/start, starts a file change and
 *  asks to run `cmd` and to apply that change, then records the answers. */
function codexFixture(cmd: string, file: string) {
  const requests: any[] = []
  const launch = () => {
    const child: any = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.kill = () => { child.exitCode = 0; child.emit("exit", 0) }
    const send = (v: any) => child.stdout.write(JSON.stringify(v) + "\n")
    const answers = new Map<number, (v: any) => void>()
    child.stdin = new Writable({ write(data, _, done) {
      const m = JSON.parse(data.toString())
      requests.push(m)
      queueMicrotask(async () => {
        if (m.id !== undefined && answers.has(m.id) && !m.method) { answers.get(m.id)!(m); return }
        if (!m.id) return
        send({ id: m.id, result: m.method.startsWith("thread/") ? { thread: { id: "t1" } } : {} })
        if (m.method !== "turn/start") return
        const ask = (id: number, method: string, params: any) => new Promise<any>((resolve) => {
          answers.set(id, resolve)
          send({ id, method, params: { threadId: "t1", turnId: "u1", ...params } })
        })
        send({ method: "item/started", params: { threadId: "t1", item: { type: "fileChange", id: "f1", changes: [{ path: file, kind: "update", diff: "" }] } } })
        await ask(9001, "item/commandExecution/requestApproval", { itemId: "c1", command: cmd, cwd: "/w" })
        await ask(9002, "item/fileChange/requestApproval", { itemId: "f1" })
        await ask(9003, "item/permissions/requestApproval", { itemId: "p1" })
        send({ method: "turn/completed", params: { threadId: "t1", turn: { status: "completed" } } })
      })
      done()
    } })
    return child
  }
  const pool = new CodexProcessPool(launch as any, 2, 10)
  return { pool, requests, answer: (id: number) => requests.find((r) => r.id === id && !r.method) }
}

describe("Codex runs ask the guard before each command and file change", () => {
  const guard = (call: any) => runGuardHook(call, { agentId: "a1", command: STUB })
  const base = { key: "k", cwd: "/w", env: {}, args: [], bypass: true, prompt: "go", timeoutMs: 5000 }

  it("declines a blocked command and a protected file, and asks for approvals", async () => {
    const f = codexFixture("rm -rf /srv/data", "/root/.agentx/operator.key")
    const events: any[] = []
    try {
      await f.pool.run({ ...base, guard, onEvent: (e) => events.push(e) })
      expect(f.requests.find((r) => r.method === "thread/start").params.approvalPolicy).toBe("untrusted")
      expect(f.answer(9001).result).toEqual({ decision: "decline" })
      expect(f.answer(9002).result).toEqual({ decision: "decline" })
      // A request the guard does not answer stays declined.
      expect(f.answer(9003).error).toBeDefined()
      expect(events.filter((e) => e.type === "codex.guard_refused").map((e) => e.tool)).toEqual(["Bash", "Write"])
    } finally { f.pool.stop() }
  })

  it("accepts a command and a file change the guard allows", async () => {
    const f = codexFixture("ls -la", "/w/src/a.ts")
    try {
      await f.pool.run({ ...base, guard })
      expect(f.answer(9001).result).toEqual({ decision: "accept" })
      expect(f.answer(9002).result).toEqual({ decision: "accept" })
    } finally { f.pool.stop() }
  })

  it("keeps approvalPolicy never without a guard (AGENTX_RUNTIME_GUARD=off)", async () => {
    const f = codexFixture("ls", "/w/a")
    try {
      await f.pool.run(base)
      expect(f.requests.find((r) => r.method === "thread/start").params.approvalPolicy).toBe("never")
      expect(f.answer(9001).error).toBeDefined()
    } finally { f.pool.stop() }
  })

  it("refuses network, human-checkpoint and pathless requests", () => {
    const paths = new Map<string, string[]>()
    expect(codexGuardCalls("item/commandExecution/requestApproval", { kind: "humanCommand", command: "ls" }, paths, "/w")!.calls).toEqual([])
    expect(codexGuardCalls("item/commandExecution/requestApproval", { command: "curl x", networkApprovalContext: {} }, paths, "/w")!.calls).toEqual([])
    expect(codexGuardCalls("item/fileChange/requestApproval", { itemId: "unknown" }, paths, "/w")!.calls).toEqual([])
    expect(codexGuardCalls("item/commandExecution/requestApproval", { kind: "writeStdin" }, paths, "/w")!.accept).toBe(true)
  })
})

describe("Codex and OpenCode runtimes (executeTask)", () => {
  let tmp: string
  let oldPath: string | undefined
  let oldCwd: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-runtime-guard-"))
    oldPath = process.env.PATH
    oldCwd = process.cwd()
    process.chdir(tmp)
    delete process.env.AGENTX_RUNTIME_GUARD
  })
  afterEach(() => {
    process.chdir(oldCwd)
    process.env.PATH = oldPath
    delete process.env.AGENTX_RUNTIME_GUARD
    rmSync(tmp, { recursive: true, force: true })
  })

  it("refuses a Codex run instead of falling back to unguarded `codex exec`", async () => {
    const calls = join(tmp, "calls.jsonl")
    writeFileSync(join(tmp, "codex"), `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(2);
`)
    chmodSync(join(tmp, "codex"), 0o755)
    process.env.PATH = `${tmp}:${oldPath || ""}`
    const task: AgentTask = { message: "hi", agentId: "cx" }
    const result = await executeTask(agent(tmp, "codex-cli"), task, {})
    expect(result.error).toMatch(/Codex run refused/)
    expect(readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)[0])).toEqual(["app-server"])
  })

  it("loads the guard plugin into an OpenCode v2 run", async () => {
    const capture = join(tmp, "capture.json")
    writeFileSync(join(tmp, "opencode"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.0.12"); process.exit(0); }
require("fs").writeFileSync(${JSON.stringify(capture)}, process.env.OPENCODE_CONFIG_CONTENT);
console.log(JSON.stringify({ type: "text", sessionID: "s", part: { text: "ok" } }));
`)
    chmodSync(join(tmp, "opencode"), 0o755)
    process.env.PATH = `${tmp}:${oldPath || ""}`
    const result = await executeTask(agent(tmp, "opencode"), { message: "hi", agentId: "oc" }, {})
    expect(result.error).toBeUndefined()
    const config = JSON.parse(readFileSync(capture, "utf8"))
    expect(config.plugins).toHaveLength(1)
    expect(existsSync(join(config.plugins[0], "index.js"))).toBe(true)
    expect(readFileSync(join(config.plugins[0], "index.js"), "utf8")).toContain("/guard/check?agent=oc")
  })

  it("refuses an OpenCode run whose version it cannot read", async () => {
    writeFileSync(join(tmp, "opencode"), `#!/bin/sh\necho "something else"\n`)
    chmodSync(join(tmp, "opencode"), 0o755)
    process.env.PATH = `${tmp}:${oldPath || ""}`
    const result = await executeTask(agent(tmp, "opencode"), { message: "hi", agentId: "oc-unknown" }, {})
    expect(result.error).toMatch(/OpenCode run refused/)
  })
})

describe("the OpenCode guard plugin", () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "agentx-opencode-plugin-")) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  async function load(version: 1 | 2) {
    const change = writeOpenCodeGuardPlugin(tmp, "a1", version, { write: STUB, read: STUB })
    const file = version === 2 ? join(change.entry, "index.js") : new URL(change.entry).pathname
    return { change, mod: await import(pathToFileURL(file).href + `?v=${Date.now()}`) }
  }

  it("v2: stops a blocked shell command and a protected read, runs a safe one", async () => {
    const { change, mod } = await load(2)
    expect(change.key).toBe("plugins")
    let before: ((event: any) => Promise<void>) | undefined
    await mod.default.setup({ location: { directory: tmp }, tool: { hook: async (name: string, cb: any) => { if (name === "execute.before") before = cb } } })
    expect(mod.default.id).toBe("agentx.guard")
    await expect(before!({ tool: "shell", input: { command: "rm -rf /srv/data" } })).rejects.toThrow("[agentx-guard] blocked by test rule")
    await expect(before!({ tool: "read", input: { path: "/x/.agentx/operator.key" } })).rejects.toThrow(/blocked/)
    await expect(before!({ tool: "patch", input: { patchText: "*** Begin Patch\n*** Update File: .agentx/operator.key\n*** End Patch" } })).rejects.toThrow(/blocked/)
    await expect(before!({ tool: "shell", input: { command: "ls" } })).resolves.toBeUndefined()
    await expect(before!({ tool: "webfetch", input: { url: "https://example.com" } })).resolves.toBeUndefined()
  })

  it("v1: stops a blocked bash command through tool.execute.before", async () => {
    const { change, mod } = await load(1)
    expect(change.key).toBe("plugin")
    const hooks = await mod.AgentxGuard({ directory: tmp })
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "rm -rf /srv/data" } })).rejects.toThrow(/blocked/)
    await expect(hooks["tool.execute.before"]({ tool: "edit" }, { args: { filePath: join(tmp, "a.ts") } })).resolves.toBeUndefined()
  })

  it("refuses a shell call when the guard command cannot run", async () => {
    const change = writeOpenCodeGuardPlugin(tmp, "a2", 2, { write: "exit 5", read: "exit 5" })
    const mod = await import(pathToFileURL(join(change.entry, "index.js")).href)
    const p = mod.guard("shell", { command: "ls" }, tmp)
    await expect(p).rejects.toThrow(/could not run/)
    await expect(mod.guard("read", { path: "a" }, tmp)).resolves.toBeUndefined()
  })
})
