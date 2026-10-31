import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn } from "child_process"
import { createServer } from "net"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"

const projectRoot = path.resolve(__dirname, "..")
const cliPath = path.resolve(projectRoot, "src/cli.ts")

// `agentx daemon status` against a port nothing listens on: the stopped
// block still carries the Computer use line, in text and JSON (#1595).
// Not port 1: fetch blocks it before connecting, so it never reads as refused.
function runStatus(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "--tsconfig", path.join(projectRoot, "tsconfig.json"), cliPath, "daemon", "status", "-c", path.join(cwd, "agentx.json"), ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0", XDG_SESSION_TYPE: "x11" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.on("data", (c) => { out += c.toString() })
    child.stderr.on("data", (c) => { out += c.toString() })
    child.on("close", () => resolve(out))
  })
}

// A port that was free a moment ago, so a connect is refused.
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

let dir: string
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "agentx-status-cli-"))
  const bind = `127.0.0.1:${await closedPort()}`
  writeFileSync(path.join(dir, "agentx.json"), JSON.stringify({ node: { id: "n1", name: "Test", bind }, agents: {}, crons: {} }))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("agentx daemon status with the daemon stopped", () => {
  it("prints the Computer use line", async () => {
    const out = await runStatus(dir, [])
    expect(out).toMatch(/Start with: agentx daemon start/)
    expect(out).toMatch(/Computer use\s+\S/)
  }, 30_000)

  it("puts computerUse in the JSON", async () => {
    const out = await runStatus(dir, ["--json"])
    const data = JSON.parse(out.slice(out.indexOf("{")))
    expect(data.status).toBe("stopped")
    expect(data.computerUse).toMatchObject({ os: expect.any(String) })
  }, 30_000)
})
