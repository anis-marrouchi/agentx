import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { normalizeProject, projectOf, setKnownProjects } from "../src/requests/project"
import { handleRequestsPanel, REQUESTS_PANEL_PREFIX } from "../src/daemon/requests-panel"

// Each request names its project, or none (#2587).

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const KNOWN = [{ project: "noqta/wa-crm", displayName: "WA CRM" }, { project: "muqtana/muqtana-website" }, { project: "ksi" }]

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let now: number

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-requests-project-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  now = 6_000
  setKnownProjects(() => KNOWN)
})
afterEach(() => {
  setKnownProjects(() => [])
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const api = (method: string, p: string, body?: Record<string, unknown>, taskId = "t1", query?: string) =>
  handleRequestsApi(method, p, body, {
    store, tracker, enabled: true, hasAgent: (id) => id === "coder" || id === "ops", now,
    query: new URLSearchParams(query ?? ""),
    runningTurn: (agentId, pr) => ((agentId === "coder" || agentId === "ops") && pr.taskId === taskId ? { channel: "telegram", chatId: `chat-${taskId}` } : null),
  }, { taskId })

function turn(taskId: string, text: string, channel = "telegram", chatId = `chat-${taskId}`) {
  tracker.taskStarted({
    agentId: "coder", channel, chatId, taskId, messagePreview: text, fullMessage: text,
    at: "", humanRoot: true, operator: true, sender: { id: "4242" },
  } as any)
  // Open it, as an accept would.
  db.prepare("UPDATE requests SET state = 'in_progress' WHERE id = ?").run(`req-${taskId}`)
  return `req-${taskId}`
}

describe("projectOf", () => {
  const of = (text: string, channel = "telegram", chatId = "c") => projectOf({ channel, chatId, text }, KNOWN)

  it("is No project (null) when nothing names one", () => {
    expect(of("please fix the login page")).toBeNull()
  })
  it("takes the forge chat a request came from", () => {
    expect(of("anything", "gitlab", "noqta/noqta:issue:12")).toBe("noqta/noqta")
    expect(of("anything", "github", "anis-marrouchi/agentx:pull:7")).toBe("anis-marrouchi/agentx")
  })
  it("takes one forge reference or address in the words", () => {
    expect(of("look at noqta/wa-crm#24 today")).toBe("noqta/wa-crm")
    expect(of("see https://gitlab.noqta.tn/group/sub/proj/-/merge_requests/3")).toBe("group/sub/proj")
    expect(of("see https://github.com/anis-marrouchi/agentx/issues/2587")).toBe("anis-marrouchi/agentx")
    // A known key in another case is that project.
    expect(of("NOQTA/WA-CRM#1")).toBe("noqta/wa-crm")
  })
  it("is not clear with two different references", () => {
    expect(of("noqta/wa-crm#1 and noqta/noqta#2")).toBeNull()
  })
  it("takes one known project's key or name in the words", () => {
    expect(of("the muqtana-website hero is off")).toBe("muqtana/muqtana-website")
    expect(of("something for WA CRM")).toBe("noqta/wa-crm")
    expect(of("call ksi about it")).toBe("ksi")
    expect(of("wa-crm and muqtana-website both")).toBeNull()
  })
})

describe("normalizeProject", () => {
  it("reads none, empty and No project as null, and refuses spaces", () => {
    expect(normalizeProject("none")).toBeNull()
    expect(normalizeProject("")).toBeNull()
    expect(normalizeProject("No project")).toBeNull()
    expect(normalizeProject(" noqta/noqta ")).toBe("noqta/noqta")
    expect(normalizeProject("two words")).toEqual({ error: expect.any(String) })
    expect(normalizeProject(3)).toEqual({ error: expect.any(String) })
  })
})

describe("requests and their project", () => {
  it("default: a new request with no project named has none", () => {
    const id = turn("t1", "fix the login page")
    expect(store.get(id)!.project).toBeNull()
  })

  it("is filled at creation when the words name one", () => {
    const id = turn("t1", "noqta/wa-crm#24: the swimlane is cut")
    expect(store.get(id)!.project).toBe("noqta/wa-crm")
  })

  it("a promise takes its project from its home address", () => {
    store.addPromise({
      id: "p1", channel: "telegram", chatId: "c", agentId: "coder", text: "draft MR", owedTo: "owner",
      home: { kind: "issue", link: "https://gitlab.noqta.tn/noqta/noqta/-/issues/697" }, now,
    })
    expect(store.get("p1")!.project).toBe("noqta/noqta")
  })

  it("an agent moves it with the project action, and back to none", () => {
    const id = turn("t1", "fix the login page")
    let r = api("POST", "/requests", { action: "project", agentId: "coder", project: "ksi" })
    expect(r.status).toBe(200)
    expect(store.get(id)!.project).toBe("ksi")
    // Another agent may move it too, given the id.
    r = api("POST", "/requests", { action: "project", agentId: "ops", id, project: "none" }, "t1")
    expect(r.status).toBe(200)
    expect(store.get(id)!.project).toBeNull()
  })

  it("the project action needs project and refuses a bad key", () => {
    turn("t1", "x")
    expect(api("POST", "/requests", { action: "project", agentId: "coder" }).status).toBe(400)
    expect(api("POST", "/requests", { action: "project", agentId: "coder", project: "two words" }).status).toBe(400)
  })

  it("the owner moves it from the dashboard", async () => {
    const id = turn("t1", "fix the login page")
    const ctx = { root: tmp, requests: store } as any
    let r = await handleRequestsPanel("POST", `${REQUESTS_PANEL_PREFIX}/project`, { id, project: "noqta/noqta" }, ctx)
    expect(r.status).toBe(200)
    expect(store.get(id)!.project).toBe("noqta/noqta")
    r = await handleRequestsPanel("POST", `${REQUESTS_PANEL_PREFIX}/project`, { id, project: null }, ctx)
    expect(r.status).toBe(200)
    expect(store.get(id)!.project).toBeNull()
    r = await handleRequestsPanel("POST", `${REQUESTS_PANEL_PREFIX}/project`, { id: "nope", project: "x" }, ctx)
    expect(r.status).toBe(404)
  })

  it("filters by project and counts each, none included", () => {
    turn("t1", "noqta/wa-crm#1 a")
    turn("t2", "noqta/wa-crm#2 b")
    turn("t3", "ksi c")
    turn("t4", "plain d")
    const byWa = api("GET", "/requests", undefined, "t1", "project=noqta/wa-crm").body as any
    expect(byWa.items.map((r: any) => r.id)).toEqual(["req-t1", "req-t2"])
    const none = api("GET", "/requests", undefined, "t1", "project=none").body as any
    expect(none.items.map((r: any) => r.id)).toEqual(["req-t4"])
    const counts = (api("GET", "/requests/projects").body as any).projects
    expect(counts).toEqual([
      { project: "noqta/wa-crm", count: 2 },
      { project: null, count: 1 },
      { project: "ksi", count: 1 },
    ])
  })
})
