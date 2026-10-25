import { describe, expect, it, vi } from "vitest"
import {
  forgeTimeFlags, gitlabRefOf, gitlabTimeReader, hm, wallForgeTime, type ForgeTimeReader,
} from "../src/daemon/wall-forge-time"
import { withForgeTime, type WallPost } from "../src/daemon/wall-api"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"

// The Wall's forge time (#1189): GitLab time logged vs estimate per post,
// read only, against a mocked forge.

const GL = "https://gitlab.example.com"
const H = 3_600_000
const NOW = Date.UTC(2026, 9, 24, 12)

function post(over: Partial<WallPost> = {}): WallPost {
  return {
    id: "r1", state: "in_progress", headline: "Fix it", need: "", owner: "coder", agentId: "coder", askedBy: null,
    group: { channel: "telegram", chatId: "chat-A" }, project: "acme/web",
    home: { kind: "issue", link: `${GL}/acme/web/-/issues/42` },
    createdAt: NOW - 5 * H, updatedAt: NOW - H, lastMoveAt: NOW - H, closedAt: null, evidence: null, closeReason: null,
    blocked: null, estimateMinutes: null, runMs: 0, runs: 1, failedRuns: 0, timeFlag: null, forgeTime: null, lastRun: null,
    ...over,
  }
}

const stats = (spentMin: number, estimateMin: number) => ({ spentSeconds: spentMin * 60, estimateSeconds: estimateMin * 60 })

describe("which posts have GitLab time", () => {
  it("reads an issue or merge request home on the connector's host", () => {
    expect(gitlabRefOf(post(), GL)).toEqual({ project: "acme/web", kind: "issue", iid: 42 })
    expect(gitlabRefOf(post({ home: { kind: "issue", link: `${GL}/acme/sub/api/-/merge_requests/9#note_1` } }), GL))
      .toEqual({ project: "acme/sub/api", kind: "merge_request", iid: 9 })
  })

  it("reads a GitLab chat when the home link is not there", () => {
    expect(gitlabRefOf(post({ home: null, group: { channel: "gitlab", chatId: "acme/api:merge_request:7" } }), GL))
      .toEqual({ project: "acme/api", kind: "merge_request", iid: 7 })
  })

  it("leaves out homes without time tracking: GitHub, another host, no home", () => {
    expect(gitlabRefOf(post({ home: { kind: "issue", link: "https://github.com/acme/web/issues/42" } }), GL)).toBeNull()
    expect(gitlabRefOf(post({ home: { kind: "issue", link: "https://gitlab.other.example/acme/web/-/issues/42" } }), GL)).toBeNull()
    expect(gitlabRefOf(post({ home: null }), GL)).toBeNull()
  })
})

describe("mismatch flags", () => {
  it("flags no time on active work and on done work", () => {
    expect(forgeTimeFlags(post(), stats(0, 60), NOW, 24)).toEqual(["no time logged on active work"])
    expect(forgeTimeFlags(post({ state: "done" }), stats(0, 0), NOW, 24)).toEqual(["closed with no time logged"])
    // Not started yet (no run) or dropped: nothing to flag.
    expect(forgeTimeFlags(post({ runs: 0 }), stats(0, 60), NOW, 24)).toEqual([])
    expect(forgeTimeFlags(post({ state: "dropped" }), stats(0, 60), NOW, 24)).toEqual([])
  })

  it("flags time over the estimate", () => {
    expect(forgeTimeFlags(post(), stats(150, 120), NOW, 24)).toEqual(["over estimate: 2 h 30 min logged of 2 h"])
    expect(forgeTimeFlags(post(), stats(90, 120), NOW, 24)).toEqual([])
    expect(forgeTimeFlags(post(), stats(90, 0), NOW, 24)).toEqual([])
  })

  it("flags time logged on open work with no recent move", () => {
    expect(forgeTimeFlags(post({ lastMoveAt: NOW - 50 * H }), stats(30, 60), NOW, 24)).toEqual(["time logged, no move for 2 d"])
    expect(forgeTimeFlags(post({ state: "done", lastMoveAt: NOW - 50 * H }), stats(30, 60), NOW, 24)).toEqual([])
  })

  it("writes minutes as hours and minutes", () => {
    expect(hm(45)).toBe("45 min")
    expect(hm(60)).toBe("1 h")
    expect(hm(95)).toBe("1 h 35 min")
  })
})

describe("the GitLab reader", () => {
  it("reads time_stats with the connector token, and nothing else", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ time_estimate: 3600, total_time_spent: 5400 }), { status: 200 }))
    const read = gitlabTimeReader({ url: `${GL}/`, token: "glpat-test" }, fetchMock as unknown as typeof fetch)
    expect(await read({ project: "acme/web", kind: "merge_request", iid: 9 })).toEqual({ estimateSeconds: 3600, spentSeconds: 5400 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${GL}/api/v4/projects/acme%2Fweb/merge_requests/9/time_stats`)
    expect(init.method ?? "GET").toBe("GET")
    expect((init.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-test")
  })

  it("turns forge errors into an error, never stats", async () => {
    const notFound = gitlabTimeReader({ url: GL }, (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch)
    expect(await notFound({ project: "a/b", kind: "issue", iid: 1 })).toEqual({ error: "not found (or not visible to the connector)" })
    const down = gitlabTimeReader({ url: GL }, (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch)
    expect(await down({ project: "a/b", kind: "issue", iid: 1 })).toEqual({ error: "could not be reached: ECONNREFUSED" })
    const odd = gitlabTimeReader({ url: GL }, (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch)
    expect(await odd({ project: "a/b", kind: "issue", iid: 1 })).toEqual({ error: "no time stats in the answer" })
  })
})

describe("posts with forge time", () => {
  it("sets logged vs estimate and flags on GitLab posts, null on others", async () => {
    const read: ForgeTimeReader = async () => stats(150, 120)
    const posts = [post(), post({ id: "r2", home: { kind: "issue", link: "https://github.com/acme/web/issues/1" } })]
    await wallForgeTime(GL, read).annotate(posts, NOW, 24)
    expect(posts[0].forgeTime).toEqual({
      ref: "acme/web#42", loggedMinutes: 150, estimateMinutes: 120, flags: ["over estimate: 2 h 30 min logged of 2 h"], unknown: null,
    })
    expect(posts[1].forgeTime).toBeNull()
  })

  it("shows unknown when the forge errors or is too slow, and flags nothing", async () => {
    const failing = wallForgeTime(GL, async () => ({ error: "HTTP 500" }))
    const [p] = await failing.annotate([post()], NOW, 24)
    expect(p.forgeTime).toEqual({ ref: "acme/web#42", loggedMinutes: null, estimateMinutes: null, flags: [], unknown: "HTTP 500" })

    const slow = wallForgeTime(GL, () => new Promise((r) => setTimeout(() => r(stats(1, 1)), 200)), { budgetMs: 20 })
    const [q] = await slow.annotate([post()], NOW, 24)
    expect(q.forgeTime?.unknown).toBe("GitLab did not answer in time")
    await new Promise((r) => setTimeout(r, 250))
    // The late answer is kept for the next refresh.
    const [again] = await slow.annotate([post()], NOW, 24)
    expect(again.forgeTime?.loggedMinutes).toBe(1)
  })

  it("caches answers between refreshes and caps reads per refresh", async () => {
    const read = vi.fn<ForgeTimeReader>(async () => stats(10, 60))
    const source = wallForgeTime(GL, read, { maxReads: 2 })
    const many = () => [1, 2, 3].map((n) => post({ id: `r${n}`, home: { kind: "issue", link: `${GL}/acme/web/-/issues/${n}` } }))
    const first = await source.annotate(many(), NOW, 24)
    expect(read).toHaveBeenCalledTimes(2)
    expect(first[2].forgeTime?.unknown).toMatch(/not read yet/)
    const second = await source.annotate(many(), NOW, 24)
    expect(read).toHaveBeenCalledTimes(3)
    expect(second.every((p) => p.forgeTime?.loggedMinutes === 10)).toBe(true)
  })

  it("fills a Wall reply's posts and a thread's post, and leaves them without a source", async () => {
    const deps = { now: NOW, staleAfterHours: 24 } as any
    const source = wallForgeTime(GL, async () => stats(0, 30))
    const list = await withForgeTime({ status: 200, body: { posts: [post()] } }, deps, source) as any
    expect(list.body.posts[0].forgeTime.flags).toEqual(["no time logged on active work"])
    const thread = await withForgeTime({ status: 200, body: { post: post(), events: [] } }, deps, source) as any
    expect(thread.body.post.forgeTime.loggedMinutes).toBe(0)
    const none = await withForgeTime({ status: 200, body: { posts: [post()] } }, deps, null) as any
    expect(none.body.posts[0].forgeTime).toBeNull()
  })
})

describe("the saved per-owner view", () => {
  it("counts GitLab time mismatches under Time flags only", () => {
    expect(WALL_PAGE_SCRIPT).toContain("if (f.time && !p.timeFlag && !forgeFlags(p).length) return false;")
    expect(WALL_PAGE_SCRIPT).toContain("GitLab time: ' + esc(forgeFlags(p).join('; '))")
  })
})
