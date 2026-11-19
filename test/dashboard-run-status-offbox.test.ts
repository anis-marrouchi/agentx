import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { RunStore, WorkflowStore } from "../src/workflows"

// #1948 follow-up: with no dashboard.token, POST /api/workflows/runs/<id>/status
// let any caller pause or cancel a run. A write from another machine with no
// token is now refused; the local dashboard keeps working without one. The
// test server listens on loopback, so an off-box caller is a forwarded request.

const OFF = { "X-Forwarded-For": "100.64.0.9" }

let server: Server | undefined
let dir = ""

async function start(): Promise<{ base: string; runs: RunStore; runId: string }> {
  dir = mkdtempSync(join(tmpdir(), "agentx-run-status-offbox-"))
  const runs = new RunStore({ baseDir: dir, nodeId: "node-a" })
  const runId = runs.create({ workflowId: "wf", initialPending: ["a"], entityRef: { backend: "manual", id: "e-1" } }).id
  const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: "http://daemon.invalid:18800" } })
  const ctx = { boards: [], sources: new Map(), token: undefined, config, workflowStore: new WorkflowStore({ baseDir: dir }), workflowRuns: runs } as unknown as Ctx
  server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, runs, runId }
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const post = (base: string, runId: string, status: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/workflows/runs/${runId}/status`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Requested-With": "agentx-board" }, body: JSON.stringify({ status }),
  })

describe("run status change without dashboard.token (#1948)", () => {
  it("refuses an off-box caller with no token and leaves the run alone", async () => {
    const { base, runs, runId } = await start()
    const before = runs.get(runId)!.status
    for (const status of ["paused", "canceled", "running"]) {
      expect((await post(base, runId, status, OFF)).status).toBe(401)
    }
    expect(runs.get(runId)!.status).toBe(before)
  })

  it("lets a loopback caller change it", async () => {
    const { base, runs, runId } = await start()
    const res = await post(base, runId, "paused")
    expect(res.status).toBe(200)
    expect(runs.get(runId)!.status).toBe("paused")
  })

  it("still lets an off-box caller read runs", async () => {
    const { base, runId } = await start()
    expect((await fetch(`${base}/api/workflows/runs/${runId}`, { headers: OFF })).status).not.toBe(401)
  })
})
