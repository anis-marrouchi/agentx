import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsPanel, requestHomePath } from "../src/daemon/requests-panel"
import { renderRequestPage } from "../src/daemon/ui/pages/request"
import { renderTaskPage } from "../src/daemon/ui/pages/task"

// One home for a task (#1170): /requests/:id, found from the request's id,
// a run's trace id or the issue the work lives in.

const settings: RequestSettings = { enabled: true, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 }
const HOME = "/api/admin/approvals/requests/home"

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
const clock = Date.parse("2026-10-02T10:00:00Z")

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-request-home-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, final_response TEXT)")
  store = new RequestStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ctx = () => {
  const configPath = path.join(tmp, "agentx.json")
  writeFileSync(configPath, JSON.stringify({ node: { id: "n", name: "n" }, agents: { coder: { name: "Coder" } }, requests: { enabled: true } }))
  return { root: tmp, requests: store, now: clock, configPath, reload: false }
}

/** A request from a run that timed out: it stays open, needing attention. */
function asked(taskId: string) {
  tracker.taskStarted({ agentId: "coder", channel: "voice", chatId: "mac", taskId, messagePreview: "", fullMessage: "Build the weekly report.", at: "", humanRoot: true, operator: true } as any)
  tracker.taskCompleted({ agentId: "coder", channel: "voice", chatId: "mac", taskId, durationMs: 1, error: "Task timed out after 60 minutes", at: "" } as any)
  const id = store.listOpen()[0]?.id
  if (!id) throw new Error("no request was made")
  return id
}

describe("the request home lookup", () => {
  it("finds a request by id and by the run that started it, with its links and its page", async () => {
    const id = asked("t1")
    const byId = await handleRequestsPanel("GET", HOME, { id }, ctx())
    expect(byId.status).toBe(200)
    const body = byId.body as any
    expect(body.item.id).toBe(id)
    expect(body.item.summary).toBe("Build the weekly report.")
    expect(body.url).toBe(`/requests/${id}`)
    expect(body.links.some((l: any) => l.kind === "run")).toBe(true)

    const run = body.links.find((l: any) => l.kind === "run").ref
    const byRun = await handleRequestsPanel("GET", HOME, { run }, ctx())
    expect((byRun.body as any).item.id).toBe(id)
  })

  it("finds a request from the issue its work lives in", async () => {
    const id = asked("t2")
    store.setHome(id, { kind: "issue", link: "https://forge.example.test/demo/shop/-/issues/7" }, clock)
    const r = await handleRequestsPanel("GET", HOME, { issue: "https://forge.example.test/demo/shop/-/issues/7" }, ctx())
    expect((r.body as any).item.id).toBe(id)
  })

  it("keeps a closed request's home: the page outlives the work", async () => {
    const id = asked("t3")
    store.close(id, "done", "shipped", clock)
    const r = await handleRequestsPanel("GET", HOME, { id }, ctx())
    expect(r.status).toBe(200)
    expect((r.body as any).item.state).toBe("done")
  })

  it("answers 404 for a run with no request, and for no question at all", async () => {
    expect((await handleRequestsPanel("GET", HOME, { run: "nothing" }, ctx())).status).toBe(404)
    expect((await handleRequestsPanel("GET", HOME, {}, ctx())).status).toBe(404)
  })

  it("encodes the id in the page path", () => {
    expect(requestHomePath("req-a/b")).toBe("/requests/req-a%2Fb")
  })
})

describe("the request page and the views that link to it", () => {
  it("escapes the id it is given", () => {
    const html = renderRequestPage({ requestId: `req-"><script>x</script>` })
    expect(html).not.toContain("<script>x</script>")
    expect(html).toContain("/api/admin/approvals/requests/home?id=")
  })

  it("the task page looks up its request from the run's trace id", () => {
    const html = renderTaskPage({ taskId: "1700000000000", traceId: "trace-9", agentId: "coder", nodeUrl: "http://127.0.0.1:18800" })
    expect(html).toContain('id="task-home"')
    expect(html).toContain('"run":"trace-9"')
  })

  it("a finished run's task id is its trace id", () => {
    const html = renderTaskPage({ taskId: "trace-5", agentId: "coder", nodeUrl: "http://127.0.0.1:18800", archived: true })
    expect(html).toContain('"run":"trace-5"')
  })
})
