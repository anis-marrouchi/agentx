import { describe, expect, it, vi } from "vitest"
import {
  PER_KIND, forgeTaskSources, forgeTasks, forgeTasksReader, githubTasksReader, gitlabTasksReader,
  type ForgeTask, type ForgeTasksReader,
} from "../src/daemon/hub-forge-tasks"

// The Hub's Tasks from the forges (#2226): which projects, GitHub through a
// mocked `gh`, GitLab through a mocked fetch, and the minute's cache.
// Made-up names only.

const NOW = Date.UTC(2026, 10, 26, 9)
const iso = (ms: number) => new Date(ms).toISOString()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

describe("which projects Tasks lists", () => {
  it("GitHub routes, GitLab routes and GitLab boards; no wildcard, no duplicates", () => {
    const config: any = {
      channels: {
        github: { routes: [{ repo: "acme/shop", agent: "a" }, { repo: "*", agent: "b" }, { repo: "acme/shop", agent: "c" }] },
        gitlab: { host: "https://gitlab.example", routes: [{ project: "grp/app", agent: "a" }] },
      },
      boards: [{ source: { type: "gitlab", projects: ["grp/app", "grp/site"] } }],
    }
    expect(forgeTaskSources(config)).toEqual([
      { forge: "github", project: "acme/shop" }, { forge: "gitlab", project: "grp/app" }, { forge: "gitlab", project: "grp/site" },
    ])
  })
  it("a channel turned off, or none: nothing from it", () => {
    expect(forgeTaskSources({ channels: { github: { enabled: false, routes: [{ repo: "acme/shop", agent: "a" }] } } } as any)).toEqual([])
    expect(forgeTaskSources({ channels: {} } as any)).toEqual([])
  })
})

describe("GitHub through the gh login", () => {
  it("open issues then open PRs, newest kept, mapped", async () => {
    const run = vi.fn(async (args: string[]) => JSON.stringify(args[0] === "issue"
      ? [{ number: 7, title: "Cart total", url: "https://github.example/acme/shop/issues/7", author: { login: "sam" }, assignees: [{ login: "coder" }], labels: [{ name: "bug" }], updatedAt: iso(NOW) }]
      : [{ number: 9, title: "Fix cart", url: "https://github.example/acme/shop/pull/9", author: { login: "coder" }, assignees: [], labels: [], updatedAt: iso(NOW - 1000), isDraft: true, reviewDecision: "CHANGES_REQUESTED" }]))
    const got = await githubTasksReader(run)("acme/shop") as ForgeTask[]
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0][0]).toEqual(["issue", "list", "--repo", "acme/shop", "--state", "open", "--limit", String(PER_KIND), "--json", "number,title,url,author,assignees,labels,updatedAt"])
    expect(run.mock.calls[1][0].slice(0, 4)).toEqual(["pr", "list", "--repo", "acme/shop"])
    expect(run.mock.calls[1][0].at(-1)).toContain("isDraft,reviewDecision")
    expect(got[0]).toEqual({
      id: "github:acme/shop#7", forge: "github", kind: "issue", project: "acme/shop", number: 7, title: "Cart total",
      url: "https://github.example/acme/shop/issues/7", author: "sam", assignees: ["coder"], labels: ["bug"], updatedAt: NOW,
    })
    expect(got[1]).toMatchObject({ id: "github:acme/shop#9", kind: "pr", draft: true, review: "changes_requested" })
  })
  it("drops links that are not http(s)", async () => {
    const got = await githubTasksReader(async () => JSON.stringify([{ number: 1, title: "x", url: "javascript:alert(1)" }]))("acme/shop")
    expect(got).toEqual([])
  })
  it("gh failing (not logged in, no repo): the reason, never a throw", async () => {
    const got = await githubTasksReader(async () => { throw new Error("gh auth login required") })("acme/shop")
    expect(got).toEqual({ error: "gh auth login required" })
  })
})

describe("GitLab with the channel's token", () => {
  it("issues then merge requests, the project path encoded, PRIVATE-TOKEN", async () => {
    const doFetch = vi.fn(async (url: string, _init?: RequestInit) => json(url.includes("/issues?")
      ? [{ iid: 3, title: "Login", web_url: "https://gitlab.example/grp/app/-/issues/3", author: { username: "ana" }, assignees: [], labels: ["Status::Doing"], updated_at: iso(NOW) }]
      : [{ iid: 4, title: "Login fix", web_url: "https://gitlab.example/grp/app/-/merge_requests/4", author: { username: "dev" }, assignees: [{ username: "dev" }], labels: [], updated_at: iso(NOW), draft: false }]))
    const got = await gitlabTasksReader({ url: "https://gitlab.example/", token: "gl-secret" }, doFetch as any)("grp/app") as ForgeTask[]
    expect(doFetch.mock.calls.map((c) => c[0])).toEqual([
      `https://gitlab.example/api/v4/projects/grp%2Fapp/issues?state=opened&order_by=updated_at&sort=desc&per_page=${PER_KIND}`,
      `https://gitlab.example/api/v4/projects/grp%2Fapp/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=${PER_KIND}`,
    ])
    expect((doFetch.mock.calls[0][1]!.headers as any)["PRIVATE-TOKEN"]).toBe("gl-secret")
    expect(got.map((t) => t.id)).toEqual(["gitlab:grp/app#3", "gitlab:grp/app!4"])
    expect(got[0]).toMatchObject({ kind: "issue", labels: ["Status::Doing"], author: "ana" })
    expect(got[1]).toMatchObject({ kind: "pr", draft: false, assignees: ["dev"] })
  })
  it("errors in words", async () => {
    const read = (f: any) => gitlabTasksReader({ url: "https://gitlab.example" }, f)("grp/app")
    expect(await read(async () => json({}, 404))).toEqual({ error: "not found (or not visible to the token)" })
    expect(await read(async () => json({}, 401))).toEqual({ error: "HTTP 401" })
    expect(await read(async () => { throw new Error("ECONNREFUSED") })).toEqual({ error: "could not be reached: ECONNREFUSED" })
  })
  it("no GitLab channel: GitLab projects say so", async () => {
    const reader = forgeTasksReader({ channels: {} } as any, async () => "[]")
    expect(await reader({ forge: "gitlab", project: "grp/app" })).toEqual({ error: "no GitLab channel on this computer" })
  })
})

describe("cached a minute, last good answer kept", () => {
  const task = (id: string, at: number): ForgeTask => ({ id, forge: "github", kind: "issue", project: "acme/shop", number: 1, title: id, url: "https://x.example/" + id, author: null, assignees: [], labels: [], updatedAt: at })
  it("a second read within the minute does not ask the forge; after it, it does", async () => {
    let t = NOW
    const read = vi.fn<ForgeTasksReader>(async () => [task("a", NOW)])
    const src = forgeTasks([{ forge: "github", project: "acme/shop" }], read, { clock: () => t })
    expect((await src.read()).items.map((i) => i.id)).toEqual(["a"])
    t += 30_000
    await src.read()
    expect(read).toHaveBeenCalledTimes(1)
    t += 31_000
    await src.read()
    expect(read).toHaveBeenCalledTimes(2)
  })
  it("a project that fails is named, its last good tasks kept; others sorted newest first", async () => {
    let t = NOW
    let fail = false
    const read: ForgeTasksReader = async (s) => s.project === "grp/app"
      ? (fail ? { error: "HTTP 502" } : [task("old", NOW - 5000)])
      : [task("new", NOW)]
    const src = forgeTasks([{ forge: "gitlab", project: "grp/app" }, { forge: "github", project: "acme/shop" }], read, { clock: () => t })
    expect((await src.read()).unread).toEqual([])
    fail = true
    t += 61_000
    const got = await src.read()
    expect(got.unread).toEqual([{ forge: "gitlab", project: "grp/app", why: "HTTP 502" }])
    expect(got.items.map((i) => i.id)).toEqual(["new", "old"])
  })
  it("a read past the time box: said as late, pending, then answered", async () => {
    let release!: () => void
    const read: ForgeTasksReader = () => new Promise((r) => { release = () => r([task("slow", NOW)]) })
    const src = forgeTasks([{ forge: "github", project: "acme/shop" }], read, { budgetMs: 5 })
    const first = await src.read()
    expect(first.pending).toBe(true)
    expect(first.unread[0]).toMatchObject({ late: true })
    release()
    await new Promise((r) => setTimeout(r, 0))
    const second = await src.read()
    expect(second.items.map((i) => i.id)).toEqual(["slow"])
    expect(second.pending).toBeUndefined()
  })
})
