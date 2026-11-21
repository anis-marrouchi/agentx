import { describe, it, expect } from "vitest"
import { lastPageUrl, movementReader } from "../src/requests/checkers/issue-movement"

// #863 v2 B2 + v2.1: movement on a goal's issue is any note (system notes
// too) or state change, by anyone. Label-only changes are left out.
// GitHub's timeline is read from its last page.

type Route = { body: unknown; headers?: Record<string, string>; status?: number }

function fakeFetch(routes: Record<string, Route>) {
  const seen: string[] = []
  const f = (async (url: string) => {
    seen.push(url)
    const key = Object.keys(routes).find((k) => url.endsWith(k))
    const r = key ? routes[key] : { body: {}, status: 404 }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers })
  }) as unknown as typeof fetch
  return { f, seen }
}

describe("GitLab", () => {
  it("reads notes (system notes too) and state events, never label events", async () => {
    const { f, seen } = fakeFetch({
      "/issues/7": { body: { state: "opened" } },
      "/issues/7/notes?per_page=100&sort=desc&order_by=created_at": { body: [{ created_at: "2026-11-10T00:00:00Z", system: true, body: "mentioned in commit abc" }, { created_at: "2026-10-01T00:00:00Z" }] },
      "/issues/7/resource_state_events?per_page=100": { body: [{ created_at: "2026-11-12T00:00:00Z", state: "reopened" }] },
    })
    const r = await movementReader({ gitlab: { url: "https://gl.example" } }, f)("gitlab", "grp/proj#7")
    expect(r).toEqual({ ok: true, state: "open", times: [Date.parse("2026-11-10T00:00:00Z"), Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-11-12T00:00:00Z")] })
    expect(seen.some((u) => u.includes("label"))).toBe(false)
  })

  it("reads the last page of state events", async () => {
    const { f } = fakeFetch({
      "/issues/7": { body: { state: "closed" } },
      "/issues/7/notes?per_page=100&sort=desc&order_by=created_at": { body: [] },
      "/issues/7/resource_state_events?per_page=100": { body: [{ created_at: "2026-01-01T00:00:00Z" }], headers: { "x-total-pages": "3" } },
      "/issues/7/resource_state_events?per_page=100&page=3": { body: [{ created_at: "2026-11-01T00:00:00Z" }] },
    })
    const r = await movementReader({ gitlab: { url: "https://gl.example" } }, f)("gitlab", "grp/proj#7")
    expect(r).toEqual({ ok: true, state: "closed", times: [Date.parse("2026-11-01T00:00:00Z")] })
  })

  it("a failed read is an error, never an empty list", async () => {
    const { f } = fakeFetch({ "/issues/7": { body: {}, status: 502 } })
    expect(await movementReader({ gitlab: { url: "https://gl.example" } }, f)("gitlab", "grp/proj#7")).toEqual({ ok: false, error: "HTTP 502" })
    expect(await movementReader({}, f)("gitlab", "grp/proj#7")).toMatchObject({ ok: false, error: /no gitlab connector/ })
  })
})

describe("GitHub", () => {
  it("reads the timeline's last page and drops labeled / unlabeled", async () => {
    const { f, seen } = fakeFetch({
      "/repos/o/r/issues/3": { body: { state: "open" } },
      "/repos/o/r/issues/3/timeline?per_page=100": { body: [{ event: "commented", created_at: "2026-01-01T00:00:00Z" }], headers: { link: '<https://api.example/repos/o/r/issues/3/timeline?per_page=100&page=2>; rel="next", <https://api.example/repos/o/r/issues/3/timeline?per_page=100&page=4>; rel="last"' } },
      "/repos/o/r/issues/3/timeline?per_page=100&page=4": { body: [
        { event: "labeled", created_at: "2026-11-20T00:00:00Z" },
        { event: "commented", created_at: "2026-11-05T00:00:00Z" },
        { event: "committed", author: { date: "2026-11-06T00:00:00Z" } },
      ] },
    })
    const r = await movementReader({ github: { apiUrl: "https://api.example" } }, f)("github", "o/r#3")
    expect(r).toEqual({ ok: true, state: "open", times: [Date.parse("2026-11-05T00:00:00Z"), Date.parse("2026-11-06T00:00:00Z")] })
    expect(seen.at(-1)).toMatch(/page=4$/)
  })

  it("parses a Link header", () => {
    expect(lastPageUrl('<a?page=2>; rel="next", <a?page=9>; rel="last"')).toBe("a?page=9")
    expect(lastPageUrl(null)).toBeNull()
  })
})
