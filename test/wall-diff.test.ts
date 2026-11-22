import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { RequestStore } from "../src/requests/store"
import { handleWallAction, isWallActionPath, isWallWrite, type WallActionDeps } from "../src/daemon/wall-actions"
import { createWallForge, diffCommentsMessage, diffHomeOf, handleWallDiff, parseDiffComments, prLinksIn, PRS_TTL_MS, shaOf, WALL_DIFF_PATH, type WallDiffDeps, type WallForge } from "../src/daemon/wall-diff"
import { wallPost } from "../src/daemon/wall-api"

// #2102: a post whose home is a GitHub or GitLab issue (or a PR or MR) finds
// its pull or merge requests and shows a diff, and the owner's line comments
// reach its agent as one message, the way a comment does.

const panel = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: any }> }))
vi.mock("../src/daemon/requests-panel", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/daemon/requests-panel")>()
  return {
    ...real,
    handleRequestsPanel: async (...args: Parameters<typeof real.handleRequestsPanel>) => {
      panel.calls.push({ path: args[1], body: args[2] })
      return real.handleRequestsPanel(...args)
    },
  }
})

const T0 = 1_700_000_000_000
const GITLAB = "https://gitlab.example.com"
const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)
let db: Database.Database
let store: RequestStore
let deps: WallActionDeps
let head: string
let forge: WallForge

const DIFF = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3\n"

const add = (id: string, link: string | null, text = `Work ${id}`) => {
  store.addCandidate({ id, runId: `t-${id}`, channel: "telegram", chatId: "chat-A", sender: "anis", agentId: "coder", text, now: T0 })
  store.progress(id, T0 + 1000)
  if (link) store.setHome(id, { kind: "link", link } as any, T0 + 2000)
}

beforeEach(() => {
  panel.calls = []
  const dir = mkdtempSync(join(tmpdir(), "agentx-wall-diff-"))
  const configPath = join(dir, "agentx.json")
  writeFileSync(configPath, JSON.stringify({ agents: { coder: { name: "Coder" } }, requests: { enabled: true } }))
  db = new Database(":memory:")
  store = new RequestStore(db)
  add("pr", "https://github.com/acme/shop/pull/12")
  add("mr", `${GITLAB}/acme/web/-/merge_requests/7`)
  add("issue", "https://github.com/acme/shop/issues/3")
  add("none", null)
  head = SHA_A
  // A forge whose issue 3 is named by one open PR, #20.
  forge = {
    pull: async (h) => ({ title: `T ${h.key}`, state: "open", headSha: head }),
    linked: async (h) => h.key === "acme/shop#3" ? [{ home: { provider: "github", ref: { project: "acme/shop", number: 20, mr: true }, key: "acme/shop#20" }, title: "Fix", state: "open", headSha: head }] : [],
    diff: async () => DIFF,
  }
  deps = { inbox: { root: dir, configPath, requests: store }, daemon: async () => ({ status: 200, body: {} }), now: () => T0 + 5000, diff: { store, gitlabUrl: GITLAB, forge: { pull: (h) => forge.pull(h), linked: (h) => forge.linked(h), diff: (h) => forge.diff(h) }, cache: new Map() } }
})

/** A forge on the network: GitHub and GitLab answers by path. */
function mockFetch(routes: Record<string, unknown>) {
  const calls: string[] = []
  const f = vi.fn(async (url: string, init?: any) => {
    const u = new URL(url)
    const key = u.origin + u.pathname + (init?.headers?.Accept === "application/vnd.github.diff" ? " diff" : "")
    calls.push(key)
    if (!(key in routes)) return new Response("{}", { status: 404 })
    const v = routes[key]
    return new Response(typeof v === "string" ? v : JSON.stringify(v), { status: 200 })
  })
  return { fetch: f as unknown as typeof fetch, calls }
}

const GH = "https://api.github.com"
const ghPull = (n: number, sha: string, state = "open") => ({ number: n, head: { sha }, title: `PR ${n}`, state, user: { login: "coder" } })
const crossRef = (n: number, extra: Record<string, unknown> = {}) => ({ event: "cross-referenced", source: { type: "issue", issue: { number: n, title: `PR ${n}`, state: "open", pull_request: { url: "x" }, repository: { full_name: "acme/shop" }, ...extra } } })

describe("which posts have a Diff", () => {
  it("a post on a GitHub or GitLab issue, PR or MR; not one without a forge home", () => {
    expect(diffHomeOf(store.get("pr")!, GITLAB)).toMatchObject({ provider: "github", key: "acme/shop#12" })
    expect(diffHomeOf(store.get("mr")!, GITLAB)).toMatchObject({ provider: "gitlab", key: "acme/web!7" })
    expect(diffHomeOf(store.get("issue")!, GITLAB)).toMatchObject({ provider: "github", key: "acme/shop#3", ref: { mr: false } })
    expect(diffHomeOf(store.get("none")!, GITLAB)).toBeNull()
  })

  it("marks the post, so the Hub offers its Diff", () => {
    const wd = { store, db: null, now: T0, staleAfterHours: 24, isAgent: () => true, gitlabUrl: GITLAB } as any
    expect(wallPost(store.get("pr")!, wd).mergeRef).toBe("acme/shop#12")
    expect(wallPost(store.get("issue")!, wd).mergeRef).toBe("acme/shop#3")
    expect(wallPost(store.get("none")!, wd).mergeRef).toBeNull()
  })

  it("finds PR and MR links in text, on the home's forge only", () => {
    const t = `see https://github.com/acme/shop/pull/30, and ${GITLAB}/g/sub/p/-/merge_requests/4 and https://github.com/acme/shop/issues/5`
    const ghHome = { provider: "github" as const, ref: { project: "acme/shop", number: 3, mr: false } }
    const glHome = { provider: "gitlab" as const, ref: { project: "g/sub/p", number: 1, mr: false } }
    expect(prLinksIn([t], ghHome, GITLAB).map((h) => h.key)).toEqual(["acme/shop#30"])
    expect(prLinksIn([t], glHome, GITLAB).map((h) => h.key)).toEqual(["g/sub/p!4"])
    expect(prLinksIn([t], glHome, null)).toEqual([])
  })

  it("keeps links to the home's own repository or project only, and drops dot segments", () => {
    const ghHome = { provider: "github" as const, ref: { project: "acme/shop", number: 3, mr: false } }
    const t = "https://github.com/other/lib/pull/9 https://github.com/ACME/Shop/pull/31 https://github.com/acme/../pull/7 https://github.com/./shop/pull/8 https://github.com/acme/shop.old/pull/6"
    expect(prLinksIn([t], ghHome, GITLAB).map((h) => h.key)).toEqual(["acme/shop#31"])
    const glHome = { provider: "gitlab" as const, ref: { project: "g/p", number: 1, mr: false } }
    const g = `${GITLAB}/g/other/-/merge_requests/2 ${GITLAB}/g/p/-/merge_requests/3 ${GITLAB}/g/../p/-/merge_requests/4 ${GITLAB}/g/p/./-/merge_requests/5`
    expect(prLinksIn([g], glHome, GITLAB).map((h) => h.key)).toEqual(["g/p!3"])
    // A home path with a dot segment has no Diff.
    add("dots", "https://github.com/acme/../issues/3")
    expect(diffHomeOf(store.get("dots")!, GITLAB)).toBeNull()
  })
})

describe("GET diff: an issue's pull and merge requests", () => {
  const gh = (fetchImpl: typeof fetch, cache = new Map()): WallDiffDeps => ({ store, gitlabUrl: GITLAB, forge: createWallForge({ githubToken: "t", gitlabUrl: GITLAB, gitlabToken: "g" }, fetchImpl), cache, now: () => T0 })

  it("finds the PRs that cross-reference the issue on GitHub, open first, and gives the first open one's diff", async () => {
    const m = mockFetch({
      [`${GH}/repos/acme/shop/issues/3/timeline`]: [
        { event: "labeled" },
        crossRef(21, { state: "closed", pull_request: { merged_at: "2026-01-01" } }),
        crossRef(20),
        crossRef(5, { pull_request: undefined }),
        crossRef(40, { repository: { full_name: "other/repo" } }),
        crossRef(20),
      ],
      [`${GH}/repos/acme/shop/pulls/20`]: ghPull(20, SHA_A),
      [`${GH}/repos/acme/shop/pulls/21`]: ghPull(21, SHA_B, "closed"),
      [`${GH}/repos/acme/shop/pulls/20 diff`]: DIFF,
    })
    const r = await handleWallDiff({ id: "issue" }, gh(m.fetch))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      prs: [
        { ref: "acme/shop#20", title: "PR 20", state: "open", headSha: SHA_A },
        { ref: "acme/shop#21", title: "PR 21", state: "merged", headSha: SHA_B },
      ],
      ref: "acme/shop#20", provider: "github", headSha: SHA_A, truncated: false, files: [{ file: "src/app.ts" }],
    })
    expect((r.body as any).prs).toHaveLength(2)
  })

  it("gives the diff of the PR asked for, and refuses one not in the list", async () => {
    const m = mockFetch({
      [`${GH}/repos/acme/shop/issues/3/timeline`]: [crossRef(20), crossRef(21, { state: "closed", pull_request: {} })],
      [`${GH}/repos/acme/shop/pulls/20`]: ghPull(20, SHA_A),
      [`${GH}/repos/acme/shop/pulls/21`]: ghPull(21, SHA_B, "closed"),
      [`${GH}/repos/acme/shop/pulls/21 diff`]: DIFF,
    })
    const d = gh(m.fetch)
    const r = await handleWallDiff({ id: "issue", pr: "acme/shop#21" }, d)
    expect(r.body).toMatchObject({ ref: "acme/shop#21", state: "closed", headSha: SHA_B })
    expect(m.calls).toContain(`${GH}/repos/acme/shop/pulls/21 diff`)
    expect(await handleWallDiff({ id: "issue", pr: "acme/shop#99" }, d)).toEqual({ status: 400, body: { error: "acme/shop#99 is not a pull or merge request of this post" } })
  })

  it("finds the related merge requests of a GitLab issue", async () => {
    add("gl", `${GITLAB}/acme/web/-/issues/4`)
    const m = mockFetch({
      [`${GITLAB}/api/v4/projects/acme%2Fweb/issues/4/related_merge_requests`]: [{ iid: 9, title: "Fix it", state: "opened", sha: SHA_B, references: { full: "acme/web!9" } }],
      [`${GITLAB}/api/v4/projects/acme%2Fweb/merge_requests/9`]: { iid: 9, sha: SHA_B, title: "Fix it", state: "opened" },
      [`${GITLAB}/api/v4/projects/acme%2Fweb/merge_requests/9/diffs`]: [{ old_path: "src/app.ts", new_path: "src/app.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" }],
    })
    const r = await handleWallDiff({ id: "gl" }, gh(m.fetch))
    expect(r).toMatchObject({ status: 200, body: { prs: [{ ref: "acme/web!9", title: "Fix it", state: "open", headSha: SHA_B }], ref: "acme/web!9", provider: "gitlab", headSha: SHA_B, files: [{ file: "src/app.ts" }] } })
  })

  it("answers an empty list when nothing names the issue", async () => {
    const m = mockFetch({ [`${GH}/repos/acme/shop/issues/3/timeline`]: [] })
    expect(await handleWallDiff({ id: "issue" }, gh(m.fetch))).toEqual({ status: 200, body: { prs: [], ref: null, provider: "github", title: null, state: null, headSha: null, files: [], truncated: false } })
  })

  it("finds a PR named in the request's own words, and keeps the list a minute", async () => {
    add("named", "https://github.com/acme/shop/issues/3", "Done in https://github.com/acme/shop/pull/30.")
    const m = mockFetch({
      [`${GH}/repos/acme/shop/issues/3/timeline`]: [],
      [`${GH}/repos/acme/shop/pulls/30`]: ghPull(30, SHA_A),
      [`${GH}/repos/acme/shop/pulls/30 diff`]: DIFF,
    })
    let now = T0
    const d = { ...gh(m.fetch), now: () => now }
    expect((await handleWallDiff({ id: "named" }, d)).body).toMatchObject({ prs: [{ ref: "acme/shop#30" }], ref: "acme/shop#30" })
    const timeline = () => m.calls.filter((c) => c.endsWith("/timeline")).length
    expect(timeline()).toBe(1)
    now += 30_000
    await handleWallDiff({ id: "named" }, d)
    expect(timeline()).toBe(1)
    now += PRS_TTL_MS
    await handleWallDiff({ id: "named" }, d)
    expect(timeline()).toBe(2)
  })

  it("an open PR of another repo named in passing is not the default diff nor listed", async () => {
    add("passing", "https://github.com/acme/shop/issues/3", "Like https://github.com/other/lib/pull/9; done in https://github.com/acme/shop/pull/30.")
    const m = mockFetch({
      [`${GH}/repos/acme/shop/issues/3/timeline`]: [],
      [`${GH}/repos/acme/shop/pulls/30`]: ghPull(30, SHA_A, "closed"),
      [`${GH}/repos/other/lib/pulls/9`]: ghPull(9, SHA_B),
      [`${GH}/repos/acme/shop/pulls/30 diff`]: DIFF,
    })
    const r = await handleWallDiff({ id: "passing" }, gh(m.fetch))
    expect(r.body).toMatchObject({ prs: [{ ref: "acme/shop#30" }], ref: "acme/shop#30" })
    expect((r.body as any).prs).toHaveLength(1)
    expect(m.calls.some((c) => c.includes("other/lib"))).toBe(false)
    expect((await handleWallDiff({ id: "passing", pr: "other/lib#9" }, gh(m.fetch))).status).toBe(400)
  })

  it("a PR home lists itself, with no timeline read", async () => {
    const m = mockFetch({ [`${GH}/repos/acme/shop/pulls/12`]: ghPull(12, SHA_A), [`${GH}/repos/acme/shop/pulls/12 diff`]: DIFF })
    const r = await handleWallDiff({ id: "pr" }, gh(m.fetch))
    expect(r.body).toMatchObject({ prs: [{ ref: "acme/shop#12", headSha: SHA_A }], ref: "acme/shop#12", files: [{ file: "src/app.ts", status: "modified" }] })
    expect(m.calls.some((c) => c.endsWith("/timeline"))).toBe(false)
  })

  it("answers 400 without a forge home or an id, 404 for an unknown post", async () => {
    const d = gh(mockFetch({}).fetch)
    expect(await handleWallDiff({ id: "none" }, d)).toMatchObject({ status: 400 })
    expect((await handleWallDiff({}, d)).status).toBe(400)
    expect((await handleWallDiff({ id: "nope" }, d)).status).toBe(404)
    expect((await handleWallDiff({ id: "pr" }, null)).status).toBe(404)
  })

  it("says the forge failed when the list or the diff cannot be read", async () => {
    expect(await handleWallDiff({ id: "issue" }, gh(mockFetch({}).fetch))).toMatchObject({ status: 502, body: { error: expect.stringContaining("404") } })
    const m = mockFetch({ [`${GH}/repos/acme/shop/pulls/12`]: ghPull(12, SHA_A) })
    expect(await handleWallDiff({ id: "pr" }, gh(m.fetch))).toMatchObject({ status: 502, body: { error: expect.stringContaining("did not give the diff") } })
  })

  it("flags a diff past the line cap", async () => {
    const big = `--- a/x\n+++ b/x\n@@ -0,0 +1,4000 @@\n${Array.from({ length: 4000 }, (_, i) => `+l${i}`).join("\n")}\n`
    forge.diff = async () => big
    const r = await handleWallAction("GET", WALL_DIFF_PATH, { id: "mr" }, deps)
    expect(r!.body).toMatchObject({ ref: "acme/web!7", provider: "gitlab", truncated: true, files: [{ truncated: true }] })
    expect((r!.body as any).files[0].hunks[0].lines).toHaveLength(3000)
  })

  it("is a Wall route but a read: not a Wall write, and only GET", async () => {
    expect(isWallActionPath(WALL_DIFF_PATH)).toBe(true)
    expect(isWallWrite("GET", WALL_DIFF_PATH)).toBe(false)
    expect((await handleWallAction("POST", WALL_DIFF_PATH, { id: "pr" }, deps))!.status).toBe(405)
  })
})

describe("POST diff-comments", () => {
  const post = (body: Record<string, unknown>) => handleWallAction("POST", "/api/admin/wall/diff-comments", body, deps)
  const comment = (extra: Record<string, unknown> = {}) => ({ file: "src/app.ts", side: "new", line: 2, text: "Why 3?", ...extra })
  const kept = () => (db.prepare("SELECT proof FROM request_links WHERE kind = 'comment'").all() as Array<{ proof: string }>).map((r) => r.proof)

  it("is a Wall write, under the owner's guard", () => {
    expect(isWallActionPath("/api/admin/wall/diff-comments")).toBe(true)
    expect(isWallWrite("POST", "/api/admin/wall/diff-comments")).toBe(true)
  })

  it("refuses a bad body", async () => {
    expect((await post({ comments: [comment()] }))!.status).toBe(400)
    expect((await post({ id: "pr", comments: [] }))!.status).toBe(400)
    expect((await post({ id: "pr", comments: Array.from({ length: 51 }, () => comment()) }))!.status).toBe(400)
    expect((await post({ id: "pr", comments: [comment({ text: "  " })] }))!.status).toBe(400)
    expect((await post({ id: "pr", comments: [comment({ text: "x".repeat(2001) })] }))!.status).toBe(400)
    expect((await post({ id: "pr", comments: [comment({ line: 0 })] }))!.status).toBe(400)
    expect((await post({ id: "pr", comments: [comment({ line: 1.5 })] }))!.status).toBe(400)
    expect((await post({ id: "pr", comments: [comment({ side: "left" })] }))!.status).toBe(400)
    expect((await post({ id: "pr", comments: [comment({ file: "" })] }))!.status).toBe(400)
    expect(panel.calls).toEqual([])
  })

  it("refuses a post with no forge home, an unknown post, a PR not in its list, and an issue with none", async () => {
    expect((await post({ id: "none", comments: [comment()] }))!.status).toBe(400)
    expect((await post({ id: "nope", comments: [comment()] }))!.status).toBe(404)
    expect(await post({ id: "issue", pr: "acme/shop#99", comments: [comment()] })).toMatchObject({ status: 400, body: { error: expect.stringContaining("not a pull or merge request of this post") } })
    forge.linked = async () => []
    deps.diff!.cache = new Map()
    expect(await post({ id: "issue", comments: [comment()] })).toEqual({ status: 400, body: { error: "No pull or merge request names this issue yet" } })
    expect(panel.calls).toEqual([])
  })

  it("builds one message naming the commit, in the order given, and hands it over as a comment is", async () => {
    const r = await post({ id: "pr", pr: "acme/shop#12", headSha: SHA_A, comments: [
      comment({ code: "const b = 3", text: "Why 3?" }),
      { file: "src/app.ts", side: "old", line: 2, text: "Keep this one" },
    ] })
    expect(r).toMatchObject({ status: 200, body: { ok: true, agentId: "coder" } })
    expect((r!.body as any).moved).toBeUndefined()
    const text = [
      "Review comments on acme/shop#12 on commit aaaaaaaaaaaa, from the Hub:",
      "1. `src/app.ts:2` (new)\n> const b = 3\nWhy 3?",
      "2. `src/app.ts:2` (old)\nKeep this one",
      "Please address all 2 of them on the pull request's branch, push, and reply here when done.",
    ].join("\n\n")
    expect(panel.calls).toEqual([{ path: "/api/admin/approvals/requests/reply", body: { id: "pr", text } }])
    expect(store.get("pr")).toMatchObject({ state: "in_progress", ownerNote: text })
  })

  it("sends an issue's comments on its open PR, and says when the head moved since the lines were read", async () => {
    head = SHA_B
    const r = await post({ id: "issue", headSha: SHA_A, comments: [comment()] })
    expect(r).toMatchObject({ status: 200, body: { ok: true, moved: true, headSha: SHA_B } })
    const text = panel.calls[0].body.text
    expect(text).toContain("Review comments on acme/shop#20 on commit aaaaaaaaaaaa, from the Hub:")
    expect(text).toContain("Note: the PR has moved to bbbbbbbbbbbb since these lines were read.")
  })

  it("keeps a 10,000-character batch whole, and refuses one above 16,000", async () => {
    const big = Array.from({ length: 6 }, (_, i) => comment({ line: i + 1, text: String(i).repeat(1700) }))
    const r = await post({ id: "pr", headSha: SHA_A, comments: big })
    expect(r!.status).toBe(200)
    const text = panel.calls[0].body.text as string
    expect(text.length).toBeGreaterThan(10_000)
    expect(store.get("pr")!.ownerNote).toBe(text)
    expect(kept()).toEqual([text])
    const huge = Array.from({ length: 9 }, (_, i) => comment({ line: i + 1, text: "z".repeat(1990) }))
    expect(await post({ id: "pr", comments: huge })).toMatchObject({ status: 400, body: { error: expect.stringContaining("more than 16000 characters") } })
    // The plain comment keeps its own limit.
    expect((await handleWallAction("POST", "/api/admin/wall/comment", { id: "pr", text: "x".repeat(4001) }, deps))!.status).toBe(400)
  })

  it("keeps a long batch whole when it opens a closed post again", async () => {
    store.close("pr", "done", "done", T0 + 3000, null, "owner")
    const big = Array.from({ length: 6 }, (_, i) => comment({ line: i + 1, text: "y".repeat(1700) }))
    const r = await post({ id: "pr", comments: big })
    expect(r).toMatchObject({ status: 200, body: { reopened: true } })
    expect(store.get("pr")!.ownerNote!.length).toBeGreaterThan(10_000)
    expect(kept()[0]).toBe(store.get("pr")!.ownerNote)
  })

  it("goes the same way as wall/comment", async () => {
    await handleWallAction("POST", "/api/admin/wall/comment", { id: "mr", text: "hello" }, deps)
    await post({ id: "mr", comments: [comment()] })
    expect(panel.calls.map((c) => c.path)).toEqual(["/api/admin/approvals/requests/reply", "/api/admin/approvals/requests/reply"])
    expect(panel.calls[1].body.text).toContain("Review comments on acme/web!7")
    expect(panel.calls[1].body.text).toContain("on the merge request's branch")
  })

  it("both routes sit under /api/admin/, where the board's peer proxy sends a peer's post to its node, as wall/comment", () => {
    for (const p of [WALL_DIFF_PATH, "/api/admin/wall/diff-comments", "/api/admin/wall/comment"]) {
      expect(p.startsWith("/api/admin/")).toBe(true)
      expect(isWallActionPath(p)).toBe(true)
    }
  })
})

describe("message helpers", () => {
  it("parseDiffComments keeps a code line on one line, capped", () => {
    const r = parseDiffComments([{ file: " a.ts ", side: "new", line: 1, text: " t ", code: "  x\n  y  " }])
    expect(r).toEqual({ comments: [{ file: "a.ts", side: "new", line: 1, text: "t", code: "x y" }] })
  })

  it("diffCommentsMessage words one comment", () => {
    expect(diffCommentsMessage({ provider: "gitlab", key: "g/p!1" }, [{ file: "a", side: "new", line: 3, text: "t" }]))
      .toBe("Review comments on g/p!1, from the Hub:\n\n1. `a:3` (new)\nt\n\nPlease address it on the merge request's branch, push, and reply here when done.")
    expect(diffCommentsMessage({ provider: "gitlab", key: "g/p!1" }, [{ file: "a", side: "new", line: 3, text: "t" }], { commit: SHA_A, movedTo: SHA_B }))
      .toContain("on commit aaaaaaaaaaaa, from the Hub:\n\n1. `a:3` (new)\nt\n\nNote: the MR has moved to bbbbbbbbbbbb since these lines were read.")
  })

  it("shaOf takes a hex sha only", () => {
    expect(shaOf(` ${SHA_A.toUpperCase()} `)).toBe(SHA_A)
    expect(shaOf("not-a-sha")).toBeNull()
    expect(shaOf(12)).toBeNull()
  })
})
