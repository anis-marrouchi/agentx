// Runs scripts/ui-evidence.mjs against a mock GitHub API, for the paths that
// live in the CLI and not in the lib: the re-read before posting and the
// check run posted on API errors.
import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const SCRIPT = fileURLToPath(new URL("../scripts/ui-evidence.mjs", import.meta.url))
const SHA = "a".repeat(40)
const IMG = "https://github.com/user-attachments/assets/0b3c6f6e-1d2a-4b8e-9c3f-5a6b7c8d9e0f"
const WITH_EVIDENCE = `## Evidence\n\n![after](${IMG}.png)\n`

type Pull = { body: string; labels: string[]; headSha?: string }
type Mock = {
  /** One entry per GET /pulls/N; the last one repeats. */
  pulls: Pull[]
  filesStatus?: number
  checkStatus?: number
}

let server: Server | undefined
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())))

async function runCli(mock: Mock, mode: string) {
  const checks: { conclusion: string; output: { title: string; summary: string } }[] = []
  let pullReads = 0
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://mock")
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      }
      if (req.method === "GET" && url.pathname === "/repos/o/r/pulls/7") {
        const p = mock.pulls[Math.min(pullReads++, mock.pulls.length - 1)]
        return send(200, { body: p.body, labels: p.labels.map((name) => ({ name })), head: { sha: p.headSha ?? SHA } })
      }
      if (req.method === "GET" && url.pathname === "/repos/o/r/pulls/7/files") {
        if (mock.filesStatus) return send(mock.filesStatus, { message: "Bad Gateway" })
        return send(200, [{ filename: "src/web/canvas.ts" }])
      }
      if (req.method === "POST" && url.pathname === "/repos/o/r/check-runs") {
        if (mock.checkStatus) return send(mock.checkStatus, { message: "Resource not accessible by integration" })
        checks.push(JSON.parse(raw))
        return send(201, {})
      }
      send(404, { message: "Not Found" })
    })
  })
  await new Promise<void>((ready) => server!.listen(0, "127.0.0.1", ready))
  const { port } = server.address() as AddressInfo
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    UI_EVIDENCE_MODE: mode,
  }
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, [SCRIPT, "--pr", "7", "--post-check", SHA], { env }, (err, stdout, stderr) => {
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    })
  })
  return { ...result, checks, pullReads }
}

describe("ui-evidence CLI: re-read before posting", () => {
  it("judges the description as it is just before posting", async () => {
    const r = await runCli({ pulls: [{ body: "", labels: [] }, { body: WITH_EVIDENCE, labels: [] }] }, "required")
    expect(r.pullReads).toBe(2)
    expect(r.code).toBe(0)
    expect(r.checks).toHaveLength(1)
    expect(r.checks[0].conclusion).toBe("success")
    expect(r.checks[0].output.title).toBe("Evidence found (1)")
  })

  it("re-judges when only the labels changed", async () => {
    const r = await runCli(
      { pulls: [{ body: "UI evidence: not needed because only spacing changed.", labels: [] }, { body: "UI evidence: not needed because only spacing changed.", labels: ["no-ui-evidence-needed"] }] },
      "required",
    )
    expect(r.code).toBe(0)
    expect(r.checks[0].conclusion).toBe("success")
    expect(r.checks[0].output.title).toBe("Overridden: no UI evidence needed")
  })

  it("posts nothing when the head moved between the two reads", async () => {
    const r = await runCli({ pulls: [{ body: "", labels: [] }, { body: WITH_EVIDENCE, labels: [], headSha: "b".repeat(40) }] }, "required")
    expect(r.checks).toHaveLength(0)
    expect(r.stdout).toContain("has moved on to")
  })

  it("does not read again when the head had already moved", async () => {
    const r = await runCli({ pulls: [{ body: WITH_EVIDENCE, labels: [], headSha: "b".repeat(40) }] }, "required")
    expect(r.pullReads).toBe(1)
    expect(r.checks).toHaveLength(0)
  })
})

describe("ui-evidence CLI: switched off", () => {
  it("still posts a success check without reading the PR", async () => {
    const r = await runCli({ pulls: [{ body: "", labels: [] }], filesStatus: 502 }, "off")
    expect(r.code).toBe(0)
    expect(r.pullReads).toBe(0)
    expect(r.checks).toHaveLength(1)
    expect(r.checks[0].conclusion).toBe("success")
    expect(r.checks[0].output.title).toBe("Switched off")
  })
})

describe("ui-evidence CLI: API errors", () => {
  it("posts a failure in required mode and exits 2", async () => {
    const r = await runCli({ pulls: [{ body: WITH_EVIDENCE, labels: [] }], filesStatus: 502 }, "required")
    expect(r.code).toBe(2)
    expect(r.checks).toHaveLength(1)
    expect(r.checks[0].conclusion).toBe("failure")
    expect(r.checks[0].output.title).toBe("Could not run the check")
    expect(r.checks[0].output.summary).toContain("502")
    expect(r.stderr).toContain("ui-evidence:")
  })

  it("posts neutral in advisory mode and exits 2", async () => {
    const r = await runCli({ pulls: [{ body: WITH_EVIDENCE, labels: [] }], filesStatus: 502 }, "advisory")
    expect(r.code).toBe(2)
    expect(r.checks[0].conclusion).toBe("neutral")
    expect(r.checks[0].output.title).toBe("Could not run the check")
  })

  it("still exits 2 with a warning when posting the check also fails", async () => {
    const r = await runCli({ pulls: [{ body: WITH_EVIDENCE, labels: [] }], filesStatus: 502, checkStatus: 403 }, "required")
    expect(r.code).toBe(2)
    expect(r.checks).toHaveLength(0)
    expect(r.stdout).toContain("Could not post the ui-evidence check run")
  })
})
