import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { handleBoardRequest, RETIRED_PAGES, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { CLASSIC_ROUTES, classicRedirect, classicRouteFor } from "../src/daemon/ui/classic-routes"
import { renderWallPage } from "../src/daemon/ui/pages/wall"

// #1447: the Wall replaces the classic pages one by one. classic-routes.ts
// lists every classic page and where it stands; these tests hold the Wall
// and the server to that list.

/** Every same-site href in the Wall document, its inline scripts included. */
function wallHrefs(): string[] {
  const html = renderWallPage({ peers: [] })
  const out = new Set<string>()
  for (const m of html.matchAll(/href="(\/[^"]*)"/g)) {
    // A link built in the client script, `/agents/' + id + '/history`, reads as /agents/x/history.
    out.add(m[1].replace(/'\s*\+[^+]*\+\s*'/g, "x").replace(/'\s*\+.*$/, "x"))
  }
  return [...out]
}

/** Same-site addresses on the Wall that are not dashboard pages. */
const NOT_PAGES = [/^\/(#|$)/, /^\/hub([?#]|$)/, /^\/admin\/wiki\//, /^\/(favicon\.svg|apple-touch-icon\.png)$/]

describe("classic routes registry", () => {
  it("gives every pending page an issue to wait on, and every Wall page a target", () => {
    for (const r of CLASSIC_ROUTES) {
      if (r.status === "pending") expect(r.blockedBy?.length, r.path).toBeGreaterThan(0)
      if (r.status === "wall") expect(r.wall, r.path).toMatch(/^\/(hub)?(#|$)/)
    }
    expect(new Set(CLASSIC_ROUTES.map((r) => r.path)).size).toBe(CLASSIC_ROUTES.length)
  })

  it("lists every retired page (#1446) with the Wall view it redirects to", () => {
    for (const [path, target] of Object.entries(RETIRED_PAGES)) {
      const r = classicRouteFor(path)
      expect(r?.status, path).toBe("wall")
      expect(r?.wall, path).toBe(target)
    }
  })

  it("keeps /setup and the org chart editor as tool pages; the workflow editor is on the Wall (#1524)", () => {
    expect(classicRouteFor("/setup")?.status).toBe("tool")
    expect(classicRouteFor("/workflows/editor")?.status).toBe("wall")
    expect(classicRouteFor("/workflows/editor")?.wall).toBe("/hub#page=editor")
    // Owner decision on #1420: the org chart is edited on /org, the Wall reads it.
    expect(classicRouteFor("/org")?.status).toBe("tool")
    expect(classicRouteFor("/workflows")?.status).toBe("pending")
  })

  it("matches ids, queries and hashes", () => {
    expect(classicRouteFor("/agents/a1/history?node=x")?.path).toBe("/agents/<id>/history")
    expect(classicRouteFor("/admin/agents/a1")?.path).toBe("/admin/agents/<id>")
    expect(classicRouteFor("/workflows#wf-1")?.path).toBe("/workflows")
    expect(classicRouteFor("/admin/wiki/search?q=x")).toBeNull()
    expect(classicRouteFor("//evil.example/live")).toBeNull()
  })
})

describe("the Wall's links (link crawl)", () => {
  it("links only to Wall views, the wiki, tool pages or classic pages still pending", () => {
    for (const href of wallHrefs()) {
      if (NOT_PAGES.some((re) => re.test(href))) continue
      const r = classicRouteFor(href)
      expect(r, `unlisted same-site link ${href}`).not.toBeNull()
      expect(r!.status, `${href} is on the Wall now: link to ${r!.wall}`).not.toBe("wall")
    }
  })

  it("no longer links to the classic Task page", () => {
    expect(wallHrefs().filter((h) => h.startsWith("/tasks/"))).toEqual([])
  })

  it("lists the classic pages it still links to, each waiting on an open issue", () => {
    const linked = new Set(wallHrefs().map((h) => classicRouteFor(h)).filter((r) => r?.status === "pending").map((r) => r!.path))
    // Shrinks as each child of #1449 lands; empty once #1447 is done.
    expect([...linked].sort()).toEqual([
      "/activity", "/admin", "/admin/agents/<id>", "/approvals",
      "/mesh", "/monitor", "/workflows",
    ])
  })
})

describe("classic Task page redirect", () => {
  it("carries the run to the Wall Task page's hash", () => {
    const to = classicRedirect("/tasks/t%201", new URLSearchParams("agent=ops&channel=slack&archived=1&ask=hi&at=2026-01-01T00:00:00Z&name=Ops"), "http://daemon.test")
    expect(to).toMatch(/^\/#/)
    const q = new URLSearchParams(to!.slice(2))
    expect(Object.fromEntries(q)).toEqual({ page: "task", task: "t 1", agent: "ops", node: "http://daemon.test", ch: "slack", ask: "hi", at: "2026-01-01T00:00:00Z", done: "1" })
  })

  it("keeps the node it was given, and needs an agent", () => {
    const to = classicRedirect("/tasks/t1", new URLSearchParams("agent=ops&node=http://peer.test"), "http://daemon.test")
    expect(new URLSearchParams(to!.slice(2)).get("node")).toBe("http://peer.test")
    expect(classicRedirect("/tasks/t1", new URLSearchParams(""), "http://daemon.test")).toBeNull()
    expect(classicRedirect("/tasks/%E0%A4%A", new URLSearchParams("agent=ops"), "http://daemon.test")).toBeNull()
  })

  it("sends an agent's history to its Activity tab on the Wall", () => {
    const to = classicRedirect("/agents/ops%20bot/history", new URLSearchParams("node=http://peer.test&name=Ops"), "http://daemon.test")
    expect(to).toMatch(/^\/hub#/)
    expect(Object.fromEntries(new URLSearchParams(to!.slice("/hub#".length)))).toEqual({ page: "activity", "a-agent": "ops bot", "a-period": "30d" })
    expect(classicRedirect("/agents/%E0%A4%A/history", new URLSearchParams(""), "http://daemon.test")).toBeNull()
  })

  it("sends the workflow editor to its Wall page (#1524)", () => {
    const keys = (to: string | null) => Object.fromEntries(new URLSearchParams(to!.slice("/hub#".length)))
    expect(keys(classicRedirect("/workflows/editor", new URLSearchParams("id=deploy"), "http://daemon.test"))).toEqual({ page: "editor", "e-wf": "deploy" })
    expect(keys(classicRedirect("/workflows/editor", new URLSearchParams("new=1"), "http://daemon.test"))).toEqual({ page: "editor", "e-new": "1" })
    // Nothing named: the Workflows page.
    expect(keys(classicRedirect("/workflows/editor", new URLSearchParams(""), "http://daemon.test"))).toEqual({ page: "workflows" })
  })

  describe("served", () => {
    let server: Server | undefined
    afterEach(async () => {
      if (server) await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    })
    async function start(): Promise<string> {
      const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: "http://daemon.invalid:18800" } })
      const ctx = { boards: [], sources: new Map(), config } as unknown as Ctx
      server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }

    it("redirects /tasks/<id> to the Wall", async () => {
      const base = await start()
      const r = await fetch(`${base}/tasks/t1?agent=ops`, { redirect: "manual" })
      expect(r.status).toBe(302)
      expect(r.headers.get("location")).toBe("/#page=task&task=t1&agent=ops&node=http%3A%2F%2Fdaemon.invalid%3A18800")
    })

    it("redirects /agents/<id>/history to the Wall", async () => {
      const base = await start()
      const r = await fetch(`${base}/agents/ops/history?node=http://peer.test`, { redirect: "manual" })
      expect(r.status).toBe(302)
      expect(r.headers.get("location")).toBe("/hub#page=activity&a-agent=ops&a-period=30d")
    })

    it("redirects /workflows/editor to the Wall's editor page (#1524)", async () => {
      const base = await start()
      const r = await fetch(`${base}/workflows/editor?id=github-sweep`, { redirect: "manual" })
      expect(r.status).toBe(302)
      expect(r.headers.get("location")).toBe("/hub#page=editor&e-wf=github-sweep")
      const n = await fetch(`${base}/workflows/editor?new=1`, { redirect: "manual" })
      expect(n.headers.get("location")).toBe("/hub#page=editor&e-new=1")
    })

    it("still answers 400 without an agent", async () => {
      const base = await start()
      const r = await fetch(`${base}/tasks/t1`, { redirect: "manual" })
      expect(r.status).toBe(400)
    })
  })
})
