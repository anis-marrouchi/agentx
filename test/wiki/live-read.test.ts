import { describe, expect, it } from "vitest"
import {
  cleanSearch,
  gitRequest,
  runLiveReads,
  validateReads,
  type LiveSource,
} from "../../src/wiki/live-read"

// Live reads (#855) are read-only by construction: a model only names
// them, each is checked against the configured sources, and the code
// makes one GET per read against the source's own host.

const sources: LiveSource[] = [
  { kind: "github", name: "gh", host: "github.com", repos: ["example/app"], tokenEnv: "TEST_GH_TOKEN" },
  { kind: "gitlab", name: "gl", host: "gitlab.example.com", repos: ["group/sub/project"], tokenEnv: "TEST_GL_TOKEN" },
  { kind: "agentx", name: "fleet", peers: true },
]

describe("validateReads", () => {
  it("keeps reads a configured source allows", () => {
    const reads = validateReads([
      { source: "gh", kind: "issue", repo: "example/app", id: 12 },
      { source: "gl", kind: "merge_request", repo: "group/sub/project", id: "7" },
      { source: "gh", kind: "releases", repo: "Example/App" },
      { source: "fleet", kind: "version" },
    ], sources, 10)
    expect(reads).toEqual([
      { source: "gh", kind: "issue", repo: "example/app", id: 12 },
      { source: "gl", kind: "merge_request", repo: "group/sub/project", id: 7 },
      { source: "gh", kind: "releases", repo: "example/app" },
      { source: "fleet", kind: "version" },
    ])
  })

  it("drops reads outside the config", () => {
    const reads = validateReads([
      { source: "gh", kind: "issue", repo: "other/repo", id: 1 },          // repo not listed
      { source: "nope", kind: "issue", repo: "example/app", id: 1 },       // unknown source
      { source: "gh", kind: "issue", repo: "example/app", id: "1; rm" },   // id not a number
      { source: "gh", kind: "issue", repo: "example/app", id: -3 },
      { source: "gh", kind: "delete", repo: "example/app" },               // unknown kind
      { source: "gh", kind: "issue", repo: "../example/app", id: 1 },
      { source: "fleet", kind: "issue", repo: "example/app", id: 1 },      // agentx reads versions only
      { source: "gh", kind: "search", repo: "example/app", query: "%%%" }, // nothing left to search
      "issue 12",
    ], sources, 10)
    expect(reads).toEqual([])
  })

  it("caps the count and drops repeats", () => {
    const one = { source: "gh", kind: "issue", repo: "example/app", id: 1 }
    const reads = validateReads([one, one, { ...one, id: 2 }, { ...one, id: 3 }], sources, 2)
    expect(reads.map((r: any) => r.id)).toEqual([1, 2])
  })

  it("is empty for a reply that is not a list", () => {
    expect(validateReads({ source: "gh" }, sources, 6)).toEqual([])
  })
})

describe("building the request", () => {
  it("cuts and encodes search words", () => {
    expect(cleanSearch("deploy & <script> login  fix")).toBe("deploy script login fix")
    expect(cleanSearch("x".repeat(200))).toHaveLength(80)
    const req = gitRequest({ source: "gh", kind: "search", repo: "example/app", query: "login fix" }, sources[0] as any)
    expect(req.api).toBe("https://api.github.com/search/issues?q=repo%3Aexample%2Fapp%20login%20fix&sort=updated&order=desc&per_page=5")
  })

  it("reads a GitLab project by its encoded path on the configured host", () => {
    const req = gitRequest({ source: "gl", kind: "merge_request", repo: "group/sub/project", id: 7 }, sources[1] as any)
    expect(req.api).toBe("https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests/7")
    expect(req.web).toBe("https://gitlab.example.com/group/sub/project/-/merge_requests/7")
  })
})

describe("runLiveReads", () => {
  type Call = { url: string; init: RequestInit }
  const fakeFetch = (routes: Record<string, unknown>, calls: Call[]) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (!(url in routes)) return new Response("not found", { status: 404 })
      return new Response(JSON.stringify(routes[url]), { status: 200 })
    }) as unknown as typeof fetch

  it("makes one GET per read, sends each token only to its own host, refuses redirects", async () => {
    const calls: Call[] = []
    const lines = await runLiveReads([
      { source: "gh", kind: "issue", repo: "example/app", id: 12 },
      { source: "gl", kind: "merge_request", repo: "group/sub/project", id: 7 },
    ], sources, {
      timeoutMs: 1000,
      env: { TEST_GH_TOKEN: "gh-secret", TEST_GL_TOKEN: "gl-secret" },
      fetch: fakeFetch({
        "https://api.github.com/repos/example/app/issues/12": { title: "Login fails", state: "closed", state_reason: "completed", closed_at: "2026-10-01T10:00:00Z", labels: [{ name: "bug" }] },
        "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests/7": { title: "Fix login", state: "merged", merged_at: "2026-10-02T09:00:00Z" },
      }, calls),
    })
    expect(calls.every((c) => c.init.method === "GET" && c.init.redirect === "error")).toBe(true)
    const gh = calls.find((c) => c.url.startsWith("https://api.github.com"))!
    const gl = calls.find((c) => c.url.startsWith("https://gitlab.example.com"))!
    expect((gh.init.headers as any).Authorization).toBe("Bearer gh-secret")
    expect(JSON.stringify(gh.init.headers)).not.toContain("gl-secret")
    expect((gl.init.headers as any)["PRIVATE-TOKEN"]).toBe("gl-secret")
    expect(JSON.stringify(gl.init.headers)).not.toContain("gh-secret")

    expect(lines.map((l) => l.label)).toEqual(["live 1", "live 2"])
    expect(lines[0].text).toBe('example/app#12 "Login fails": closed (completed), closed 2026-10-01, labels bug')
    expect(lines[0].url).toBe("https://github.com/example/app/issues/12")
    expect(lines[1].text).toContain("group/sub/project!7 \"Fix login\": merged, merged 2026-10-02")
  })

  it("leaves out a read that fails, and still returns the others", async () => {
    const lines = await runLiveReads([
      { source: "gh", kind: "issue", repo: "example/app", id: 404 },
      { source: "gh", kind: "releases", repo: "example/app" },
    ], sources, {
      timeoutMs: 1000,
      env: {},
      fetch: fakeFetch({
        "https://api.github.com/repos/example/app/releases?per_page=3": [{ tag_name: "v2.1.0", published_at: "2026-10-05T00:00:00Z" }],
      }, []),
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ label: "live 1", text: "example/app newest releases: v2.1.0 2026-10-05" })
  })

  it("falls back to tags when a repository publishes no releases", async () => {
    const lines = await runLiveReads([{ source: "gh", kind: "releases", repo: "example/app" }], sources, {
      timeoutMs: 1000, env: {},
      fetch: fakeFetch({
        "https://api.github.com/repos/example/app/releases?per_page=3": [],
        "https://api.github.com/repos/example/app/tags?per_page=3": [{ name: "v1.4.0" }],
      }, []),
    })
    expect(lines[0].text).toBe("example/app newest tags (no releases): v1.4.0")
  })

  it("asks each node for its AgentX version; an unreachable node is left out", async () => {
    const calls: Call[] = []
    const lines = await runLiveReads([{ source: "fleet", kind: "version" }], sources, {
      timeoutMs: 1000,
      nodes: [
        { name: "node-a", url: "http://127.0.0.1:18800", token: "local" },
        { name: "node-b", url: "http://10.0.0.2:18800/", token: "peer" },
        { name: "node-c", url: "http://10.0.0.3:18800" },
      ],
      fetch: fakeFetch({
        "http://127.0.0.1:18800/health": { status: "ok", node: { name: "node-a" }, version: "1.40.0", commit: "abcdef1234567", uptime: 7200 },
        "http://10.0.0.2:18800/health": { status: "ok", node: { name: "node-b" }, version: "1.39.2", uptime: 90000 },
      }, calls),
    })
    expect(lines.map((l) => l.text)).toEqual([
      "AgentX on node-a: version 1.40.0 (abcdef1234), up 2h, status ok",
      "AgentX on node-b: version 1.39.2, up 1d, status ok",
    ])
    expect((calls[1].init.headers as any).Authorization).toBe("Bearer peer")
  })
})
