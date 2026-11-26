import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { checkProofLink, type ProofLinkResult } from "../src/requests/proof-link"
import { checkProofLinks, DEFAULT_PROOF_CHECK, proofChecker, type ProofCheckSettings } from "../src/requests/proof-check"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsCall, type RequestsApiDeps } from "../src/requests/daemon-api"
import { attachPromiseFacts, DEFAULT_PROMISE_SETTINGS, type PromiseSettings } from "../src/requests/promise"
import { FactLedger } from "../src/wiki/facts/ledger"
import { requestsConfigSchema } from "../src/daemon/config"

// #2122 PR 2: proof links opened on a close. No network: every fetch is mocked.

const page = (status: number, body = "ok") => (async () => new Response(body, { status })) as unknown as typeof fetch

describe("a page that answers non-2xx (review C1)", () => {
  for (const status of [401, 403, 407, 429, 500, 502, 503]) {
    it(`HTTP ${status} is unverifiable: the page could not be read`, async () => {
      const r = await checkProofLink("https://docs.example.com/x", "done", { fetch: page(status) })
      expect(r.state).toBe("unverifiable")
      expect(r.firm).toBeUndefined()
      expect(r.detail).toContain(`HTTP ${status}`)
    })
  }

  for (const status of [404, 410]) {
    it(`HTTP ${status} is a firm failure: the page is gone`, async () => {
      expect(await checkProofLink("https://docs.example.com/x", "done", { fetch: page(status) }))
        .toEqual({ state: "failed", detail: `https://docs.example.com/x answered HTTP ${status}`, firm: true })
    })
  }

  it("a ref not found on the page fails, but not firmly (review C2)", async () => {
    const r = await checkProofLink("https://docs.example.com/x", "shipped #42", { fetch: page(200, "nothing here") })
    expect(r.state).toBe("failed")
    expect(r.firm).toBeUndefined()
  })
})

describe("checkProofLinks (review C2, C3)", () => {
  const settings = (over: Partial<ProofCheckSettings> = {}): ProofCheckSettings => ({ ...DEFAULT_PROOF_CHECK, mode: "warn", ...over })
  const answers = (table: Record<string, ProofLinkResult>, opened: string[] = []) =>
    (async (link: string) => { opened.push(link); return table[link] }) as typeof checkProofLink

  it("opens at most maxLinks, names the rest as not checked, and is not verified then", async () => {
    const opened: string[] = []
    const ok = { state: "verified" as const, detail: "fine" }
    const out = await checkProofLinks(["https://a/1", "https://a/2", "https://a/3", "https://a/1"], "done", {}, settings({ maxLinks: 2 }),
      answers({ "https://a/1": ok, "https://a/2": ok, "https://a/3": ok }, opened))
    expect(opened).toEqual(["https://a/1", "https://a/2"])
    expect(out!.verify.state).toBe("unverified")
    expect(out!.verify.detail).toContain("1 more link not checked (limit 2 per close)")
  })

  it("is verified only when every link showed it", async () => {
    const ok = { state: "verified" as const, detail: "a is merged" }
    expect((await checkProofLinks(["https://a/1"], "merged", {}, settings(), answers({ "https://a/1": ok })))!.verify)
      .toEqual({ state: "verified", detail: "Link checked: a is merged" })
  })

  it("opens the links at the same time", async () => {
    let running = 0
    let most = 0
    const slow = (async () => {
      running++; most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return { state: "verified", detail: "ok" }
    }) as typeof checkProofLink
    await checkProofLinks(["https://a/1", "https://a/2", "https://a/3"], "done", {}, settings(), slow)
    expect(most).toBe(3)
  })

  it("stops the whole check at one time limit", async () => {
    const never = (() => new Promise<ProofLinkResult>(() => {})) as typeof checkProofLink
    const started = Date.now()
    const out = await checkProofLinks(["https://a/1", "https://a/2"], "done", {}, settings({ totalTimeoutMs: 50 }), never)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(out!.verify.state).toBe("unverified")
    expect(out!.verify.detail).toContain("ran out of time")
  })

  it("block refuses on a firm failure only; warn never refuses", async () => {
    const table = {
      "https://a/gone": { state: "failed" as const, detail: "https://a/gone answered HTTP 404", firm: true as const },
      "https://a/noref": { state: "failed" as const, detail: "https://a/noref answered without \"#42\"" },
      "https://a/wall": { state: "unverifiable" as const, detail: "https://a/wall answered HTTP 403: the page could not be read" },
    }
    const block = settings({ mode: "block" })
    expect((await checkProofLinks(["https://a/noref", "https://a/wall"], "#42", {}, block, answers(table)))!.refuse).toBeNull()
    expect((await checkProofLinks(["https://a/noref", "https://a/gone"], "#42", {}, block, answers(table)))!.refuse).toBe("https://a/gone answered HTTP 404")
    expect((await checkProofLinks(["https://a/gone"], "#42", {}, settings(), answers(table)))!.refuse).toBeNull()
  })

  it("off gives no checker; no links gives no outcome", async () => {
    expect(proofChecker(undefined, () => ({}))).toBeUndefined()
    expect(await checkProofLinks(["  "], "done", {}, settings())).toBeNull()
  })

  it("the setting defaults to off, 10 links, 20 s", () => {
    expect(requestsConfigSchema.parse({}).proofCheck).toEqual({ mode: "off", maxLinks: 10, totalTimeoutMs: 20_000 })
  })
})

describe("an agent's done with a proof link (#2122)", () => {
  const AGENTS = new Set(["coder"])
  let tmp: string
  let wikiDir: string
  let db: Database.Database
  let store: RequestStore
  let tracker: RequestTracker
  let settings: RequestSettings
  let promises: PromiseSettings
  const clock = Date.parse("2030-03-01T12:00:00Z")

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-proof-check-"))
    wikiDir = path.join(tmp, "wiki")
    db = new Database(path.join(tmp, "db.sqlite"))
    db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY)")
    store = new RequestStore(db)
    promises = { ...DEFAULT_PROMISE_SETTINGS }
    settings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90, promises }
    tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
    attachPromiseFacts(store, { settings: () => promises, ledger: () => new FactLedger(wikiDir), log: () => {}, now: () => clock })
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const fetchOf = (table: Record<string, number>) => (async (url: string) => new Response("ok", { status: table[url] ?? 500 })) as unknown as typeof fetch
  const deps = (mode: ProofCheckSettings["mode"], table: Record<string, number>, over: Partial<RequestsApiDeps> = {}): RequestsApiDeps => ({
    store, tracker, enabled: true, hasAgent: (id) => AGENTS.has(id), now: clock, promiseSettings: promises,
    runningTurn: () => ({ channel: "telegram", chatId: "chat-1" }),
    proofCheck: proofChecker({ mode }, () => ({ fetch: fetchOf(table) })),
    ...over,
  })
  const post = (body: Record<string, unknown>, d: RequestsApiDeps) => handleRequestsCall("POST", "/requests", body, d)
  async function promise(d: RequestsApiDeps): Promise<string> {
    const res = await post({ action: "promise", agentId: "coder", owedTo: "client-a", text: "Publish the release notes" }, d)
    expect(res.status).toBe(200)
    return (res.body as any).request.id
  }
  const done = (id: string, link: string, d: RequestsApiDeps) =>
    post({ action: "done", work: "writing", agentId: "coder", id, proof: { kind: "link", url: link } }, d)

  it("off: closes as before, no check, the fact is the agent's", async () => {
    const d = deps("off", {})
    const id = await promise(d)
    const res = await done(id, "https://docs.example.com/notes", d)
    expect(res.status).toBe(200)
    expect((res.body as any).proofLinks).toBeUndefined()
    expect(store.get(id)?.verifyState).toBeNull()
    expect(new FactLedger(wikiDir).list()[0]).toMatchObject({ verifiedBy: "coder" })
  })

  it("warn: a link that checks out is recorded verified, the fact says daemon-check, the agent is told", async () => {
    const d = deps("warn", { "https://docs.example.com/notes": 200 })
    const id = await promise(d)
    const res = await done(id, "https://docs.example.com/notes", d)
    expect(res.status).toBe(200)
    expect((res.body as any).proofLinks).toMatchObject({ state: "verified" })
    expect(store.get(id)).toMatchObject({ state: "done", verifyState: "verified" })
    expect(new FactLedger(wikiDir).list()[0]).toMatchObject({ verifiedBy: "daemon-check" })
  })

  it("warn: a 404 still closes, unverified, and the fact says the link was not checked", async () => {
    const d = deps("warn", { "https://docs.example.com/notes": 404 })
    const id = await promise(d)
    const res = await done(id, "https://docs.example.com/notes", d)
    expect(res.status).toBe(200)
    expect(store.get(id)).toMatchObject({ state: "done", verifyState: "unverified" })
    const fact = new FactLedger(wikiDir).list()[0]
    expect(fact.verifiedBy).toBe("coder")
    expect(fact.source).toContain("link not checked")
  })

  it("block: a 404 refuses the close; a 403 does not", async () => {
    const d = deps("block", { "https://docs.example.com/gone": 404, "https://docs.example.com/walled": 403 })
    const id = await promise(d)
    const refused = await done(id, "https://docs.example.com/gone", d)
    expect(refused.status).toBe(409)
    expect((refused.body as any).proofFailed).toBe(true)
    expect(store.get(id)).toMatchObject({ verifyState: "failed" })
    expect(store.get(id)?.state).not.toBe("done")
    const walled = await done(id, "https://docs.example.com/walled", d)
    expect(walled.status).toBe(200)
    expect(store.get(id)).toMatchObject({ state: "done", verifyState: "unverified" })
  })
})
