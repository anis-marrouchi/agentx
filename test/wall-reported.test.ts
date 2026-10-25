import { describe, expect, it, vi } from "vitest"
import { groupReported, reportedReader, signatureOf, wallReported, withReported, type ReportedIssue, type ReportedReader } from "../src/daemon/wall-reported"
import { failureSignature, WALL_PREFIX } from "../src/daemon/wall-api"
import { wallConfigSchema } from "../src/daemon/config"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"

// Reported failures on the Wall (#1186): open issues with a configured
// label, one row per dedupe signature. Mocked forge, made-up names.

const NOW = Date.UTC(2026, 9, 25, 6)
const H = 3_600_000
const LABEL = "probe-reported"
const connectors = { github: { apiUrl: "https://api.github.example", token: "gh-secret" }, gitlab: { url: "https://gitlab.example.com", token: "gl-secret" } }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const iso = (ms: number) => new Date(ms).toISOString()

const issue = (n: number, title: string, at: number): ReportedIssue =>
  ({ ref: `acme/probe#${n}`, title, url: `https://forge.example/acme/probe/issues/${n}`, updatedAt: at })

describe("reading labelled open issues", () => {
  it("GitHub: one GET on the repo, with the label and the connector's token; pull requests left out", async () => {
    const doFetch = vi.fn(async (_url: string, _init?: RequestInit) => json([
      { number: 3, title: "Probe failed: disk", html_url: "https://github.example/acme/probe/issues/3", updated_at: iso(NOW - H) },
      { number: 4, title: "A pull request", html_url: "https://github.example/acme/probe/pull/4", updated_at: iso(NOW), pull_request: {} },
    ]))
    const got = await reportedReader(connectors, doFetch as any)({ forge: "github", project: "acme/probe" }, LABEL)
    expect(doFetch).toHaveBeenCalledTimes(1)
    const [url, init] = doFetch.mock.calls[0]
    expect(url).toBe(`https://api.github.example/repos/acme/probe/issues?state=open&labels=${LABEL}&sort=updated&direction=desc&per_page=100`)
    expect((init!.headers as any).Authorization).toBe("Bearer gh-secret")
    expect(got).toEqual({ issues: [{ ref: "acme/probe#3", title: "Probe failed: disk", url: "https://github.example/acme/probe/issues/3", updatedAt: NOW - H }], truncated: false })
  })

  it("GitLab: the project path encoded, iid and web_url, PRIVATE-TOKEN", async () => {
    const doFetch = vi.fn(async (_url: string, _init?: RequestInit) => json([{ iid: 9, title: "x", web_url: "https://gitlab.example.com/grp/probe/-/issues/9", updated_at: iso(NOW) }]))
    const got = await reportedReader(connectors, doFetch as any)({ forge: "gitlab", project: "grp/probe" }, "a b")
    const [url, init] = doFetch.mock.calls[0]
    expect(url).toBe("https://gitlab.example.com/api/v4/projects/grp%2Fprobe/issues?state=opened&labels=a%20b&order_by=updated_at&sort=desc&per_page=100")
    expect((init!.headers as any)["PRIVATE-TOKEN"]).toBe("gl-secret")
    expect(got).toMatchObject({ issues: [{ ref: "grp/probe#9", updatedAt: NOW }], truncated: false })
  })

  it("says a full page may have more", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: "t", html_url: `https://github.example/acme/probe/issues/${i + 1}`, updated_at: iso(NOW) }))
    const got = await reportedReader(connectors, (async () => json(page)) as any)({ forge: "github", project: "acme/probe" }, LABEL)
    expect(got).toMatchObject({ truncated: true })
  })

  it("drops links that are not http(s)", async () => {
    const got = await reportedReader(connectors, (async () => json([{ number: 1, title: "t", html_url: "javascript:alert(1)", updated_at: iso(NOW) }])) as any)({ forge: "github", project: "acme/probe" }, LABEL)
    expect(got).toEqual({ issues: [], truncated: false })
  })

  it("errors in words, never throws", async () => {
    const read = (f: any) => reportedReader(connectors, f)
    expect(await read(async () => json({}, 404))({ forge: "github", project: "acme/probe" }, LABEL)).toEqual({ error: "not found (or not visible to the connector)" })
    expect(await read(async () => json({}, 502))({ forge: "gitlab", project: "grp/probe" }, LABEL)).toEqual({ error: "HTTP 502" })
    expect(await read(async () => { throw new Error("ECONNREFUSED") })({ forge: "github", project: "acme/probe" }, LABEL)).toEqual({ error: "could not be reached: ECONNREFUSED" })
    expect(await read(async () => json({ message: "x" }))({ forge: "github", project: "acme/probe" }, LABEL)).toEqual({ error: "no issue list in the answer" })
    const never = vi.fn()
    expect(await read(never)({ forge: "github", project: "acme/../x" }, LABEL)).toEqual({ error: "not a project path" })
    expect(never).not.toHaveBeenCalled()
  })
})

describe("grouping by signature", () => {
  it("takes the pattern's first capture, else the normalized title", () => {
    const p = /^\[([\w-]+)\]/
    expect(signatureOf("[disk-full] node-7 at 91%", p)).toBe("disk-full")
    expect(signatureOf("Disk full on node 7", p)).toBe(failureSignature("Disk full on node 7"))
    expect(signatureOf("Disk full on node 7", null)).toBe("disk full on node #")
  })

  it("one row per signature with count, last seen and the newest issue's link", () => {
    const groups = groupReported([
      issue(1, "Disk full on node 7", NOW - 5 * H),
      issue(2, "Disk full on node 12", NOW - H),
      issue(3, "Backup missed", NOW - 2 * H),
      issue(4, "Disk full on node 3", NOW - 3 * H),
    ], null)
    expect(groups).toEqual([
      { signature: "disk full on node #", count: 3, lastAt: NOW - H, ref: "acme/probe#2", title: "Disk full on node 12", url: "https://forge.example/acme/probe/issues/2" },
      { signature: "backup missed", count: 1, lastAt: NOW - 2 * H, ref: "acme/probe#3", title: "Backup missed", url: "https://forge.example/acme/probe/issues/3" },
    ])
  })
})

describe("the Wall source", () => {
  const cfg = { label: LABEL, titleSignature: "^\\[([\\w-]+)\\]", sources: [{ forge: "github" as const, project: "acme/probe" }, { forge: "gitlab" as const, project: "grp/probe" }] }

  it("reads each project once, fails soft per project, and caches", async () => {
    const read: ReportedReader = vi.fn(async (s) => s.forge === "github"
      ? { issues: [issue(1, "[db-down] a", NOW - H), issue(2, "[db-down] b", NOW)], truncated: true }
      : { error: "HTTP 503" })
    const source = wallReported(cfg, read, { clock: () => NOW })
    const got = await source.read()
    expect(got).toEqual({
      label: LABEL,
      groups: [expect.objectContaining({ signature: "db-down", count: 2, lastAt: NOW, ref: "acme/probe#2" })],
      unread: [{ forge: "gitlab", project: "grp/probe", why: "HTTP 503" }],
      truncated: [{ forge: "github", project: "acme/probe" }],
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledWith({ forge: "github", project: "acme/probe" }, LABEL)
    await source.read()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("a forge that hangs is 'did not answer in time'; the rest still shows", async () => {
    const read: ReportedReader = async (s) => s.forge === "gitlab" ? new Promise(() => {}) : { issues: [issue(1, "x", NOW)], truncated: false }
    const got = await wallReported(cfg, read, { budgetMs: 20 }).read()
    expect(got.groups).toHaveLength(1)
    expect(got.unread).toEqual([{ forge: "gitlab", project: "grp/probe", why: "did not answer in time" }])
  })
})

describe("the setting", () => {
  const list = () => ({ status: 200, body: { node: "n1", posts: [], failures: [] } })

  it("unset: no source, no fetch, the reply is unchanged", async () => {
    expect(wallConfigSchema.parse(undefined)).toEqual({})
    const reply = await withReported(list(), WALL_PREFIX, null)
    expect(reply).toEqual(list())
    expect("reported" in (reply.body as object)).toBe(false)
  })

  it("set: the list reply carries the groups; threads are left alone", async () => {
    const source = { read: vi.fn(async () => ({ label: LABEL, groups: [], unread: [], truncated: [] })) }
    expect((await withReported(list(), WALL_PREFIX, source)).body).toMatchObject({ reported: { label: LABEL } })
    const thread = { status: 200, body: { post: {} } }
    expect(await withReported(thread, `${WALL_PREFIX}/thread`, source)).toBe(thread)
    expect(source.read).toHaveBeenCalledTimes(1)
  })

  it("checks the config: a label, at least one project, a valid pattern", () => {
    const ok = { reportedIssues: { label: LABEL, sources: [{ forge: "gitlab", project: "grp/sub/probe" }] } }
    expect(wallConfigSchema.parse(ok)).toEqual(ok)
    expect(() => wallConfigSchema.parse({ reportedIssues: { ...ok.reportedIssues, titleSignature: "([" } })).toThrow(/regular expression/)
    expect(() => wallConfigSchema.parse({ reportedIssues: { label: LABEL, sources: [] } })).toThrow()
    expect(() => wallConfigSchema.parse({ reportedIssues: { label: "", sources: ok.reportedIssues.sources } })).toThrow()
  })

  it("the page script still parses", () => {
    expect(() => new Function(WALL_PAGE_SCRIPT)).not.toThrow()
    expect(WALL_PAGE_SCRIPT).toContain("function reportedHtml()")
  })
})
