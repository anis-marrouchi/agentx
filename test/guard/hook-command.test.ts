import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import { spawn } from "child_process"
import { createServer, type Server } from "http"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type { AddressInfo } from "net"
import {
  buildGuardHookCommand,
  writeGuardCliLink,
  guardCliLinkPath,
  GUARD_ERROR_MARKER,
  type GuardHookBudget,
} from "../../src/guard/hook-command"

// The seat and the dialog must never run on the fallback path.
vi.mock("../../src/guard/risk", () => ({
  assessRisk: () => {
    throw new Error("seat called")
  },
}))
vi.mock("../../src/guard/confirm", () => ({
  confirmDestructive: () => {
    throw new Error("dialog opened")
  },
}))

const { runRulesOnly } = await import("../../src/guard/check")
const { closeDb } = await import("../../src/storage/sqlite")

// --- A stand-in daemon and a stand-in CLI, driven through the real shell ---

const DAEMON_DENY = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "daemon said no" } })
const CLI_DENY = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "rules said no" } })

let dir: string
let server: Server
let port = ""
let reply: { status: number; body: string; delayMs: number } = { status: 200, body: DAEMON_DENY, delayMs: 0 }

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "guard-hook-"))
  server = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(reply.status)
        res.end(reply.body)
      }, reply.delayMs)
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  port = String((server.address() as AddressInfo).port)
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  reply = { status: 200, body: DAEMON_DENY, delayMs: 0 }
})

/** A port nothing listens on. */
async function deadPort(): Promise<string> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()))
  const p = String((s.address() as AddressInfo).port)
  await new Promise<void>((r) => s.close(() => r()))
  return p
}

/** Write an executable stand-in CLI that sleeps, then prints `out`. */
function stubCli(name: string, out: string, opts: { sleepS?: number; exit?: number } = {}): string {
  const p = path.join(dir, name)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(
    p,
    `#!/bin/sh\ncat >/dev/null\n${opts.sleepS ? `sleep ${opts.sleepS}\n` : ""}printf '%s' '${out}'\nexit ${opts.exit ?? 0}\n`,
  )
  chmodSync(p, 0o755)
  return p
}

const BASE_PATH = "/usr/bin:/bin"
const FAST: GuardHookBudget = { connectS: 1, maxTimeS: 3, deadlineMs: 500 }

interface Run { stdout: string; code: number | null; ms: number }

function runHook(
  command: string,
  payload: string,
  env: Record<string, string> = {},
): Promise<Run> {
  const start = Date.now()
  return new Promise((done) => {
    const child = spawn("/bin/sh", ["-c", command], { env: { PATH: BASE_PATH, HOME: dir, ...env } })
    let stdout = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.on("close", (code) => done({ stdout, code, ms: Date.now() - start }))
    child.stdin.end(payload)
  })
}

const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "x" }, cwd: "/w" })
const write = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/w/a.txt", content: "agentx daemon start" } })
const edit = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/w/a.txt", old_string: "a", new_string: "b" } })

function isDeny(stdout: string): boolean {
  return stdout !== "" && JSON.parse(stdout).hookSpecificOutput?.permissionDecision === "deny"
}

describe("guard hook: daemon path", () => {
  it("passes a 2xx answer through", async () => {
    const cmd = buildGuardHookCommand({ port, root: dir, agentId: "demo-agent", budget: FAST, cliPath: stubCli("c0", CLI_DENY) })
    const r = await runHook(cmd, bash("ls"))
    expect(r.stdout).toBe(DAEMON_DENY)
    expect(r.code).toBe(0)
  })

  it("an empty 2xx is an allow", async () => {
    reply = { status: 200, body: "", delayMs: 0 }
    const cmd = buildGuardHookCommand({ port, root: dir, required: true, budget: FAST, cliPath: stubCli("c1", CLI_DENY) })
    const r = await runHook(cmd, bash("ls"), { AGENTX_GUARD: "required" })
    expect(r.stdout).toBe("")
    expect(r.code).toBe(0)
  })

  it("HTTP 500 → the local check answers", async () => {
    reply = { status: 500, body: "boom", delayMs: 0 }
    const cmd = buildGuardHookCommand({ port, root: dir, budget: FAST, cliPath: stubCli("c2", CLI_DENY) })
    expect((await runHook(cmd, bash("ls"))).stdout).toBe(CLI_DENY)
  })

  it("no listener → the local check answers at once", async () => {
    const cmd = buildGuardHookCommand({ port: await deadPort(), root: dir, budget: FAST, cliPath: stubCli("c3", CLI_DENY) })
    const r = await runHook(cmd, bash("ls"))
    expect(r.stdout).toBe(CLI_DENY)
    expect(r.ms).toBeLessThan(900)
  })

  it("a daemon answering after 3 s but within max-time is used (dialog case)", async () => {
    reply = { status: 200, body: DAEMON_DENY, delayMs: 3200 }
    const cmd = buildGuardHookCommand({
      port, root: dir, budget: { connectS: 1, maxTimeS: 5, deadlineMs: 500 }, cliPath: stubCli("c4", CLI_DENY),
    })
    expect((await runHook(cmd, bash("ls"))).stdout).toBe(DAEMON_DENY)
  }, 10_000)

  it("slow daemon + slow fallback start: the fallback answers inside the hook timeout", async () => {
    reply = { status: 200, body: DAEMON_DENY, delayMs: 5000 }
    const budget = { connectS: 1, maxTimeS: 1, deadlineMs: 500 }
    // Scaled: hook timeout stands in for 75 s against a 55 s max-time.
    const hookTimeoutMs = 4000
    const cmd = buildGuardHookCommand({ port, root: dir, budget, cliPath: stubCli("c5", CLI_DENY, { sleepS: 1 }) })
    const r = await runHook(cmd, bash("ls"))
    expect(r.stdout).toBe(CLI_DENY)
    expect(r.ms).toBeLessThan(hookTimeoutMs)
  }, 10_000)
})

describe("guard hook: local check fails too", () => {
  let dead = ""
  beforeAll(async () => {
    dead = await deadPort()
  })

  const failures: Array<[string, () => { cliPath?: string; env?: Record<string, string> }]> = [
    ["marker", () => ({ cliPath: stubCli("f-marker", GUARD_ERROR_MARKER) })],
    ["missing CLI", () => ({ cliPath: path.join(dir, "nope/agentx-guard") })],
    ["broken link", () => {
      const p = path.join(dir, "f-broken")
      rmSync(p, { force: true })
      symlinkSync(path.join(dir, "gone.js"), p)
      return { cliPath: p }
    }],
    ["agentx on PATH also fails", () => {
      stubCli("pathbin/agentx", "", { exit: 1 })
      return { cliPath: path.join(dir, "nope/agentx-guard"), env: { PATH: `${path.join(dir, "pathbin")}:${BASE_PATH}` } }
    }],
  ]

  for (const [name, setup] of failures) {
    it(`${name}: required session is refused`, async () => {
      const s = setup()
      const cmd = buildGuardHookCommand({ port: dead, root: dir, required: true, budget: FAST, cliPath: s.cliPath })
      const r = await runHook(cmd, bash("ls"), { AGENTX_GUARD: "required", ...s.env })
      expect(isDeny(r.stdout)).toBe(true)
      expect(r.code).toBe(0)
    })

    it(`${name}: a session without AGENTX_GUARD is allowed`, async () => {
      const s = setup()
      const cmd = buildGuardHookCommand({ port: dead, root: dir, required: true, budget: FAST, cliPath: s.cliPath })
      const r = await runHook(cmd, bash("ls"), s.env ?? {})
      expect(r.stdout).toBe("")
      expect(r.code).toBe(0)
    })

    it(`${name}: the attach hook never denies`, async () => {
      const s = setup()
      const cmd = buildGuardHookCommand({ port: dead, root: dir, budget: FAST, cliPath: s.cliPath })
      const r = await runHook(cmd, bash("ls"), { AGENTX_GUARD: "required", ...s.env })
      expect(r.stdout).toBe("")
      expect(r.code).toBe(0)
    })
  }

  it("a broken link falls back to agentx on PATH", async () => {
    stubCli("pathbin2/agentx", CLI_DENY)
    const cmd = buildGuardHookCommand({ port: dead, root: dir, budget: FAST, cliPath: path.join(dir, "nope/agentx-guard") })
    const r = await runHook(cmd, bash("ls"), { PATH: `${path.join(dir, "pathbin2")}:${BASE_PATH}` })
    expect(r.stdout).toBe(CLI_DENY)
  })

  const allowed = [
    "agentx daemon start",
    "  agentx daemon restart --when-idle  ",
    "agentx daemon status",
    "/opt/agentx/dist/cli.js daemon restart",
    "node /opt/agentx/dist/cli.js daemon start",
    "npx tsx ~/agentx/src/cli.ts daemon restart",
    "npx tsx src/cli.ts daemon start",
    "npx tsx src/cli.ts daemon start --detach",
    "agentx daemon start --detach",
    "agentx daemon start -d --config ~/agentx/agentx.json",
    "agentx daemon start --config=/srv/agentx/agentx.json --port 19900",
    "node dist/cli.js daemon restart -c agentx.json",
    "launchctl kickstart -k gui/501/ai.agentx.daemon",
    "launchctl kickstart -k gui/$(id -u)/ai.agentx.daemon",
    "launchctl kickstart -k gui/$UID/ai.agentx.daemon",
    "launchctl bootstrap gui/501 ~/Library/LaunchAgents/ai.agentx.daemon.plist",
    "launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.agentx.daemon.plist",
    "systemctl --user restart agentx",
    "sudo systemctl restart agentx.service",
  ]
  const refused = [
    "ls",
    "agentx daemon start; dropdb x",
    "agentx daemon start && rm -rf ~",
    "agentx daemon start | sh",
    "agentx daemon start > /tmp/x",
    "agentx daemon start\ndropdb x",
    "launchctl kickstart -k gui/$(id -u)/x; dropdb y",
    "launchctl kickstart -k gui/`id -u`/x",
    "launchctl kickstart -k gui/$(whoami)/x",
    "launchctl kickstart -k gui/$HOME/x",
    "agentx daemon start $(id -u)",
    "sudo systemctl stop agentx",
    'agentx daemon start "x"',
    "agentx daemon start --config x; dropdb y",
    "agentx daemon start --config $(id -u)",
    "agentx daemon stop --detach",
  ]

  for (const c of allowed) {
    it(`required session may run: ${JSON.stringify(c)}`, async () => {
      const cmd = buildGuardHookCommand({ port: dead, root: dir, required: true, budget: FAST, cliPath: path.join(dir, "nope/x") })
      const r = await runHook(cmd, bash(c), { AGENTX_GUARD: "required" })
      expect(r.stdout).toBe("")
      expect(r.code).toBe(0)
    })
  }
  for (const c of refused) {
    it(`required session is refused: ${JSON.stringify(c)}`, async () => {
      const cmd = buildGuardHookCommand({ port: dead, root: dir, required: true, budget: FAST, cliPath: path.join(dir, "nope/x") })
      const r = await runHook(cmd, bash(c), { AGENTX_GUARD: "required" })
      expect(isDeny(r.stdout)).toBe(true)
      expect(r.code).toBe(0)
    })
  }

  it("Write and Edit are refused in a required session", async () => {
    const cmd = buildGuardHookCommand({ port: dead, root: dir, required: true, budget: FAST, cliPath: path.join(dir, "nope/x") })
    for (const p of [write, edit]) {
      const r = await runHook(cmd, p, { AGENTX_GUARD: "required" })
      expect(isDeny(r.stdout)).toBe(true)
      expect(r.code).toBe(0)
    }
  })

  it("garbage payload is refused, never exit 2", async () => {
    const cmd = buildGuardHookCommand({ port: dead, root: dir, required: true, budget: FAST, cliPath: path.join(dir, "nope/x") })
    const r = await runHook(cmd, "not json", { AGENTX_GUARD: "required" })
    expect(isDeny(r.stdout)).toBe(true)
    expect(r.code).toBe(0)
  })
})

describe("guard CLI link", () => {
  it("runs the given node on the given cli.js, and exits 127 once cli.js is gone", async () => {
    const root = mkdtempSync(path.join(dir, "root-"))
    const cli = path.join(root, "fake-cli.js")
    writeFileSync(cli, "process.stdout.write(process.argv.slice(2).join(' '))")
    const link = writeGuardCliLink(root, process.execPath, cli)
    expect(link).toBe(guardCliLinkPath(root))
    expect(readFileSync(link, "utf8")).toContain(process.execPath)
    const ok = await runHook(`'${link}' guard check`, "")
    expect(ok.stdout).toBe("guard check")
    rmSync(cli)
    expect((await runHook(`'${link}' guard check`, "")).code).toBe(127)
  })
})

// --- `guard check --rules-only` ---

describe("runRulesOnly", () => {
  let root: string
  const writePolicy = (rel: string, content: string) => {
    const abs = path.join(root, ".agentx/guardrails", rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  beforeEach(() => {
    closeDb()
    root = mkdtempSync(path.join(tmpdir(), "guard-rules-only-"))
    process.env.DATABASE_URL = "postgres://user:pw@api.demosite.example.com:5432/app"
    writePolicy("policy.yaml", "mode: enforce\n")
    writePolicy("environments/production.yaml", "protected_resources:\n  production:\n    resolve_env: true\n    hosts: ['api.demosite.example.com']\n")
  })
  afterEach(() => {
    closeDb()
    delete process.env.DATABASE_URL
    rmSync(root, { recursive: true, force: true })
  })

  it("a Write makes no seat call and opens no dialog", async () => {
    expect(await runRulesOnly(write, { root, agentId: "demo-agent" })).toBe("")
  })

  it("a rules deny is passed through", async () => {
    const out = await runRulesOnly(bash("npx prisma migrate reset --force"), { root, agentId: "demo-agent" })
    expect(isDeny(out)).toBe(true)
  })

  it("a rules ask comes back as a deny", async () => {
    const out = await runRulesOnly(bash("npx prisma migrate deploy"), { root, agentId: "demo-agent" })
    const h = JSON.parse(out).hookSpecificOutput
    expect(h.permissionDecision).toBe("deny")
    expect(h.permissionDecisionReason).toContain("the daemon is not answering")
  })

  it("an internal error or empty input prints the marker", async () => {
    expect(await runRulesOnly("not json", { root })).toBe(GUARD_ERROR_MARKER)
    expect(await runRulesOnly("", { root })).toBe(GUARD_ERROR_MARKER)
  })

  it("past the deadline prints the marker", async () => {
    expect(await runRulesOnly(bash("ls"), { root, started: Date.now() - 10_000, deadlineMs: 100 })).toBe(GUARD_ERROR_MARKER)
  })
})
