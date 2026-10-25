import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { commentUrl, forgeChatOf, forgeCommentsOf, forgeHomeOf, wallForgeState } from "../src/daemon/wall-forge-state"
import { withForge, type WallPost } from "../src/daemon/wall-api"
import { forgeReader, type ForgeReader } from "../src/requests/checkers/issue"
import { closeDb, openDb } from "../src/storage/sqlite"
import { insertForgeComment } from "../src/storage/forge-comments"
import { attachSqliteSubscribers } from "../src/storage/subscribers"
import { getEventBus } from "../src/events/bus"
import { MessageRouter } from "../src/channels/router"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"

// The Wall's forge home (#1184): live state, who closed it, when it was
// checked, and links to the exact comments agents posted. Mocked forge.

const GL = "https://gitlab.example.com"
const H = 3_600_000
const NOW = Date.UTC(2026, 9, 24, 12)

function post(over: Partial<WallPost> = {}): WallPost {
  return {
    id: "r1", state: "in_progress", headline: "Fix it", need: "", owner: "coder", agentId: "coder", askedBy: null,
    group: { channel: "telegram", chatId: "chat-A" }, project: "acme/web",
    home: { kind: "issue", link: "https://github.com/acme/web/issues/42" },
    createdAt: NOW - 5 * H, updatedAt: NOW - H, lastMoveAt: NOW - H, closedAt: null, evidence: null, closeReason: null,
    blocked: null, estimateMinutes: null, runMs: 0, runs: 1, failedRuns: 0, timeFlag: null, forgeTime: null,
    forgeState: null, comments: [], lastRun: null, concurrent: [], ownerCards: [],
    ...over,
  } as WallPost
}

const both = { github: true, gitlabUrl: GL }

describe("which posts have a forge home", () => {
  it("reads GitHub and GitLab home links and forge chats", () => {
    expect(forgeHomeOf(post(), GL)).toEqual({ provider: "github", ref: { project: "acme/web", number: 42, mr: false }, key: "acme/web#42" })
    expect(forgeHomeOf(post({ home: null, group: { channel: "github", chatId: "acme/web:pull:7" } }), GL)?.key).toBe("acme/web#7")
    expect(forgeHomeOf(post({ home: { kind: "mr", link: `${GL}/acme/api/-/merge_requests/9` } }), GL))
      .toEqual({ provider: "gitlab", ref: { project: "acme/api", number: 9, mr: true }, key: "acme/api!9" })
    expect(forgeHomeOf(post({ home: null, group: { channel: "gitlab", chatId: "acme/api:issue:3" } }), GL)?.key).toBe("acme/api#3")
    // The home link wins over the chat the task came from.
    expect(forgeHomeOf(post({ home: { kind: "issue", link: `${GL}/acme/api/-/issues/3` }, group: { channel: "github", chatId: "acme/web:issue:1" } }), GL)?.provider).toBe("gitlab")
  })

  it("has none for a chat home, a GitLab home without a GitLab address, or another host", () => {
    expect(forgeHomeOf(post({ home: null }), GL)).toBeNull()
    expect(forgeHomeOf(post({ home: { kind: "issue", link: `${GL}/acme/api/-/issues/3` } }), null)).toBeNull()
    expect(forgeHomeOf(post({ home: { kind: "issue", link: "https://gitlab.other.example/acme/api/-/issues/3" } }), GL)).toBeNull()
  })

  it("maps a home to its channel chat and to comment addresses", () => {
    const gh = forgeHomeOf(post({ home: { kind: "pr", link: "https://github.com/acme/web/pull/7" } }), GL)!
    expect(forgeChatOf(gh)).toBe("acme/web:pull:7")
    expect(commentUrl(gh, "123", GL)).toBe("https://github.com/acme/web/pull/7#issuecomment-123")
    const gl = forgeHomeOf(post({ home: { kind: "mr", link: `${GL}/acme/api/-/merge_requests/9` } }), GL)!
    expect(forgeChatOf(gl)).toBe("acme/api:merge_request:9")
    expect(commentUrl(gl, "55", GL + "/")).toBe(`${GL}/acme/api/-/merge_requests/9#note_55`)
  })
})

describe("forge state on posts", () => {
  it("shows state, closer and check time", async () => {
    const read: ForgeReader = vi.fn(async (provider) => provider === "github"
      ? { state: "closed" as const, url: "", closedBy: "a-person", closedAt: "2026-10-24T10:00:00Z" }
      : { state: "open" as const, url: "", closedBy: null, closedAt: null })
    const posts = [post(), post({ id: "r2", home: { kind: "issue", link: `${GL}/acme/api/-/issues/3` } }), post({ id: "r3", home: null })]
    await wallForgeState(both, read, { clock: () => NOW }).annotate(posts)
    expect(posts[0].forgeState).toEqual({
      provider: "github", ref: "acme/web#42", state: "closed", closedBy: "a-person", closedAt: Date.parse("2026-10-24T10:00:00Z"), checkedAt: NOW, unknown: null,
    })
    expect(posts[1].forgeState).toMatchObject({ provider: "gitlab", ref: "acme/api#3", state: "open", closedBy: null, unknown: null })
    expect(posts[2].forgeState).toBeNull()
    expect(read).toHaveBeenCalledWith("github", { project: "acme/web", number: 42, mr: false }, { notes: false })
  })

  it("says state unknown, never a wrong value, when the forge fails or is slow", async () => {
    const failing = [post()]
    await wallForgeState(both, async () => ({ error: "could not be reached: ECONNREFUSED" }), { clock: () => NOW }).annotate(failing)
    expect(failing[0].forgeState).toMatchObject({ state: null, closedBy: null, checkedAt: NOW, unknown: "could not be reached: ECONNREFUSED" })
    const slow = [post()]
    await wallForgeState(both, () => new Promise((r) => setTimeout(() => r({ state: "open", url: "" }), 200)), { budgetMs: 20 }).annotate(slow)
    expect(slow[0].forgeState).toMatchObject({ state: null, unknown: "GitHub did not answer in time" })
    const thrown = [post()]
    await wallForgeState(both, async () => { throw new Error("boom") }).annotate(thrown)
    expect(thrown[0].forgeState).toMatchObject({ state: null, unknown: "boom" })
  })

  it("reads each home once while cached, and skips GitHub without a connector", async () => {
    const read: ForgeReader = vi.fn(async () => ({ state: "merged" as const, url: "", closedBy: "a-person", closedAt: null }))
    const source = wallForgeState(both, read, { clock: () => NOW })
    await source.annotate([post(), post({ id: "r2" })])
    await source.annotate([post()])
    expect(read).toHaveBeenCalledTimes(1)
    const noGithub = [post()]
    await wallForgeState({ github: false, gitlabUrl: GL }, read).annotate(noGithub)
    expect(noGithub[0].forgeState).toBeNull()
  })

  it("fills a Wall reply next to GitLab time", async () => {
    const source = wallForgeState(both, async () => ({ state: "open" as const, url: "" }), { clock: () => NOW })
    const reply = await withForge({ status: 200, body: { posts: [post()] } }, { now: NOW, staleAfterHours: 24 } as any, [null, source]) as any
    expect(reply.body.posts[0].forgeState.state).toBe("open")
  })
})

describe("the forge reader says who closed it", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  it("GitHub: closed_by on an issue, merged_by on a merged pull request", async () => {
    const issue = forgeReader({ github: { apiUrl: "https://api.github.com" } }, (async () =>
      json({ state: "closed", closed_by: { login: "a-person" }, closed_at: "2026-10-24T10:00:00Z", html_url: "u" })) as any)
    expect(await issue("github", { project: "acme/web", number: 1, mr: false }, { notes: false }))
      .toMatchObject({ state: "closed", closedBy: "a-person", closedAt: "2026-10-24T10:00:00Z" })
    const pr = forgeReader({ github: { apiUrl: "https://api.github.com" } }, (async (url: string) => url.includes("/pulls/")
      ? json({ merged: true, merged_by: { login: "a-maintainer" }, merged_at: "2026-10-24T11:00:00Z" })
      : json({ state: "closed", pull_request: {}, closed_by: { login: "a-maintainer" }, closed_at: "2026-10-24T11:00:00Z" })) as any)
    expect(await pr("github", { project: "acme/web", number: 2, mr: true }, { notes: false }))
      .toMatchObject({ state: "merged", closedBy: "a-maintainer", closedAt: "2026-10-24T11:00:00Z" })
  })

  it("GitLab: merge_user on a merged MR; nothing on an open issue", async () => {
    const mr = forgeReader({ gitlab: { url: GL } }, (async () => json({ state: "merged", merge_user: { username: "a-person" }, merged_at: "2026-10-24T09:00:00Z" })) as any)
    expect(await mr("gitlab", { project: "acme/api", number: 9, mr: true }, { notes: false })).toMatchObject({ state: "merged", closedBy: "a-person" })
    const open = forgeReader({ gitlab: { url: GL } }, (async () => json({ state: "opened", closed_by: { username: "old" } })) as any)
    expect(await open("gitlab", { project: "acme/api", number: 3, mr: false }, { notes: false })).toMatchObject({ state: "open", closedBy: null, closedAt: null })
  })
})

describe("exact comment links", () => {
  let tmp: string
  beforeEach(() => { closeDb(); tmp = mkdtempSync(path.join(tmpdir(), "agentx-forge-comments-")) })
  afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

  it("links the comments posted on the home while the post was open", () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    insertForgeComment(db, { channel: "github", chatId: "acme/web:issue:42", commentId: "100", agentId: "coder", at: NOW - 6 * H })
    insertForgeComment(db, { channel: "github", chatId: "acme/web:issue:42", commentId: "101", agentId: "coder", at: NOW - 2 * H })
    insertForgeComment(db, { channel: "github", chatId: "acme/web:issue:43", commentId: "102", agentId: "coder", at: NOW - 2 * H })
    expect(forgeCommentsOf(post(), db, GL, NOW)).toEqual([{ agentId: "coder", at: NOW - 2 * H, url: "https://github.com/acme/web/issues/42#issuecomment-101" }])
    insertForgeComment(db, { channel: "gitlab", chatId: "acme/api:issue:3", commentId: "77", agentId: "helper", at: NOW - H })
    const gl = post({ home: null, group: { channel: "gitlab", chatId: "acme/api:issue:3" } })
    expect(forgeCommentsOf(gl, db, GL, NOW).map((c) => c.url)).toEqual([`${GL}/acme/api/-/issues/3#note_77`])
    expect(forgeCommentsOf(post({ home: null }), db, GL, NOW)).toEqual([])
  })

  it("keeps the id of an agent comment the router sends", async () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    const bus = getEventBus()
    bus.removeAllListeners()
    const dispose = attachSqliteSubscribers(db)
    try {
      const router = new MessageRouter({ getAgent: () => undefined, refusalFor: () => null } as any, { channels: {} } as any, undefined, () => {})
      const adapter = (name: string, id: string) => ({ name, start: async () => {}, stop: async () => {}, onMessage: () => {}, send: async () => id })
      router.addChannel(adapter("github", "555") as any)
      router.addChannel(adapter("telegram", "9") as any)
      await router.sendOutbound({ channel: "github", chatId: "acme/web:issue:42", text: "Done" }, { recordInSession: false })
      await router.sendOutbound({ channel: "telegram", chatId: "chat-A", text: "Done" }, { recordInSession: false })
      const rows = db.prepare("SELECT channel, chat_id AS chatId, comment_id AS commentId FROM forge_comments").all()
      expect(rows).toEqual([{ channel: "github", chatId: "acme/web:issue:42", commentId: "555" }])
    } finally {
      dispose()
    }
  })
})

describe("the page", () => {
  it("shows state unknown, the closer, and warns on a closed home of an open post", () => {
    expect(WALL_PAGE_SCRIPT).toContain("state unknown")
    expect(WALL_PAGE_SCRIPT).toContain("but this post is still open. Do not pick it up.")
    expect(WALL_PAGE_SCRIPT).toContain("(p.comments || []).slice(0, 3)")
  })
})
