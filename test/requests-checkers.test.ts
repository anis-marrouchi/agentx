import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import {
  DEFAULT_CHECKER_SETTINGS, describeCloseWhen, parseCloseWhen, readCloseWhen, runCheck,
  type CheckContext, type CheckerSettings,
} from "../src/requests/checkers"
import { forgeReader, parseRef, type ForgeReader } from "../src/requests/checkers/issue"
import { traceInbound } from "../src/requests/checkers/reply"

// The checkers that close an open loop on evidence (#1039). Each one
// answers met, not_met or unverifiable, and never throws.

const NOW = Date.parse("2030-03-01T12:00:00Z")
const settings = (over: Partial<CheckerSettings> = {}): CheckerSettings => ({ ...DEFAULT_CHECKER_SETTINGS, ...over })
const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({ now: NOW, settings: settings(), ...over })
const spec = (v: Record<string, unknown>, s = settings()) => {
  const out = parseCloseWhen(v, s, NOW)
  if (typeof out === "string") throw new Error(out)
  return out
}

const answer = (status: number, body = "") => (async () => new Response(body, { status })) as unknown as typeof fetch
const unreachable = (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch

describe("parsing closeWhen", () => {
  it("refuses an unknown kind, a kind turned off, and a bad spec", () => {
    expect(parseCloseWhen({ kind: "magic" })).toMatch(/one of url, issue, git-ancestor, reply/)
    expect(parseCloseWhen("url")).toMatch(/must be an object/)
    expect(parseCloseWhen({ kind: "url", url: "https://example.com" }, settings({ enabled: ["issue"] }))).toMatch(/turned off/)
    expect(parseCloseWhen({ kind: "url", url: "file:///etc/passwd" })).toMatch(/http\(s\)/)
    expect(parseCloseWhen({ kind: "issue", provider: "bitbucket", ref: "a/b#1" })).toMatch(/github or gitlab/)
    expect(parseCloseWhen({ kind: "issue", provider: "github", ref: "a/b!1" })).toMatch(/owner\/repo#12/)
    expect(parseCloseWhen({ kind: "issue", provider: "github", ref: "a/b#1", notePattern: "x".repeat(201) })).toMatch(/longer than 200/)
    expect(parseCloseWhen({ kind: "reply", channel: "telegram", chatId: "1" })).toMatch(/from/)
  })

  it("keeps what it needs, gives a reply check its start, and reads back what it stored", () => {
    const s = spec({ kind: "reply", channel: "Telegram", chatId: "42", from: "client-a" })
    expect(s).toEqual({ kind: "reply", channel: "telegram", chatId: "42", from: "client-a", after: NOW })
    expect(readCloseWhen(JSON.stringify(s))).toEqual(s)
    expect(readCloseWhen("not json")).toBeNull()
    expect(readCloseWhen(JSON.stringify({ kind: "other" }))).toBeNull()
    expect(describeCloseWhen(spec({ kind: "url", url: "https://example.com/v", contains: "1.2" }))).toBe('https://example.com/v answers with "1.2"')
  })

  it("a kind turned off after the loop was made is unverifiable", async () => {
    const s = spec({ kind: "url", url: "https://example.com" })
    expect((await runCheck(s, ctx({ settings: settings({ enabled: [] }), fetch: answer(200) }))).verdict).toBe("unverifiable")
  })
})

describe("url", () => {
  const s = spec({ kind: "url", url: "https://example.com/version", contains: "1.2.3" })
  it("met: 2xx with the text", async () => {
    expect(await runCheck(s, ctx({ fetch: answer(200, "version 1.2.3") }))).toEqual({ verdict: "met", detail: 'https://example.com/version answered with "1.2.3"' })
  })
  it("not met: an error status, or the text missing", async () => {
    expect((await runCheck(s, ctx({ fetch: answer(503) }))).verdict).toBe("not_met")
    expect((await runCheck(s, ctx({ fetch: answer(200, "version 1.2.2") }))).verdict).toBe("not_met")
  })
  it("unverifiable: not reachable", async () => {
    const r = await runCheck(s, ctx({ fetch: unreachable }))
    expect(r.verdict).toBe("unverifiable")
    expect(r.detail).toMatch(/ECONNREFUSED/)
  })
})

describe("issue", () => {
  const reader = (item: Awaited<ReturnType<ForgeReader>>): ForgeReader => async () => item
  it("reads short refs and web addresses on both forges", () => {
    expect(parseRef("github", "acme/app#12")).toEqual({ project: "acme/app", number: 12, mr: false })
    expect(parseRef("github", "https://github.com/acme/app/pull/7")).toEqual({ project: "acme/app", number: 7, mr: true })
    expect(parseRef("gitlab", "group/sub/app!3")).toEqual({ project: "group/sub/app", number: 3, mr: true })
    expect(parseRef("gitlab", "https://gitlab.example.com/group/app/-/issues/9")).toEqual({ project: "group/app", number: 9, mr: false })
    expect(parseRef("github", "group/sub/app#1")).toBeNull()
  })

  it("refuses a project with a . or .. part", () => {
    expect(parseRef("github", "acme/..#12")).toBeNull()
    expect(parseRef("github", "../app#12")).toBeNull()
    expect(parseRef("gitlab", "group/../app!3")).toBeNull()
    expect(parseRef("gitlab", "group/./app#3")).toBeNull()
    expect(parseRef("gitlab", "group/app.v2#3")).toEqual({ project: "group/app.v2", number: 3, mr: false })
  })

  it("met: closed (merged counts), or a note matches", async () => {
    const closed = spec({ kind: "issue", provider: "github", ref: "acme/app#12" })
    expect((await runCheck(closed, ctx({ forge: reader({ state: "merged", url: "u" }) }))).verdict).toBe("met")
    const merged = spec({ kind: "issue", provider: "gitlab", ref: "g/app!3", state: "merged" })
    expect((await runCheck(merged, ctx({ forge: reader({ state: "merged", url: "u" }) }))).verdict).toBe("met")
    const note = spec({ kind: "issue", provider: "github", ref: "acme/app#12", notePattern: "deployed to prod" })
    expect(await runCheck(note, ctx({ forge: reader({ state: "open", url: "u", notes: ["working", "Deployed to PROD at 10:00"] }) }))).toEqual({ verdict: "met", detail: 'u has a note with "deployed to prod"' })
  })

  it("matches notePattern as plain text: a regular expression is never run", async () => {
    const risky = spec({ kind: "issue", provider: "github", ref: "acme/app#12", notePattern: "(a+)+$" })
    const notes = ["a".repeat(9_000) + "!", "see (a+)+$ above"]
    const started = Date.now()
    expect(await runCheck(risky, ctx({ forge: reader({ state: "open", url: "u", notes }) }))).toEqual({ verdict: "met", detail: 'u has a note with "(a+)+$"' })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("not met: another state, no matching note", async () => {
    const merged = spec({ kind: "issue", provider: "gitlab", ref: "g/app!3", state: "merged" })
    expect((await runCheck(merged, ctx({ forge: reader({ state: "closed", url: "u" }) }))).verdict).toBe("not_met")
    const note = spec({ kind: "issue", provider: "github", ref: "acme/app#12", notePattern: "shipped" })
    expect((await runCheck(note, ctx({ forge: reader({ state: "closed", url: "u", notes: ["no"] }) }))).verdict).toBe("not_met")
  })

  it("unverifiable: no connector, or the forge will not say", async () => {
    const s = spec({ kind: "issue", provider: "github", ref: "acme/app#12" })
    expect((await runCheck(s, ctx())).verdict).toBe("unverifiable")
    expect((await runCheck(s, ctx({ forge: reader({ error: "HTTP 401" }) }))).detail).toMatch(/HTTP 401/)
  })

  it("the REST reader asks GitHub and GitLab the right questions", async () => {
    const asked: string[] = []
    const fake = (async (url: string, init: any) => {
      asked.push(`${url} ${init.headers.Authorization ?? init.headers["PRIVATE-TOKEN"] ?? "-"}`)
      if (url.endsWith("/issues/12")) return Response.json({ state: "closed", pull_request: {}, html_url: "https://github.com/acme/app/pull/12", labels: [{ name: "Review" }] })
      if (url.endsWith("/pulls/12")) return Response.json({ merged: true })
      if (url.includes("/merge_requests/3/notes")) return Response.json([{ body: "newest" }, { body: "oldest" }])
      if (url.endsWith("/merge_requests/3")) return Response.json({ state: "opened", web_url: "https://gitlab.example.com/g/app/-/merge_requests/3", labels: ["Doing"] })
      return new Response("", { status: 404 })
    }) as unknown as typeof fetch
    const read = forgeReader({ github: { apiUrl: "https://api.github.com", token: "t1" }, gitlab: { url: "https://gitlab.example.com", token: "t2" } }, fake)
    expect(await read("github", { project: "acme/app", number: 12, mr: true }, { notes: false })).toEqual({ state: "merged", url: "https://github.com/acme/app/pull/12", labels: ["Review"] })
    expect(await read("gitlab", { project: "g/app", number: 3, mr: true }, { notes: true })).toEqual({ state: "open", url: "https://gitlab.example.com/g/app/-/merge_requests/3", labels: ["Doing"], notes: ["oldest", "newest"] })
    expect(await read("github", { project: "acme/app", number: 99, mr: false }, { notes: false })).toEqual({ error: "not found (or not visible to the connector)" })
    expect(asked[0]).toBe("https://api.github.com/repos/acme/app/issues/12 Bearer t1")
    expect(asked).toContain("https://gitlab.example.com/api/v4/projects/g%2Fapp/merge_requests/3 t2")
  })
})

describe("git-ancestor", () => {
  let repo: string
  let first: string
  let second: string
  let side: string
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim()

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "agentx-git-ancestor-"))
    git("init", "-q", "-b", "main")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    writeFileSync(path.join(repo, "a.txt"), "1")
    git("add", "."); git("commit", "-qm", "one")
    first = git("rev-parse", "HEAD")
    git("checkout", "-qb", "side")
    writeFileSync(path.join(repo, "b.txt"), "2")
    git("add", "."); git("commit", "-qm", "side")
    side = git("rev-parse", "HEAD")
    git("checkout", "-q", "main")
    writeFileSync(path.join(repo, "c.txt"), "3")
    git("add", "."); git("commit", "-qm", "two")
    second = git("rev-parse", "HEAD")
  })
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  const s = (commit: string, ref?: string) => spec({ kind: "git-ancestor", repo: "app", commit, ...(ref ? { ref } : {}) }, settings({ repos: { app: repo } }))
  const c = () => ctx({ settings: settings({ repos: { app: repo } }) })

  it("only names repos under requests.checkers.repos, and only takes a hash and a plain ref", () => {
    expect(parseCloseWhen({ kind: "git-ancestor", repo: "app", commit: "abc1234" })).toMatch(/no repos are set up/)
    expect(parseCloseWhen({ kind: "git-ancestor", repo: "other", commit: "abc1234" }, settings({ repos: { app: repo } }))).toMatch(/one of app/)
    expect(parseCloseWhen({ kind: "git-ancestor", repo: "app", commit: "HEAD~1" }, settings({ repos: { app: repo } }))).toMatch(/commit hash/)
    expect(parseCloseWhen({ kind: "git-ancestor", repo: "app", commit: "abc1234", ref: "--upload-pack=x" }, settings({ repos: { app: repo } }))).toMatch(/branch or tag/)
  })

  it("met: the commit is in the branch", async () => {
    expect((await runCheck(s(first), c())).verdict).toBe("met")
    expect((await runCheck(s(second, "main"), c())).verdict).toBe("met")
  })

  it("not met: the commit is on another branch", async () => {
    expect(await runCheck(s(side, "main"), c())).toEqual({ verdict: "not_met", detail: `commit ${side} is not in main of app yet` })
  })

  it("unverifiable: a commit the clone does not have, or a repo no longer set up", async () => {
    expect((await runCheck(s("deadbeefdeadbeef"), c())).verdict).toBe("unverifiable")
    expect((await runCheck(s(first), ctx())).verdict).toBe("unverifiable")
  })
})

describe("reply", () => {
  let db: Database.Database
  beforeAll(() => {
    db = new Database(":memory:")
    db.exec("CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel TEXT, chat_id TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL, person TEXT)")
  })
  afterAll(() => db.close())

  const s = spec({ kind: "reply", channel: "telegram", chatId: "42", from: "client-a", after: NOW - 1000 })

  it("met: the person wrote in that chat after the loop opened", async () => {
    const inbound = () => [{ person: "client-a", at: NOW }]
    expect((await runCheck(s, ctx({ inbound }))).verdict).toBe("met")
  })

  it("not met: nothing from them yet", async () => {
    expect((await runCheck(s, ctx({ inbound: () => [] }))).verdict).toBe("not_met")
  })

  it("unverifiable: no record of inbound turns", async () => {
    expect((await runCheck(s, ctx())).verdict).toBe("unverifiable")
    const bare = new Database(":memory:")
    expect((await runCheck(s, ctx({ inbound: traceInbound(bare) }))).verdict).toBe("unverifiable")
    bare.close()
  })

  it("reads the daemon's own record: this chat, this person, after the time, with or without the account", async () => {
    const insert = db.prepare("INSERT INTO task_traces (task_id, agent_id, channel, chat_id, status, started_at, person) VALUES (?, 'coder', ?, ?, 'completed', ?, ?)")
    insert.run("old", "telegram", "42", NOW - 5000, "client-a")
    insert.run("other-chat", "telegram", "43", NOW, "client-a")
    insert.run("other-person", "telegram", "42", NOW, "client-b")
    const log = traceInbound(db)
    expect((await runCheck(s, ctx({ inbound: log }))).verdict).toBe("not_met")
    insert.run("hit", "telegram@support", "42", NOW + 1000, "client-a")
    expect((await runCheck(s, ctx({ inbound: log }))).verdict).toBe("met")
  })
})
