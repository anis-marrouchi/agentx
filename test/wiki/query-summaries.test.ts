import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { WikiHub } from "../../src/wiki/hub"
import { agenticQuery } from "../../src/wiki/query"
import { DEFAULT_SUMMARIES_QUERY, parseNavigatorReply, rankBySummary, type SummariesQuerySettings } from "../../src/wiki/query-summaries"
import { resolveLiveSources, resolveQuerySettings } from "../../src/wiki/query-settings"
import { buildPlanPrompt, runLiveReads, validateReads, type FetchLike, type LiveSettings } from "../../src/wiki/live-read"
import { loadSummaries, parseSummaryReply, summariesPath, summarizeStore } from "../../src/wiki/summaries"
import { WIKI_SUMMARIZE_JOB, daemonConfigSchema, withSummariesJob } from "../../src/daemon/config"
import type { ModelCall } from "../../src/wiki/model-call"
import type { WikiArticleMeta } from "../../src/wiki/types"

let dir: string
let hub: WikiHub

function page(agent: string, path: string, title: string, body: string, extra: Partial<WikiArticleMeta> = {}): void {
  hub.getAgentWiki(agent).writeArticle(path, {
    title, tags: [], owner: agent, access: "public", created: "2026-09-01", lastUpdated: "2026-09-01", sources: [], ...extra,
  }, body, agent)
}

/** A model that writes "summary of <title>" for every page it is shown. */
const summariser: ModelCall & { calls: number } = Object.assign(async (prompt: string) => {
  summariser.calls++
  return [...prompt.matchAll(/=== PAGE (\d+) \| [^|]+ \| ([^|]+) \|/g)]
    .map((m) => JSON.stringify({ i: Number(m[1]), s: `summary of ${m[2].trim()}` })).join("\n")
}, { calls: 0 })

const LIVE: LiveSettings = {
  enabled: true, maxReads: 6, timeoutMs: 5000, plannerModel: "haiku",
  sources: [
    { type: "github", apiUrl: "https://api.github.test", token: "gh-secret", repos: [{ repo: "acme/widgets", about: "the widget app" }] },
    { type: "gitlab", url: "https://gitlab.test", token: "gl-secret", repos: [{ repo: "acme/group/billing" }] },
    { type: "agentx", url: "http://127.0.0.1:1", peers: true },
  ],
}

/** A fetch that records every request and answers from a URL → body map. */
function fakeFetch(bodies: Record<string, unknown>) {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; redirect: string }> = []
  const impl: FetchLike = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, redirect: init.redirect })
    const body = bodies[url]
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, json: async () => body }
  }
  return { impl, seen }
}

/** A model for the three query steps, by the first line of each prompt.
 *  `open` names the pages to pick by title. */
function queryModel(replies: { open: string[]; reads?: unknown[]; searches?: unknown[]; answer?: string }) {
  const prompts: Array<{ step: string; prompt: string; model: string }> = []
  const call: ModelCall = async (prompt, model) => {
    const step = prompt.startsWith("You choose which wiki pages") ? "navigator"
      : prompt.startsWith("You decide which live reads") ? "plan"
      : prompt.startsWith("No wiki page holds") ? "search" : "answer"
    prompts.push({ step, prompt, model })
    if (step === "navigator") {
      const open = replies.open.map((title) => Number(prompt.split("\n").find((l) => l.includes(`] ${title} — `))?.split(".")[0] ?? 99))
      return JSON.stringify({ open })
    }
    if (step === "plan") return `Here you go: ${JSON.stringify({ reads: replies.reads ?? [] })}`
    if (step === "search") return JSON.stringify({ reads: replies.searches ?? [] })
    return replies.answer ?? "The answer."
  }
  return { call, prompts }
}

const settings = (live: Partial<LiveSettings> = {}): SummariesQuerySettings => ({ ...DEFAULT_SUMMARIES_QUERY, live: { ...LIVE, ...live } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wiki-summaries-"))
  hub = new WikiHub(dir, () => {})
  summariser.calls = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("page summaries", () => {
  it("writes one line per page beside the catalog and leaves the pages alone", async () => {
    page("a", "projects/widgets.md", "Widgets", "Widget work. Issue #12 is open.")
    page("a", "people/sam.md", "Sam", "Sam leads widgets.")
    const store = hub.getAgentWiki("a")
    const before = readFileSync(join(store.baseDir, "projects/widgets.md"), "utf-8")

    const run = await summarizeStore(store, { call: summariser })

    expect(run).toMatchObject({ pages: 2, due: 2, written: 2, failed: 0 })
    expect(loadSummaries(store)["projects/widgets.md"].s).toBe("summary of Widgets")
    expect(readFileSync(join(store.baseDir, "projects/widgets.md"), "utf-8")).toBe(before)
    expect(store.listAllArticles().map((a) => a.path).sort()).toEqual(["people/sam.md", "projects/widgets.md"])
  })

  it("summarises again only the page that changed, and drops the line of a page that is gone", async () => {
    page("a", "projects/widgets.md", "Widgets", "v1")
    page("a", "people/sam.md", "Sam", "Sam leads widgets.")
    page("a", "people/old.md", "Old", "Left.")
    const store = hub.getAgentWiki("a")
    await summarizeStore(store, { call: summariser })
    expect(summariser.calls).toBe(1)

    expect((await summarizeStore(store, { call: summariser })).due).toBe(0)
    expect(summariser.calls).toBe(1)

    page("a", "projects/widgets.md", "Widgets", "v2: issue #12 closed")
    rmSync(join(store.baseDir, "people/old.md"))
    const run = await summarizeStore(store, { call: summariser })
    expect(run).toMatchObject({ due: 1, written: 1, removed: 1 })
    expect(Object.keys(loadSummaries(store)).sort()).toEqual(["people/sam.md", "projects/widgets.md"])
  })

  it("keeps a page due when the model returns no line for it, and a dry run writes nothing", async () => {
    page("a", "projects/widgets.md", "Widgets", "v1")
    const store = hub.getAgentWiki("a")
    expect(await summarizeStore(store, { call: summariser, dryRun: true })).toMatchObject({ due: 1, written: 0 })
    expect(existsSync(summariesPath(store))).toBe(false)

    const silent: ModelCall = async () => "I cannot do that."
    expect(await summarizeStore(store, { call: silent })).toMatchObject({ written: 0, failed: 1 })
    expect((await summarizeStore(store, { call: summariser })).written).toBe(1)
  })

  it("reads only well-formed lines and cuts one that ignores the word limit", () => {
    const reply = ['{"i": 0, "s": "ok line"}', "noise", '{"i": 9, "s": "out of range"}', `{"i": 1, "s": "${"w ".repeat(200)}"}`].join("\n")
    const got = parseSummaryReply(reply, 2, 10)
    expect(got.get(0)).toBe("ok line")
    expect(got.has(9)).toBe(false)
    expect(got.get(1)!.split(" ").length).toBe(20)
  })

  it("an unreadable summaries file counts as none", () => {
    page("a", "projects/widgets.md", "Widgets", "v1")
    const store = hub.getAgentWiki("a")
    writeFileSync(summariesPath(store), "{not json")
    expect(loadSummaries(store)).toEqual({})
  })
})

describe("ranking by summary", () => {
  const pool = [
    { path: "a.md", title: "Billing rules", tags: [] },
    { path: "b.md", title: "Widgets", tags: [] },
    { path: "events/2026-10-02-sync.md", title: "Sync", tags: [] },
    { path: "events/2026-10-07-sync.md", title: "Sync", tags: [] },
  ]

  it("finds a page by a word only its summary holds, and ranks a title match above it", () => {
    const summaries = new Map([["a.md", "Invoices are sent on the first; the cutover to the new ledger is pending"], ["b.md", "Widget cutover notes"]])
    expect(rankBySummary("when are invoices sent?", pool, summaries, 5)).toEqual([0])
    const withTitle = [...pool, { path: "c.md", title: "Ledger cutover", tags: [] }]
    expect(rankBySummary("is the ledger cutover done?", withTitle, summaries, 5)[0]).toBe(4)
  })

  it("puts the newer of two equal pages first and returns nothing for a question with no shared word", () => {
    expect(rankBySummary("sync", pool, new Map(), 5)).toEqual([3, 2])
    expect(rankBySummary("explain a mutex", pool, new Map(), 5)).toEqual([])
  })

  it("keeps only picks that exist, once each, up to the cap", () => {
    expect(parseNavigatorReply('ok {"open": [2, 2, 7, "1", 0, 1]}', 3, 2)).toEqual([2, 0])
    expect(parseNavigatorReply("no json here", 3, 2)).toEqual([])
  })
})

describe("live reads", () => {
  it("refuses anything the config does not allow", () => {
    const reads = validateReads([
      { kind: "issue", repo: "acme/widgets", id: 12 },
      { kind: "issue", repo: "acme/widgets", id: "13" },
      { kind: "issue", repo: "evil/repo", id: 1 },
      { kind: "issue", repo: "acme/widgets", id: "12; rm -rf" },
      { kind: "issue", repo: "acme/widgets", id: -4 },
      { kind: "shell", repo: "acme/widgets", cmd: "curl -X POST" },
      { kind: "search", repo: "acme/group/billing", words: "invoice&state=x/../../ pdf" },
      { kind: "release", repo: "acme/widgets" },
      { kind: "release", repo: "acme/widgets" },
      { kind: "fleet" },
      "not an object",
    ], LIVE)
    expect(reads).toEqual([
      { kind: "issue", repo: "acme/widgets", id: 12 },
      { kind: "issue", repo: "acme/widgets", id: 13 },
      { kind: "search", repo: "acme/group/billing", words: "invoice state x .. .. pdf" },
      { kind: "release", repo: "acme/widgets" },
      { kind: "fleet" },
    ])
    expect(validateReads([{ kind: "fleet" }], { ...LIVE, sources: LIVE.sources.slice(0, 2) })).toEqual([])
    expect(validateReads(Array.from({ length: 20 }, (_, i) => ({ kind: "issue", repo: "acme/widgets", id: i + 1 })), LIVE)).toHaveLength(6)
    expect(validateReads({ kind: "fleet" }, LIVE)).toEqual([])
  })

  it("makes GET requests only, to the configured host, each token to its own host", async () => {
    const { impl, seen } = fakeFetch({
      "https://api.github.test/repos/acme/widgets/issues/12": { number: 12, title: "Widget cutover", state: "closed", closed_at: "2026-10-08T10:00:00Z", updated_at: "2026-10-08T11:00:00Z", labels: [{ name: "Done" }] },
      "https://api.github.test/repos/acme/widgets/pulls/14": { number: 14, title: "feat: cutover", state: "closed", merged_at: "2026-10-08T09:00:00Z", updated_at: "2026-10-08T09:00:00Z" },
      "https://gitlab.test/api/v4/projects/acme%2Fgroup%2Fbilling/merge_requests/7": { iid: 7, title: "fix invoices", state: "merged", merged_at: "2026-10-07T09:00:00Z", updated_at: "2026-10-07T09:00:00Z", labels: ["bug"] },
      "https://gitlab.test/api/v4/projects/acme%2Fgroup%2Fbilling/issues?search=invoice%20pdf&order_by=updated_at&per_page=8": [{ iid: 3, title: "Invoice PDF", state: "opened", updated_at: "2026-10-01T00:00:00Z", labels: [] }],
      "https://gitlab.test/api/v4/projects/acme%2Fgroup%2Fbilling/repository/tags?per_page=3": [],
      "http://127.0.0.1:1/mesh": [{ peer: "server", peerUrl: "http://10.0.0.2:19900" }, { peer: "bad", peerUrl: "file:///etc/passwd" }],
      "http://127.0.0.1:1/health": { node: { name: "Laptop" }, version: "1.2.3", commit: "abcdef0123456", startedAt: "2026-10-09T05:10:14.566Z" },
    })
    const lines = await runLiveReads([
      { kind: "issue", repo: "acme/widgets", id: 12 },
      { kind: "mr", repo: "acme/widgets", id: 14 },
      { kind: "mr", repo: "acme/group/billing", id: 7 },
      { kind: "search", repo: "acme/group/billing", words: "invoice pdf" },
      { kind: "release", repo: "acme/group/billing" },
      { kind: "fleet" },
    ], LIVE, impl)

    expect(lines.map((l) => l.line)).toEqual([
      '#12 in acme/widgets: "Widget cutover" is closed since 2026-10-08, labels Done, last change 2026-10-08',
      '#14 in acme/widgets: "feat: cutover" is merged since 2026-10-08, last change 2026-10-08',
      '!7 in acme/group/billing: "fix invoices" is merged since 2026-10-07, labels bug, last change 2026-10-07',
      'search "invoice pdf" in acme/group/billing: #3 "Invoice PDF" opened, last change 2026-10-01',
      "newest releases of acme/group/billing: none found",
      "AgentX nodes: Laptop runs AgentX 1.2.3 (commit abcdef01, started 2026-10-09T05:10); server: no answer",
    ])
    expect(seen.every((r) => r.method === "GET" && r.redirect === "error")).toBe(true)
    for (const r of seen) {
      const host = new URL(r.url).host
      expect(["api.github.test", "gitlab.test", "127.0.0.1:1", "10.0.0.2:19900"]).toContain(host)
      expect(r.headers.Authorization).toBe(host === "api.github.test" ? "Bearer gh-secret" : undefined)
      expect(r.headers["PRIVATE-TOKEN"]).toBe(host === "gitlab.test" ? "gl-secret" : undefined)
    }
  })

  it("leaves out a read that fails and never runs one that was not validated", async () => {
    const { impl, seen } = fakeFetch({})
    const throwing: FetchLike = async () => { throw new Error("network down") }
    expect(await runLiveReads([{ kind: "issue", repo: "acme/widgets", id: 12 }], LIVE, impl)).toEqual([])
    expect(await runLiveReads([{ kind: "issue", repo: "acme/widgets", id: 12 }], LIVE, throwing)).toEqual([])
    seen.length = 0
    expect(await runLiveReads([{ kind: "issue", repo: "evil/repo", id: 1 }], LIVE, impl)).toEqual([])
    expect(seen).toEqual([])
  })

  it("offers the model only the kinds the sources can serve", () => {
    const repoOnly = buildPlanPrompt("q", "pages", { ...LIVE, sources: LIVE.sources.slice(0, 1) })
    expect(repoOnly).toContain("- acme/widgets — the widget app")
    expect(repoOnly).not.toContain('"fleet"')
    const fleetOnly = buildPlanPrompt("q", "pages", { ...LIVE, sources: LIVE.sources.slice(2) })
    expect(fleetOnly).toContain('"fleet"')
    expect(fleetOnly).not.toContain('"issue"')
  })
})

describe("wiki query by summaries", () => {
  beforeEach(async () => {
    page("a", "projects/widgets.md", "Widgets", "Widget cutover tracked in #12. Status on 2026-10-01: open, not merged.")
    page("a", "people/sam.md", "Sam", "Sam leads the widget work.")
    page("a", "concepts/secret.md", "Widget secret", "The widget vault code is 4711.", { access: "private" })
    page("b", "events/2026-10-05-widgets-review.md", "Widgets review", "B reviewed the widget cutover.")
    await summarizeStore(hub.getAgentWiki("a"), { call: summariser })
    await summarizeStore(hub.getAgentWiki("b"), { call: summariser })
  })

  it("picks from summary lines, runs the reads the model named and answers from pages plus live lines", async () => {
    const model = queryModel({ open: ["Widgets"], reads: [{ kind: "issue", repo: "acme/widgets", id: 12 }, { kind: "issue", repo: "other/repo", id: 1 }], answer: "It is closed (live) [Widgets]." })
    const { impl, seen } = fakeFetch({
      "https://api.github.test/repos/acme/widgets/issues/12": { number: 12, title: "Widget cutover", state: "closed", closed_at: "2026-10-08T10:00:00Z", updated_at: "2026-10-08T11:00:00Z" },
    })
    const result = await agenticQuery("Is the widget cutover done?", hub.getAgentWiki("a"), "a", {
      method: "auto", summaries: settings(), call: model.call, fetch: impl, shared: hub.sharedScope("a"),
    })

    expect(result).toMatchObject({ status: "ok", method: "summaries", answer: "It is closed (live) [Widgets].", liveAsked: 1 })
    expect(result.citations.map((c) => c.path)).toEqual(["projects/widgets.md"])
    expect(result.live!.map((l) => l.line)).toEqual(['#12 in acme/widgets: "Widget cutover" is closed since 2026-10-08, last change 2026-10-08'])
    expect(seen.map((r) => r.url)).toEqual(["https://api.github.test/repos/acme/widgets/issues/12"])

    const [navigator, plan, answer] = model.prompts
    expect(navigator.prompt).toContain("Widgets — summary of Widgets")
    expect(navigator.prompt).toContain("by b] Widgets review — summary of Widgets review")
    expect(navigator.model).toBe("haiku")
    expect(plan.step).toBe("plan")
    expect(answer.model).toBe("sonnet")
    expect(answer.prompt).toContain("## LIVE, read at the source")
    expect(answer.prompt).toContain("is closed since 2026-10-08")
    expect(answer.prompt).toContain("Status on 2026-10-01: open, not merged.")
  })

  it("makes no live call when the live read is off or no source is configured", async () => {
    for (const live of [{ enabled: false }, { sources: [] }]) {
      const model = queryModel({ open: ["Widgets"] })
      const { impl, seen } = fakeFetch({})
      const result = await agenticQuery("Is the widget cutover done?", hub.getAgentWiki("a"), "a", { method: "summaries", summaries: settings(live), call: model.call, fetch: impl })
      expect(result.status).toBe("ok")
      expect(model.prompts.map((p) => p.step)).toEqual(["navigator", "answer"])
      expect(seen).toEqual([])
      expect(model.prompts[1].prompt).not.toContain("LIVE")
    }
  })

  it("still answers from the pages when the plan call fails", async () => {
    const model = queryModel({ open: ["Widgets"] })
    const call: ModelCall = async (prompt, m, t) => {
      if (prompt.startsWith("You decide which live reads")) throw new Error("planner down")
      return model.call(prompt, m, t)
    }
    const result = await agenticQuery("Is the widget cutover done?", hub.getAgentWiki("a"), "a", { method: "summaries", summaries: settings(), call, log: () => {} })
    expect(result).toMatchObject({ status: "ok", answer: "The answer.", live: [] })
  })

  it("returns no-candidates when nothing is picked and no search fits, without a read or an answer call", async () => {
    const model = queryModel({ open: [] })
    const { impl, seen } = fakeFetch({})
    const result = await agenticQuery("Is the widget cutover done?", hub.getAgentWiki("a"), "a", { method: "summaries", summaries: settings(), call: model.call, fetch: impl })
    expect(result.status).toBe("no-candidates")
    expect(model.prompts.map((p) => p.step)).toEqual(["navigator", "search"])

    const none = queryModel({ open: ["Widgets"] })
    expect((await agenticQuery("explain a mutex", hub.getAgentWiki("a"), "a", { method: "summaries", summaries: settings(), call: none.call, fetch: impl })).status).toBe("no-candidates")
    expect(none.prompts.map((p) => p.step)).toEqual(["search"])
    expect(seen).toEqual([])
  })

  it("searches the source when no page is picked, and answers from those lines without a page (#861)", async () => {
    const model = queryModel({
      open: [],
      searches: [{ kind: "search", repo: "acme/widgets", words: "dark mode" }, { kind: "issue", repo: "acme/widgets", id: 9 }, { kind: "fleet" }],
      answer: "No wiki page covers this; #31 in acme/widgets is open.",
    })
    const url = "https://api.github.test/search/issues?q=repo%3Aacme%2Fwidgets%20dark%20mode&per_page=8"
    const { impl, seen } = fakeFetch({ [url]: { items: [{ number: 31, title: "Dark mode toggle", state: "open", updated_at: "2026-10-07T00:00:00Z", labels: [{ name: "ui" }] }] } })
    const result = await agenticQuery("Is anyone working on dark mode?", hub.getAgentWiki("a"), "a", { method: "summaries", summaries: settings(), call: model.call, fetch: impl })

    expect(result).toMatchObject({ status: "ok", basis: "search", method: "summaries", answer: "No wiki page covers this; #31 in acme/widgets is open.", liveAsked: 1, citations: [] })
    expect(result.live!.map((l) => l.line)).toEqual(['search "dark mode" in acme/widgets: #31 "Dark mode toggle" open, labels ui, last change 2026-10-07'])
    // Only the search ran: an issue or fleet read named from the question is dropped.
    expect(seen.map((r) => r.url)).toEqual([url])
    const search = model.prompts.find((p) => p.step === "search")!
    expect(search.prompt).toContain("- acme/widgets — the widget app")
    expect(search.prompt).not.toContain('"fleet"')
    const answer = model.prompts.find((p) => p.step === "answer")!
    expect(answer.prompt).toContain("No wiki page matched this question")
    expect(answer.prompt).toContain('#31 "Dark mode toggle"')
    expect(answer.prompt).not.toContain("## Pages")
  })

  it("gives no answer when the source search finds no issue", async () => {
    const model = queryModel({ open: [], searches: [{ kind: "search", repo: "acme/widgets", words: "dark mode" }] })
    const { impl } = fakeFetch({ "https://api.github.test/search/issues?q=repo%3Aacme%2Fwidgets%20dark%20mode&per_page=8": { items: [] } })
    const result = await agenticQuery("Is anyone working on dark mode?", hub.getAgentWiki("a"), "a", { method: "summaries", summaries: settings(), call: model.call, fetch: impl })
    expect(result.status).toBe("no-candidates")
    expect(result.liveAsked).toBe(1)
    // No page shares a word with the question, so the search is planned without a navigator call.
    expect(model.prompts.map((p) => p.step)).toEqual(["search"])
  })

  it("does not plan a search when no repository is listed or the live read is off", async () => {
    for (const live of [{ sources: LIVE.sources.slice(2) }, { enabled: false }]) {
      const model = queryModel({ open: [] })
      const result = await agenticQuery("Is the widget dark mode done?", hub.getAgentWiki("a"), "a", { method: "summaries", summaries: settings(live), call: model.call })
      expect(result.status).toBe("no-candidates")
      expect(model.prompts.map((p) => p.step)).toEqual(["navigator"])
    }
  })

  it("never shows another agent a private page, not even its summary line", async () => {
    const model = queryModel({ open: ["Widgets"] })
    await agenticQuery("What is the widget vault secret code?", hub.getAgentWiki("b"), "b", {
      method: "summaries", summaries: settings({ enabled: false }), call: model.call, shared: hub.sharedScope("b"),
    })
    const all = model.prompts.map((p) => p.prompt).join("\n")
    expect(all).not.toContain("Widget secret")
    expect(all).not.toContain("4711")
    expect(all).toContain("Widgets")
  })

  it("cuts a long page at pageChars", async () => {
    page("a", "projects/long.md", "Long widget log", `${"x".repeat(500)}TAILMARK`)
    const model = queryModel({ open: ["Long widget log"] })
    await agenticQuery("long widget log", hub.getAgentWiki("a"), "a", { method: "summaries", summaries: { ...settings({ enabled: false }), pageChars: 200 }, call: model.call })
    const answer = model.prompts.find((p) => p.step === "answer")!.prompt
    expect(answer).toContain("[…]")
    expect(answer).not.toContain("TAILMARK")
  })

  it("auto keeps the catalog method until a summary exists; the default is the catalog method", async () => {
    rmSync(summariesPath(hub.getAgentWiki("a")))
    const model = queryModel({ open: ["Widgets"] })
    // The catalog method needs the claude CLI; a selector that fails proves it was taken.
    const result = await agenticQuery("Is the widget cutover done?", hub.getAgentWiki("a"), "a", { method: "auto", summaries: settings(), call: model.call, timeoutMs: 1, log: () => {} })
    expect(result.method).toBeUndefined()
    expect(model.prompts).toEqual([])
  })
})

describe("wiki.query settings", () => {
  const parse = (wiki: unknown, extra: Record<string, unknown> = {}) =>
    daemonConfigSchema.parse({ node: { id: "n", name: "n", bind: "0.0.0.0:18800" }, wiki, ...extra })

  it("defaults: summaries when they exist, live read on with no source, no job", () => {
    const config = parse({})
    const s = resolveQuerySettings(config, {})
    expect(s).toMatchObject({ shared: true, method: "auto", summaries: { candidates: 12, maxPages: 3, pageChars: 4000, navigatorModel: "haiku", answerModel: "sonnet", live: { enabled: true, maxReads: 6, sources: [] } } })
    expect(withSummariesJob(config).crons[WIKI_SUMMARIZE_JOB]).toBeUndefined()
  })

  it("resolves hosts and tokens, and never lends a channel token to another host", () => {
    const config = parse({ query: { live: { sources: [
      { type: "github", repos: ["acme/widgets", { repo: "acme/api", about: "the API" }] },
      { type: "github", apiUrl: "https://ghe.example/api/v3", repos: ["corp/app"] },
      { type: "gitlab", repos: ["acme/group/billing"] },
      { type: "gitlab", url: "https://other-gitlab.example", repos: ["x/y"] },
      { type: "gitlab", url: "https://other-gitlab.example", tokenEnv: "OTHER_TOKEN", repos: ["x/z"] },
      { type: "agentx" },
    ] } } }, { channels: { github: { token: "gh-channel" }, gitlab: { host: "https://gitlab.example", token: "gl-channel" } } })
    expect(resolveLiveSources(config, { OTHER_TOKEN: "other" })).toEqual([
      { type: "github", apiUrl: "https://api.github.com", token: "gh-channel", repos: [{ repo: "acme/widgets" }, { repo: "acme/api", about: "the API" }] },
      { type: "github", apiUrl: "https://ghe.example/api/v3", token: undefined, repos: [{ repo: "corp/app" }] },
      { type: "gitlab", url: "https://gitlab.example", token: "gl-channel", repos: [{ repo: "acme/group/billing" }] },
      { type: "gitlab", url: "https://other-gitlab.example", token: undefined, repos: [{ repo: "x/y" }] },
      { type: "gitlab", url: "https://other-gitlab.example", token: "other", repos: [{ repo: "x/z" }] },
      { type: "agentx", url: "http://127.0.0.1:18800", peers: true },
    ])
  })

  it("rejects a repository name that is not owner/name, and an unknown source type", () => {
    expect(() => parse({ query: { live: { sources: [{ type: "github", repos: ["acme/widgets?x=1"] }] } } })).toThrow()
    expect(() => parse({ query: { live: { sources: [{ type: "github", repos: ["../etc"] }] } } })).toThrow()
    expect(() => parse({ query: { live: { sources: [{ type: "shell", repos: ["a/b"] }] } } })).toThrow()
  })

  it("adds the summarize job only when a schedule is set, and an operator's job wins", () => {
    const agents = { agents: { z: { name: "Z", workspace: "/tmp/z" }, m: { name: "M", workspace: "/tmp/m" } } }
    const config = parse({ summaries: { schedule: "15 3 * * *" } }, agents)
    const job = withSummariesJob(config, "agentx").crons[WIKI_SUMMARIZE_JOB]
    expect(job).toMatchObject({ schedule: "15 3 * * *", agent: "m", command: "agentx wiki summarize --all" })
    const own = { ...config, crons: { [WIKI_SUMMARIZE_JOB]: { ...job, schedule: "0 1 * * *" } } }
    expect(withSummariesJob(own, "agentx").crons[WIKI_SUMMARIZE_JOB].schedule).toBe("0 1 * * *")
  })
})
