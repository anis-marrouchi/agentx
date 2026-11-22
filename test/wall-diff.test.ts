import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { RequestStore } from "../src/requests/store"
import { handleWallAction, isWallActionPath, isWallWrite, type WallActionDeps } from "../src/daemon/wall-actions"
import { diffCommentsMessage, handleWallDiff, mergeHomeOf, parseDiffComments, WALL_DIFF_PATH, type WallDiffDeps } from "../src/daemon/wall-diff"
import { wallPost } from "../src/daemon/wall-api"

// #2102: a post whose home is a PR or MR shows its diff, and the owner's
// line comments reach its agent as one message, the way a comment does.

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
let store: RequestStore
let deps: WallActionDeps

const DIFF = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3\n"

beforeEach(() => {
  panel.calls = []
  const dir = mkdtempSync(join(tmpdir(), "agentx-wall-diff-"))
  const configPath = join(dir, "agentx.json")
  writeFileSync(configPath, JSON.stringify({ agents: { coder: { name: "Coder" } }, requests: { enabled: true } }))
  store = new RequestStore(new Database(":memory:"))
  const add = (id: string, link: string | null) => {
    store.addCandidate({ id, runId: `t-${id}`, channel: "telegram", chatId: "chat-A", sender: "anis", agentId: "coder", text: `Work ${id}`, now: T0 })
    store.progress(id, T0 + 1000)
    if (link) store.setHome(id, { kind: "link", link } as any, T0 + 2000)
  }
  add("pr", "https://github.com/acme/shop/pull/12")
  add("mr", `${GITLAB}/acme/web/-/merge_requests/7`)
  add("issue", "https://github.com/acme/shop/issues/3")
  add("none", null)
  deps = { inbox: { root: dir, configPath, requests: store }, daemon: async () => ({ status: 200, body: {} }), now: () => T0 + 5000, gitlabUrl: GITLAB }
})

describe("mergeHomeOf", () => {
  it("knows a pull request and a merge request from an issue", () => {
    expect(mergeHomeOf(store.get("pr")!, GITLAB)).toMatchObject({ provider: "github", key: "acme/shop#12" })
    expect(mergeHomeOf(store.get("mr")!, GITLAB)).toMatchObject({ provider: "gitlab", key: "acme/web!7" })
    expect(mergeHomeOf(store.get("issue")!, GITLAB)).toBeNull()
    expect(mergeHomeOf(store.get("none")!, GITLAB)).toBeNull()
  })

  it("marks the post, so the Hub offers its Diff", () => {
    const wd = { store, db: null, now: T0, staleAfterHours: 24, isAgent: () => true, gitlabUrl: GITLAB } as any
    expect(wallPost(store.get("pr")!, wd).mergeRef).toBe("acme/shop#12")
    expect(wallPost(store.get("issue")!, wd).mergeRef).toBeNull()
  })
})

describe("GET diff", () => {
  const diffDeps = (diff: WallDiffDeps["diff"]): WallDiffDeps => ({ store, gitlabUrl: GITLAB, diff })
  const q = (id: string) => new URLSearchParams({ id })

  it("answers 400 for a post whose home is not a PR or MR", async () => {
    const diff = vi.fn(async () => DIFF)
    expect(await handleWallDiff(q("issue"), diffDeps(diff))).toEqual({ status: 400, body: { error: "not a merge or pull request" } })
    expect(await handleWallDiff(q("none"), diffDeps(diff))).toMatchObject({ status: 400 })
    expect(diff).not.toHaveBeenCalled()
  })

  it("answers 404 for an unknown post and 400 without an id", async () => {
    expect((await handleWallDiff(q("nope"), diffDeps(async () => DIFF))).status).toBe(404)
    expect((await handleWallDiff(new URLSearchParams(), diffDeps(async () => DIFF))).status).toBe(400)
    expect((await handleWallDiff(q("pr"), null)).status).toBe(404)
  })

  it("parses the diff of the PR's home", async () => {
    const diff = vi.fn(async () => DIFF)
    const r = await handleWallDiff(q("pr"), diffDeps(diff))
    expect(diff).toHaveBeenCalledWith(expect.objectContaining({ provider: "github", ref: { project: "acme/shop", number: 12, mr: true } }))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ref: "acme/shop#12", provider: "github", truncated: false, files: [{ file: "src/app.ts", status: "modified" }] })
  })

  it("flags a diff past the line cap", async () => {
    const big = `--- a/x\n+++ b/x\n@@ -0,0 +1,4000 @@\n${Array.from({ length: 4000 }, (_, i) => `+l${i}`).join("\n")}\n`
    const r = await handleWallDiff(q("mr"), diffDeps(async () => big))
    expect(r.body).toMatchObject({ ref: "acme/web!7", provider: "gitlab", truncated: true, files: [{ truncated: true }] })
    expect((r.body as any).files[0].hunks[0].lines).toHaveLength(3000)
  })

  it("says the forge failed when the diff cannot be read", async () => {
    const r = await handleWallDiff(q("pr"), diffDeps(async () => { throw new Error("GitHub GET /repos/acme/shop/pulls/12: 404") }))
    expect(r).toMatchObject({ status: 502, body: { error: expect.stringContaining("404") } })
  })

  it("is a read: the route is not a Wall write", () => {
    expect(isWallWrite("GET", WALL_DIFF_PATH)).toBe(false)
  })
})

describe("POST diff-comments", () => {
  const post = (body: Record<string, unknown>) => handleWallAction("POST", "/api/admin/wall/diff-comments", body, deps)
  const comment = (extra: Record<string, unknown> = {}) => ({ file: "src/app.ts", side: "new", line: 2, text: "Why 3?", ...extra })

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

  it("refuses a post that is not a PR or MR, and an unknown post", async () => {
    expect(await post({ id: "issue", comments: [comment()] })).toEqual({ status: 400, body: { error: "not a merge or pull request" } })
    expect((await post({ id: "nope", comments: [comment()] }))!.status).toBe(404)
    expect(panel.calls).toEqual([])
  })

  it("refuses comments that do not fit one message together", async () => {
    const r = await post({ id: "pr", comments: [comment({ text: "a".repeat(2000) }), comment({ text: "b".repeat(2000) }), comment({ text: "c" })] })
    expect(r).toMatchObject({ status: 400, body: { error: expect.stringContaining("send fewer") } })
  })

  it("builds one message in the order given and hands it over as a comment is", async () => {
    const r = await post({ id: "pr", comments: [
      comment({ code: "const b = 3", text: "Why 3?" }),
      { file: "src/app.ts", side: "old", line: 2, text: "Keep this one" },
    ] })
    expect(r).toMatchObject({ status: 200, body: { ok: true, agentId: "coder" } })
    const text = [
      "Review comments on acme/shop#12, from the Hub:",
      "1. `src/app.ts:2` (new)\n> const b = 3\nWhy 3?",
      "2. `src/app.ts:2` (old)\nKeep this one",
      "Please address all 2 of them on the pull request's branch, push, and reply here when done.",
    ].join("\n\n")
    expect(panel.calls).toEqual([{ path: "/api/admin/approvals/requests/reply", body: { id: "pr", text } }])
    expect(store.get("pr")).toMatchObject({ state: "in_progress", ownerNote: text })
  })

  it("goes the same way as wall/comment", async () => {
    await handleWallAction("POST", "/api/admin/wall/comment", { id: "mr", text: "hello" }, deps)
    await post({ id: "mr", comments: [comment()] })
    expect(panel.calls.map((c) => c.path)).toEqual(["/api/admin/approvals/requests/reply", "/api/admin/approvals/requests/reply"])
    expect(panel.calls[1].body.text).toContain("Review comments on acme/web!7")
    expect(panel.calls[1].body.text).toContain("on the merge request's branch")
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
  })
})
