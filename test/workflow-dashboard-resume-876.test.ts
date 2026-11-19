import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PassThrough } from "stream"
import type { IncomingMessage, ServerResponse } from "http"
import { handleWorkflowsApi, resumeRunViaDaemon, type WorkflowsApiDeps } from "../src/daemon/workflows-api"
import { LayoutStore, RunStore, WorkflowStore } from "../src/workflows"

// #876: the board dashboard serves POST /api/workflows/runs/:id/status but
// has no dispatcher, so Resume answered 501 after #1948. It now hands the
// resume to the daemon's POST /workflow-runs/:id/resume.

let dir: string
let runs: RunStore
const RUN_ID = "run-876-dash"

function call(extra: Partial<WorkflowsApiDeps>, body: unknown, runId = RUN_ID): Promise<{ status: number; body: any }> {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough
  req.method = "POST"
  req.url = `/api/workflows/runs/${runId}/status`
  return new Promise((done) => {
    let status = 0
    const res = {
      writeHead(s: number) { status = s },
      end(text: string) { done({ status, body: JSON.parse(text) }) },
    } as unknown as ServerResponse
    handleWorkflowsApi(req, res, {
      store: new WorkflowStore({ baseDir: dir }),
      runs,
      layouts: new LayoutStore({ baseDir: dir }),
      requireScope: () => true,
      ...extra,
    })
    req.end(JSON.stringify(body))
  })
}

function fakeFetch(status: number, data: unknown, seen: Array<{ url: string; init: any }>): typeof fetch {
  return (async (url: any, init: any) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-dash-resume-"))
  runs = new RunStore({ baseDir: dir })
  runs.create({ id: RUN_ID, workflowId: "wf", initialPending: [], entityRef: { kind: "manual", id: "t" } as any })
  runs.setStatus(RUN_ID, "paused")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("dashboard Resume without a dispatcher (#876)", () => {
  it("still answers 501 when neither a dispatcher nor resumeRun is given", async () => {
    const r = await call({}, { status: "running" })
    expect(r.status).toBe(501)
  })

  it("hands the resume to the daemon with the dashboard token", async () => {
    const seen: Array<{ url: string; init: any }> = []
    const resumeRun = resumeRunViaDaemon("http://127.0.0.1:18800/", "tok", fakeFetch(200, { ok: true, action: "walked" }, seen))
    const r = await call({ resumeRun }, { status: "running" })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, runId: RUN_ID, status: "running", action: "walked" })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(`http://127.0.0.1:18800/workflow-runs/${RUN_ID}/resume`)
    expect(seen[0].init.method).toBe("POST")
    expect(seen[0].init.headers.Authorization).toBe("Bearer tok")
  })

  it("passes on the daemon's refusal as 409", async () => {
    const seen: Array<{ url: string; init: any }> = []
    const resumeRun = resumeRunViaDaemon("http://127.0.0.1:18800", undefined, fakeFetch(409, { error: "run has ended" }, seen))
    const r = await call({ resumeRun }, { status: "running" })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe("run has ended")
    expect(seen[0].init.headers.Authorization).toBeUndefined()
  })

  it("answers 502 when the daemon cannot be reached", async () => {
    const down = (async () => { throw new Error("connect ECONNREFUSED") }) as unknown as typeof fetch
    const r = await call({ resumeRun: resumeRunViaDaemon("http://127.0.0.1:1", undefined, down) }, { status: "running" })
    expect(r.status).toBe(502)
    expect(r.body.message).toContain("ECONNREFUSED")
  })

  it("does not call the daemon for an unknown run", async () => {
    const seen: Array<{ url: string; init: any }> = []
    const resumeRun = resumeRunViaDaemon("http://127.0.0.1:18800", undefined, fakeFetch(200, { ok: true }, seen))
    const r = await call({ resumeRun }, { status: "running" }, "no-such-run")
    expect(r.status).toBe(404)
    expect(seen).toHaveLength(0)
  })
})
