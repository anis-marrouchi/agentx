import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi, type RequestsApiDeps } from "../src/requests/daemon-api"
import { issueCloseWhen } from "../src/requests/promise"
import { CatchLog, catchSettingsOf, DEFAULT_CATCH_SETTINGS, PromiseCatcher } from "../src/requests/catch"
import { defaultForgeOf } from "../src/requests/drift/live"

// noqta#876 step 5: a promise that names an issue closes by itself when a
// later note on that issue carries its id. Before, only promises caught
// from a reply got the checker, and only when the words held a full web
// address. Promises made with the tool, and "noqta/noqta#877", got none.

const T0 = Date.parse("2030-03-01T12:00:00Z")

describe("issueCloseWhen reads short refs", () => {
  it("a full address still wins, as before", () => {
    expect(issueCloseWhen("see https://gitlab.example.com/grp/proj/-/issues/9 and grp/other#3", "prm-1", 7, { forge: "gitlab" }))
      .toMatchObject({ provider: "gitlab", ref: "https://gitlab.example.com/grp/proj/-/issues/9" })
  })

  it("group/project#12 goes to the node's forge outside a forge chat", () => {
    expect(issueCloseWhen("I will post the result on noqta/noqta#877 by 16:00Z.", "prm-2", 7, { channel: "a2a", chatId: "a2a:x", forge: "gitlab" })).toEqual({
      kind: "issue", provider: "gitlab", ref: "noqta/noqta#877", notePattern: "prm-2", after: 7,
    })
    expect(issueCloseWhen("review acme/app#12 today", "prm-3", 7, { forge: "github" })).toMatchObject({ provider: "github", ref: "acme/app#12" })
    // No forge set up: no checker, rather than a wrong one.
    expect(issueCloseWhen("post it on noqta/noqta#877", "prm-4", 7, {})).toBeNull()
  })

  it("group/project!12 is a GitLab merge request whatever the node's forge", () => {
    expect(issueCloseWhen("deploy once grp/sub/proj!40 is merged", "prm-5", 7, { forge: "github" })).toMatchObject({ provider: "gitlab", ref: "grp/sub/proj!40" })
  })

  it("a forge chat gives its own forge to a short ref, and its project to a bare number", () => {
    const gl = { channel: "gitlab", chatId: "noqta/noqta:issue:876", forge: "github" as const }
    expect(issueCloseWhen("post the count on noqta/noqta#877", "prm-6", 7, gl)).toMatchObject({ provider: "gitlab", ref: "noqta/noqta#877" })
    expect(issueCloseWhen("I will post the result on issue 877", "prm-7", 7, gl)).toMatchObject({ provider: "gitlab", ref: "noqta/noqta#877" })
    expect(issueCloseWhen("result in #877 tonight", "prm-8", 7, gl)).toMatchObject({ ref: "noqta/noqta#877" })
    expect(issueCloseWhen("MR 41 ready by noon", "prm-9", 7, gl)).toMatchObject({ ref: "noqta/noqta!41" })
    const gh = { channel: "github", chatId: "acme/app:pull:3" }
    expect(issueCloseWhen("fix lands in PR 12", "prm-10", 7, gh)).toMatchObject({ provider: "github", ref: "acme/app#12" })
  })

  it("names nothing it cannot read", () => {
    // A bare number outside a forge chat has no project.
    expect(issueCloseWhen("I will post it on issue 877", "prm-11", 7, { channel: "telegram", chatId: "42", forge: "gitlab" })).toBeNull()
    // A path inside an address, a heading anchor, an email: not refs.
    expect(issueCloseWhen("see https://example.com/docs/setup#3", "prm-12", 7, { forge: "gitlab" })).toBeNull()
    expect(issueCloseWhen("mail ops@acme/app#2", "prm-13", 7, { forge: "gitlab" })).toBeNull()
    expect(issueCloseWhen("send the deck by noon, 3 items", "prm-14", 7, { channel: "gitlab", chatId: "a/b:issue:1" })).toBeNull()
    // GitHub has no "!" merge requests and only owner/repo.
    expect(issueCloseWhen("see a/b/c#3", "prm-15", 7, { forge: "github" })).toBeNull()
  })
})

describe("defaultForgeOf", () => {
  const cfg = (channels: Record<string, unknown>, checkers: Record<string, unknown> = {}) => ({ channels, requests: { checkers } }) as any
  it("is GitLab when set up, else GitHub, else none", () => {
    expect(defaultForgeOf(cfg({ gitlab: { host: "https://gl.example.com" }, github: { token: "t" } }))).toBe("gitlab")
    expect(defaultForgeOf(cfg({ github: { token: "t" } }))).toBe("github")
    expect(defaultForgeOf(cfg({}, { gitlab: { url: "https://gl.example.com" } }))).toBe("gitlab")
    expect(defaultForgeOf(cfg({}))).toBeNull()
  })
})

describe("every promise that names an issue gets the checker", () => {
  const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
  let tmp: string
  let db: Database.Database
  let store: RequestStore
  let tracker: RequestTracker

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-prm-check-876-"))
    db = new Database(path.join(tmp, "db.sqlite"))
    store = new RequestStore(db)
    tracker = new RequestTracker(store, () => ({ ...settings, catchPromises: { ...DEFAULT_CATCH_SETTINGS, enabled: true } }), () => {}, () => T0)
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const deps = (over: Partial<RequestsApiDeps> = {}): RequestsApiDeps => ({
    store, tracker, enabled: true, now: T0, defaultForge: "gitlab",
    hasAgent: (id) => ["coder", "pm"].includes(id),
    runningTurn: () => ({ channel: "a2a", chatId: "a2a:pm:coder:dlg-1" }),
    ...over,
  })
  const promise = (body: Record<string, unknown>, over: Partial<RequestsApiDeps> = {}) =>
    handleRequestsApi("POST", "/requests", { agentId: "coder", action: "promise", owedTo: "pm", ...body }, deps(over)) as { status: number; body: any }

  it("a promise made with the tool gets the note checker (the TC #877 step 5 case)", () => {
    const res = promise({ text: "Post the step 6 count on noqta/noqta#877" })
    expect(res.status).toBe(200)
    const id = res.body.request.id
    expect(store.get(id)!.closeWhen).toEqual({ kind: "issue", provider: "gitlab", ref: "noqta/noqta#877", notePattern: id, after: T0 })
  })

  it("a full address in the tool's words works too", () => {
    const { body } = promise({ text: "Post it on https://github.com/acme/app/issues/7" })
    expect(store.get(body.request.id)!.closeWhen).toMatchObject({ provider: "github", ref: "https://github.com/acme/app/issues/7" })
  })

  it("the agent's own closeWhen is kept, and words naming no issue get none", () => {
    const own = { kind: "issue", provider: "gitlab", ref: "grp/proj#1", state: "closed" }
    const a = promise({ text: "Close noqta/noqta#877", closeWhen: own })
    expect(store.get(a.body.request.id)!.closeWhen).toMatchObject({ ref: "grp/proj#1", state: "closed" })
    const b = promise({ text: "Send the deck by noon" })
    expect(store.get(b.body.request.id)!.closeWhen).toBeNull()
  })

  it("a node with no forge set up gives a short ref no checker", () => {
    const { body } = promise({ text: "Post it on noqta/noqta#877" }, { defaultForge: null })
    expect(store.get(body.request.id)!.closeWhen).toBeNull()
  })

  it("a caught promise with a short ref gets the checker", async () => {
    const settled: Array<Promise<unknown>> = []
    const what = "Post the step 6 count on noqta/noqta#877"
    const catcher = new PromiseCatcher({
      store, log: new CatchLog(db), now: () => T0, say: () => {}, defaultForge: () => "gitlab",
      settings: () => catchSettingsOf({ ...settings, catchPromises: { ...DEFAULT_CATCH_SETTINGS, enabled: true } }),
      generate: async () => JSON.stringify({ kind: "promise", quote: `I'll post the step 6 count on noqta/noqta#877.`, what, due: null, question: null }),
    })
    const ended = catcher.turnEnded.bind(catcher)
    catcher.turnEnded = (t) => { const r = ended(t); if (r) settled.push(r.settled); return r }
    tracker.setCatcher(catcher)
    tracker.taskStarted({
      agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: "count it", fullMessage: "count it",
      at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
    tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", durationMs: 1, at: "", finalResponse: "Noted. I'll post the step 6 count on noqta/noqta#877." } as any)
    await Promise.all(settled)
    const p = store.listOpen().find((r) => r.promise && r.agentId === "coder")
    expect(p).toBeDefined()
    expect(p!.closeWhen).toMatchObject({ kind: "issue", provider: "gitlab", ref: "noqta/noqta#877", notePattern: p!.id })
  })
})
