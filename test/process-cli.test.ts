import { describe, it, expect } from "vitest"
import { spawn } from "child_process"
import { createServer, type Server } from "http"
import path from "path"

const projectRoot = path.resolve(__dirname, "..")
const cliPath = path.resolve(projectRoot, "src/cli.ts")

/**
 * Run the CLI via tsx and wait for it to exit. Async — execFileSync
 * would block the test Node thread, preventing the HTTP server in
 * `withServer` from accepting the CLI's connection (deadlock).
 */
function runCli(args: string[]): Promise<{ stdout: string; status: number }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", cliPath, ...args], {
      cwd: projectRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.on("data", (c) => { out += c.toString() })
    child.stderr.on("data", (c) => { out += c.toString() })
    child.on("close", (code) => resolve({ stdout: out, status: code ?? 0 }))
  })
}

/** Stand up a tiny HTTP server that returns scripted JSON, so the CLI can
 *  be exercised end-to-end without the full daemon. */
async function withServer(handler: (req: any, res: any) => void, fn: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  try {
    await fn(port)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// Each test spawns `npx tsx` which takes 3-8s to cold-start; the default
// 5s per-test timeout is tight when the full suite runs concurrently.
const SUBPROCESS_TIMEOUT_MS = 30_000

describe("agentx process CLI", () => {
  it("list against an unreachable daemon exits non-zero with a friendly message", async () => {
    // Port 1 is reserved/refused on every modern OS — fast failure.
    const r = await runCli(["process", "list", "--node", "http://127.0.0.1:1"])
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/could not reach daemon/)
  }, SUBPROCESS_TIMEOUT_MS)

  it("list against a daemon with no persistent agents shows the friendly 503 message", async () => {
    await withServer(
      (req, res) => {
        if (req.method === "GET" && req.url === "/api/processes") {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "process registry not enabled" }))
          return
        }
        res.writeHead(404).end()
      },
      async (port) => {
        const r = await runCli(["process", "list", "--node", `http://127.0.0.1:${port}`])
        // 503 isn't an error from the CLI's perspective — the daemon is up,
        // just no persistent agents — so exit 0 with a dim hint.
        expect(r.status).toBe(0)
        expect(r.stdout).toMatch(/no agents with persistentProcess/)
      },
    )
  }, SUBPROCESS_TIMEOUT_MS)

  it("list --json returns the registry snapshot verbatim", async () => {
    const fakeProcs = [
      {
        key: { agentId: "atlas", channel: "telegram", chatId: "c1" },
        pid: 12345,
        claudeSessionId: "sess-abc",
        state: "idle",
        spawnedAt: Date.now() - 60_000,
        lastTurnAt: Date.now() - 5_000,
        turnCount: 3,
        lastInputTokens: 42,
        pendingTaskId: null,
      },
    ]
    await withServer(
      (req, res) => {
        if (req.method === "GET" && req.url === "/api/processes") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ processes: fakeProcs }))
          return
        }
        res.writeHead(404).end()
      },
      async (port) => {
        const r = await runCli(["process", "list", "--node", `http://127.0.0.1:${port}`, "--json"])
        expect(r.status).toBe(0)
        const parsed = JSON.parse(r.stdout)
        expect(parsed).toEqual(fakeProcs)
      },
    )
  }, SUBPROCESS_TIMEOUT_MS)

  it("kill posts the right body and reports success on 200", async () => {
    let receivedBody: any = null
    await withServer(
      (req, res) => {
        if (req.method === "POST" && req.url === "/api/processes/kill") {
          let buf = ""
          req.on("data", (c: Buffer) => (buf += c.toString()))
          req.on("end", () => {
            receivedBody = JSON.parse(buf)
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ killed: receivedBody }))
          })
          return
        }
        res.writeHead(404).end()
      },
      async (port) => {
        const r = await runCli(["process", "kill", "atlas", "telegram", "c1", "--node", `http://127.0.0.1:${port}`, "--reason", "test"])
        expect(r.status).toBe(0)
        expect(r.stdout).toMatch(/killed atlas:telegram:c1/)
        expect(receivedBody).toEqual({ agentId: "atlas", channel: "telegram", chatId: "c1", reason: "test" })
      },
    )
  }, SUBPROCESS_TIMEOUT_MS)

  it("kill against 503 surfaces the friendly message", async () => {
    await withServer(
      (req, res) => {
        if (req.method === "POST" && req.url === "/api/processes/kill") {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "process registry not enabled" }))
          return
        }
        res.writeHead(404).end()
      },
      async (port) => {
        const r = await runCli(["process", "kill", "x", "y", "z", "--node", `http://127.0.0.1:${port}`])
        expect(r.status).toBe(0)
        expect(r.stdout).toMatch(/no persistent-process registry/)
      },
    )
  }, SUBPROCESS_TIMEOUT_MS)
})
