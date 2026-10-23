import { describe, it, expect, vi } from "vitest"
import Database from "better-sqlite3"
import { issueLinks } from "../src/requests/drift/refs"
import { checkProject, DEFAULT_DRIFT_SETTINGS, proofNote, statusOf, type DriftCheckDeps, type DriftProject, type DriftSettings } from "../src/requests/drift/check"
import { driftForge, sameCommit, type DriftForge, type MergedChange } from "../src/requests/drift/forge"
import { liveReader } from "../src/requests/drift/live"
import { DriftStore, WRITE_TRIES } from "../src/requests/drift/store"
import { runDriftSweep, WRITE_TIMEOUT_MS, type DriftSweepDeps } from "../src/requests/drift/sweep"
import type { ForgeReader } from "../src/requests/checkers/issue"
import { requestsConfigSchema } from "../src/daemon/config"

// Status follows the work (#1138 step F): merged merge requests mapped to
// the issues they close, compared with where each issue says it is.

const NOW = Date.parse("2030-03-08T12:00:00Z")
const DAY = 86_400_000
const LABELS = DEFAULT_DRIFT_SETTINGS.labels

describe("the issues a merge request names", () => {
  it("counts closing words, cross-project refs, addresses and the branch as closing", () => {
    const links = issueLinks("gitlab", "acme/app", {
      title: "Fix login (Closes #12)",
      description: "Fixes acme/other#3, #4 and #5\nResolves https://gitlab.example.com/acme/app/-/issues/6\nRefs #7",
      branch: "8-login-redirect",
    })
    const closing = links.filter((l) => l.closes).map((l) => `${l.project}#${l.number}`).sort()
    expect(closing).toEqual(["acme/app#12", "acme/app#4", "acme/app#5", "acme/app#6", "acme/app#8", "acme/other#3"].sort())
    expect(links.find((l) => l.number === 7)).toMatchObject({ closes: false })
  })

  it("keeps references, bare mentions and lookalikes from closing anything", () => {
    const links = issueLinks("gitlab", "acme/app", { description: "Part of #20. See !4, prefix #21, &#39; and abc#22. Refs acme/app#23", branch: "feature-x" })
    expect(links.filter((l) => l.closes)).toEqual([])
    expect(links.map((l) => l.number).sort()).toEqual([20, 21, 23])
  })

  it("lets the text's reference win over the branch: a step of an epic does not close it", () => {
    const step = issueLinks("github", "o/r", { title: "feat: reach (#1138 step B)", description: "Part of #1138.", branch: "1138-reach" })
    expect(step).toEqual([{ project: "o/r", number: 1138, closes: false }])
    const closing = issueLinks("github", "o/r", { description: "Closes #1138", branch: "1138-reach" })
    expect(closing).toEqual([{ project: "o/r", number: 1138, closes: true }])
    const silent = issueLinks("github", "o/r", { description: "No mention.", branch: "1138-reach" })
    expect(silent).toEqual([{ project: "o/r", number: 1138, closes: true }])
  })

  it("reads GitHub addresses and owner/repo refs", () => {
    const links = issueLinks("github", "o/r", { description: "Closes https://github.com/o/other/issues/9 and o/r#10" })
    expect(links).toEqual([{ project: "o/other", number: 9, closes: true }, { project: "o/r", number: 10, closes: true }])
  })
})

describe("where an issue says it is", () => {
  it("takes the furthest status label, any case, else the state", () => {
    expect(statusOf({ state: "open", labels: ["bug", "status::review", "Doing"] }, LABELS)).toEqual({ status: "review", label: "status::review", all: ["status::review", "Doing"] })
    expect(statusOf({ state: "closed", labels: ["Review"] }, LABELS).status).toBe("review")
    expect(statusOf({ state: "closed", labels: [] }, LABELS).status).toBe("closed")
    expect(statusOf({ state: "open" }, LABELS).status).toBe("open")
  })
})

const change = (iid: number, commit: string, over: Partial<MergedChange> = {}): MergedChange => ({
  ref: `acme/app!${iid}`, url: `https://gl/acme/app/-/merge_requests/${iid}`, title: "", description: "", branch: "",
  commit, mergedAt: NOW - DAY, ...over,
})

/** A forge over fixed merges, where `ancestors[live]` lists the commits in it. */
function fakeForge(merged: MergedChange[], ancestors: Record<string, string[]>): DriftForge {
  return {
    merged: async () => merged,
    contains: async (_p, _proj, commit, live) => (ancestors[live] ? ancestors[live].includes(commit) : null),
  }
}
const issues = (byNumber: Record<number, { state: "open" | "closed"; labels: string[] } | { error: string }>): ForgeReader =>
  async (_p, ref) => {
    const i = byNumber[ref.number]
    if (!i) return { error: "not found" }
    return "error" in i ? i : { ...i, url: `https://gl/${ref.project}/-/issues/${ref.number}` }
  }

const project = (over: Partial<DriftProject> = {}): DriftProject => ({ provider: "gitlab", project: "acme/app", live: ["self"], ...over })
const deps = (forge: DriftForge, readIssue: ForgeReader, live: string | null = "live1"): DriftCheckDeps => ({
  settings: DEFAULT_DRIFT_SETTINGS, forge, readIssue, now: NOW,
  liveCommit: async (source) => (live ? { source, commit: live } : { source, commit: null, error: "down" }),
})

describe("finding the drift", () => {
  const merged = [
    change(1, "aaaaaaa1", { description: "Closes #11" }),   // live, still Review
    change(2, "bbbbbbb2", { branch: "12-thing" }),          // not live, still Doing
    change(3, "ccccccc3", { description: "Fixes #13" }),    // not live, already Done
    change(4, "ddddddd4", { description: "Closes #14" }),   // live, already Done
    change(5, "eeeeeee5", { description: "Refs #15" }),     // a reference only
    change(6, "fffffff6", { description: "Closes #16" }),   // live, closed, no status label
  ]
  const forge = fakeForge(merged, { live1: ["aaaaaaa1", "ddddddd4", "fffffff6"] })
  const read = issues({
    11: { state: "open", labels: ["Review"] },
    12: { state: "open", labels: ["Doing"] },
    13: { state: "closed", labels: ["Done"] },
    14: { state: "open", labels: ["Done"] },
    15: { state: "open", labels: ["Doing"] },
    16: { state: "closed", labels: [] },
  })

  it("reports live-not-done, merged-not-review and done-not-live, and nothing else", async () => {
    const r = await checkProject(project(), deps(forge, read))
    expect(r.errors).toEqual([])
    expect(r.merged).toBe(6)
    const kinds = Object.fromEntries(r.drifts.map((d) => [d.number, d.kind]))
    expect(kinds).toEqual({ 11: "live-not-done", 12: "merged-not-review", 13: "done-not-live" })
    const live = r.drifts.find((d) => d.number === 11)!
    expect(live.line).toContain("acme/app#11 is live")
    expect(live.line).toContain("still Review: expected Done")
    expect(r.drifts.find((d) => d.number === 13)!.line).toMatch(/says Done but acme\/app!3 .* is not live yet/)
  })

  it("a closed issue still labelled Review is drift once live", async () => {
    const r = await checkProject(project(), deps(fakeForge([change(1, "aaaaaaa1", { description: "Closes #11" })], { live1: ["aaaaaaa1"] }), issues({ 11: { state: "closed", labels: ["Status::Review"] } })))
    expect(r.drifts.map((d) => d.kind)).toEqual(["live-not-done"])
  })

  it("with no live source, only merged-not-review is judged", async () => {
    const r = await checkProject(project({ live: [] }), deps(forge, read))
    expect(r.drifts.map((d) => [d.number, d.kind])).toEqual([[12, "merged-not-review"]])
  })

  it("a live source that cannot be read judges nothing, so live work is not told as 'expected Review'", async () => {
    const r = await checkProject(project(), deps(forge, read, null))
    expect(r.drifts).toEqual([])
    expect(r.errors).toEqual(["acme/app: live self: down"])
  })

  it("never reaches an issue of a project that is not listed", async () => {
    const seen: string[] = []
    const reader: ForgeReader = async (p, ref, o) => { seen.push(ref.project); return read(p, ref, o) }
    const crossing = fakeForge([change(1, "aaaaaaa1", { description: "Closes client/app#11 and acme/other#11" })], { live1: ["aaaaaaa1"] })
    const alone = await checkProject(project(), deps(crossing, reader))
    expect(alone.drifts).toEqual([])
    expect(seen).toEqual([])
    const listed = await checkProject(project(), { ...deps(crossing, reader), settings: { ...DEFAULT_DRIFT_SETTINGS, projects: [project(), project({ project: "acme/other" })] } })
    expect(listed.drifts.map((d) => d.issue)).toEqual(["acme/other#11"])
    expect(seen).toEqual(["acme/other"])
  })

  it("tells Done-not-live only once the merge has waited doneNotLiveAfterHours", async () => {
    const fresh = fakeForge([change(3, "ccccccc3", { description: "Fixes #13", mergedAt: NOW - 3_600_000 })], { live1: [] })
    expect((await checkProject(project(), deps(fresh, read))).drifts).toEqual([])
    const r = await checkProject(project(), { ...deps(fresh, read), settings: { ...DEFAULT_DRIFT_SETTINGS, doneNotLiveAfterHours: 0 } })
    expect(r.drifts.map((d) => d.kind)).toEqual(["done-not-live"])
  })

  it("looks up liveness only for merges that close an issue, and keeps the answers", async () => {
    const asked: string[] = []
    const counting: DriftForge = { ...forge, contains: async (p, proj, commit, l) => { asked.push(commit); return forge.contains(p, proj, commit, l) } }
    const liveCache = new Map<string, boolean>()
    await checkProject(project(), { ...deps(counting, read), liveCache })
    expect(asked).not.toContain("eeeeeee5") // "Refs #15" closes nothing
    const first = asked.length
    await checkProject(project(), { ...deps(counting, read), liveCache })
    expect(asked.length).toBe(first)
  })

  it("needs every running commit: live on one host, not the other, is not live", async () => {
    const two = { ...deps(forge, read), liveCommit: async (s: string) => ({ source: s, commit: s === "self" ? "live1" : "live2" }) }
    const r = await checkProject(project({ live: ["self", "https://b/health"] }), { ...two, forge: fakeForge(merged, { live1: ["aaaaaaa1"], live2: [] }) })
    expect(r.drifts.find((d) => d.number === 11)).toBeUndefined()
  })

  it("an issue it cannot read is listed, not judged; a forge that is down is an error", async () => {
    const r = await checkProject(project(), deps(forge, issues({ 12: { error: "HTTP 403" } })))
    expect(r.drifts).toEqual([])
    expect(r.errors).toContain("acme/app#12: HTTP 403")
    const down = await checkProject(project(), deps({ ...forge, merged: async () => ({ error: "HTTP 502" }) }, read))
    expect(down.errors).toEqual(["acme/app: merged changes: HTTP 502"])
  })

  it("the proof note names the merge, the running commit and when it was checked", async () => {
    const r = await checkProject(project(), deps(forge, read))
    const note = proofNote(r.drifts.find((d) => d.number === 11)!, "Done")
    expect(note).toContain("merge commit `aaaaaaa1`")
    expect(note).toContain("`live1` on self")
    expect(note).toContain("Checked: 2030-03-08 12:00 UTC")
    expect(note).toContain("not closed")
  })
})

describe("reading the forges", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it("lists GitLab merges in the window and asks merge_base whether one is live", async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      if (url.includes("/merge_requests?")) return json([
        { iid: 3, title: "t", description: "Closes #1", source_branch: "1-x", merge_commit_sha: null, squash_commit_sha: "abc1234", merged_at: new Date(NOW - DAY).toISOString(), web_url: "u" },
        { iid: 2, merged_at: new Date(NOW - 30 * DAY).toISOString() },
      ])
      if (url.includes("merge_base")) return json({ id: url.includes("refs[]=abc1234") ? "abc1234ffff" : "x" })
      return json({}, 404)
    }) as unknown as typeof fetch
    const f = driftForge({ gitlab: { url: "https://gl.example", token: "t" } }, fake)
    const merged = await f.merged("gitlab", "acme/app", NOW - 7 * DAY)
    expect(merged).toMatchObject([{ ref: "acme/app!3", commit: "abc1234", branch: "1-x" }])
    expect(calls.some((c) => c.includes("/api/v4/projects/acme%2Fapp/merge_requests?state=merged"))).toBe(true)
    expect(await f.contains("gitlab", "acme/app", "abc1234", "live999")).toBe(true)
    expect(await f.contains("gitlab", "acme/app", "abc1234", "abc1234")).toBe(true)
  })

  it("keeps only merges into the default branch, on both forges", async () => {
    const at = new Date(NOW - DAY).toISOString()
    const gl = (async (url: string) => url.endsWith("/projects/acme%2Fapp") ? json({ default_branch: "main" })
      : url.includes("/merge_requests?") ? json([
        { iid: 3, target_branch: "main", merge_commit_sha: "abc1234", merged_at: at },
        { iid: 4, target_branch: "3-stacked", merge_commit_sha: "def5678", merged_at: at },
      ]) : json({}, 404)) as unknown as typeof fetch
    expect((await driftForge({ gitlab: { url: "https://gl.example" } }, gl).merged("gitlab", "acme/app", NOW - 7 * DAY) as MergedChange[]).map((m) => m.ref)).toEqual(["acme/app!3"])
    const gh = (async (url: string) => url.endsWith("/repos/o/r") ? json({ default_branch: "main" })
      : url.includes("/pulls?") ? json([
        { number: 5, base: { ref: "main" }, merge_commit_sha: "abc1234", merged_at: at, updated_at: at },
        { number: 6, base: { ref: "release/1" }, merge_commit_sha: "def5678", merged_at: at, updated_at: at },
      ]) : json({}, 404)) as unknown as typeof fetch
    expect((await driftForge({ github: { apiUrl: "https://api.github.com" } }, gh).merged("github", "o/r", NOW - 7 * DAY) as MergedChange[]).map((m) => m.ref)).toEqual(["o/r#5"])
  })

  it("asks GitHub's compare, and says null when it cannot tell", async () => {
    const fake = (async (url: string) => url.includes("compare/aaaaaaa...bbbbbbb") ? json({ status: "ahead" }) : url.includes("compare/") ? json({ status: "diverged" }) : json({}, 500)) as unknown as typeof fetch
    const f = driftForge({ github: { apiUrl: "https://api.github.com" } }, fake)
    expect(await f.contains("github", "o/r", "aaaaaaa", "bbbbbbb")).toBe(true)
    expect(await f.contains("github", "o/r", "ccccccc", "bbbbbbb")).toBe(false)
    expect(await f.merged("github", "o/r", 0)).toEqual({ error: "HTTP 500" })
    expect(sameCommit("abc1234", "ABC1234def")).toBe(true)
    expect(sameCommit("abc", "abc")).toBe(false)
  })

  it("reads the running commit from this build or a health URL", async () => {
    const fake = (async (url: string) => url.endsWith("/ok") ? json({ build: { commit: "deadbeef" } }) : json({ commit: "nope" })) as unknown as typeof fetch
    const read = liveReader({ field: "build.commit", self: () => "1234567", fetch: fake })
    expect(await read("self")).toEqual({ source: "self", commit: "1234567" })
    expect(await read("https://h/ok")).toEqual({ source: "https://h/ok", commit: "deadbeef" })
    expect((await read("https://h/bad")).commit).toBeNull()
    expect((await liveReader({ field: "commit", self: () => null })("self")).error).toMatch(/does not carry/)
  })
})

describe("the daemon's drift check", () => {
  const merged = [change(1, "aaaaaaa1", { description: "Closes #11" }), change(2, "bbbbbbb2", { branch: "12-x" })]
  const forge = fakeForge(merged, { live1: ["aaaaaaa1"] })
  const read = issues({ 11: { state: "open", labels: ["Review", "Doing"] }, 12: { state: "open", labels: ["Doing"] } })

  function setup(over: Partial<DriftSettings> = {}, sweep: Partial<DriftSweepDeps> = {}) {
    const store = new DriftStore(new Database(":memory:"))
    const told: string[] = []
    const writes: Array<{ issue: number; patch: any }> = []
    const logs: string[] = []
    const base: DriftSweepDeps = {
      ...deps(forge, read),
      settings: { ...DEFAULT_DRIFT_SETTINGS, projects: [project()], ...over },
      store,
      tell: async (title, message) => { told.push(`${title}\n${message}`) },
      writeIssue: async (issue, patch) => { writes.push({ issue: issue.number, patch }); return { ok: true, attempts: [{ kind: "PUT issue", ok: true }] } },
      log: (m) => logs.push(m),
      ...sweep,
    }
    return { store, told, writes, logs, run: (now = NOW) => runDriftSweep({ ...base, now }) }
  }

  it("shadow: tells each drift once, in one notice, logs it, and writes nothing", async () => {
    const s = setup()
    const first = await s.run()
    expect(first).toMatchObject({ projects: 1, drifts: 2, told: 2, written: 0 })
    expect(s.told).toHaveLength(1)
    expect(s.told[0]).toMatch(/^Status drift: 2 issues/)
    expect(s.logs.filter((l) => l.includes("acme/app#1"))).toHaveLength(2)
    const second = await s.run(NOW + 3_600_000)
    expect(second.told).toBe(0)
    expect(s.told).toHaveLength(1)
    expect(s.writes).toEqual([])
  })

  it("a notice that could not be sent is told at the next check", async () => {
    let fail = true
    const s = setup({}, { tell: async () => { if (fail) throw new Error("push down") } })
    expect((await s.run()).told).toBe(0)
    fail = false
    expect((await s.run()).told).toBe(2)
  })

  it("write mode moves only a live issue in writeProjects to Done, once, with the proof", async () => {
    expect((await setup({ write: true }).run()).written).toBe(0) // not in writeProjects
    expect((await setup({ writeProjects: ["acme/app"] }).run()).written).toBe(0) // write off
    const s = setup({ write: true, writeProjects: ["acme/app"] })
    expect((await s.run()).written).toBe(1)
    expect(s.writes).toHaveLength(1)
    expect(s.writes[0].issue).toBe(11)
    expect(s.writes[0].patch.addLabels).toEqual(["Done"])
    expect(s.writes[0].patch.removeLabels.sort()).toEqual(["Doing", "Review"])
    expect(s.writes[0].patch.state).toBeUndefined()
    expect(s.writes[0].patch.note).toContain("aaaaaaa1")
    await s.run(NOW + 3_600_000)
    expect(s.writes).toHaveLength(1)
  })

  it("write mode is gated on the issue's own project, any case", async () => {
    const crossing = fakeForge([change(1, "aaaaaaa1", { description: "Closes acme/other#11" })], { live1: ["aaaaaaa1"] })
    const projects = [project(), project({ project: "acme/other" })]
    const mrSide = setup({ write: true, writeProjects: ["acme/app"], projects }, { forge: crossing })
    expect((await mrSide.run()).written).toBe(0)
    const issueSide = setup({ write: true, writeProjects: ["ACME/Other"], projects }, { forge: crossing })
    expect((await issueSide.run()).written).toBe(1)
  })

  it("writes the scoped Done label when the issue's labels are scoped", async () => {
    const s = setup({ write: true, writeProjects: ["acme/app"] }, { readIssue: issues({ 11: { state: "open", labels: ["Status::Review"] }, 12: { state: "open", labels: ["Doing"] } }) })
    await s.run()
    expect(s.writes[0].patch).toMatchObject({ addLabels: ["Status::Done"], removeLabels: ["Status::Review"] })
  })

  it("a note without the label move is not a write, and is tried again", async () => {
    const s = setup({ write: true, writeProjects: ["acme/app"] }, { writeIssue: async () => ({ ok: true, attempts: [{ kind: "POST comment", ok: true }] }) })
    expect((await s.run()).written).toBe(0)
    expect(s.store.list().find((r) => r.kind === "live-not-done")).toMatchObject({ writtenAt: null, writeTries: 1 })
  })

  it("a write that times out is not tried again: it may still land", async () => {
    vi.useFakeTimers()
    try {
      const s = setup({ write: true, writeProjects: ["acme/app"] }, { writeIssue: () => new Promise(() => {}) })
      const run = s.run()
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + 1)
      expect((await run).written).toBe(0)
      expect(s.store.list().find((r) => r.kind === "live-not-done")).toMatchObject({ writtenAt: null, writeTries: WRITE_TRIES })
    } finally {
      vi.useRealTimers()
    }
  })

  it("a failed write is tried again, up to its limit", async () => {
    const s = setup({ write: true, writeProjects: ["acme/app"] }, { writeIssue: async () => ({ ok: false, error: "HTTP 403", attempts: [{ kind: "PUT issue", ok: false, status: 403 }] }) })
    for (let i = 0; i < WRITE_TRIES + 2; i++) await s.run(NOW + i * 3_600_000)
    expect(s.store.list().find((r) => r.kind === "live-not-done")).toMatchObject({ writtenAt: null, writeTries: WRITE_TRIES, writeError: "HTTP 403" })
  })

  it("off, it reads nothing", async () => {
    let read = 0
    const s = setup({ enabled: false }, { forge: { ...forge, merged: async () => { read++; return [] } } })
    await s.run()
    expect(read).toBe(0)
  })
})

describe("the setting", () => {
  it("defaults to shadow on, no project, write off", () => {
    const s = requestsConfigSchema.parse(undefined).statusDrift
    expect(s).toMatchObject({ enabled: true, projects: [], write: false, writeProjects: [], checkEveryMinutes: 30, lookbackDays: 7 })
    expect(s.labels.done[0]).toBe("Done")
    expect(() => requestsConfigSchema.parse({ statusDrift: { projects: [{ provider: "gitlab", project: "../x" }] } })).toThrow()
  })
})
