// Old Task links open the merged Task page (#2101 T3): the old post page
// (`#post=<id>`), the old run page (`#page=task&task=…`, where /tasks/<id>
// lands) and the T1/T2 review id, with the right run open; and the links the
// Hub and the daemon write point at the Task page straight away.
import { describe, expect, it } from "vitest"
import { TASK_PAGE, TASK_PREVIEW_PAGE, taskFallback, taskHash, taskRedirect } from "../src/hub/task/old-links"
import { taskAddress, taskLoadError } from "../src/hub/task/task-data"
import { HubApiError } from "../src/hub/api"
import { HUB_REACT_PAGES } from "../src/hub/pages"
import { classicRedirect } from "../src/daemon/ui/classic-routes"
import { hubPostPath } from "../src/daemon/ui/hub-name"
import { postHash } from "../src/hub/feed/model"
import { openWall } from "./wall-settings-harness"

const keys = (hash: string) => Object.fromEntries(new URLSearchParams(hash.replace(/^[^#]*#/, "")))
const addr = (hash: string) => taskAddress(new URLSearchParams(hash.replace(/^[^#]*#/, "")))

describe("the Task page owns #page=task", () => {
  it("is a React page, owner only, and the review id is gone", () => {
    expect(TASK_PAGE).toBe("task")
    expect(HUB_REACT_PAGES).toContainEqual({ page: "task", ownerOnly: true })
    expect(HUB_REACT_PAGES.map((p) => p.page)).not.toContain(TASK_PREVIEW_PAGE)
  })
  it("writes a request's address and a run's", () => {
    expect(taskHash({ id: "req 1" })).toBe("#page=task&id=req+1")
    expect(taskHash({ id: "req-1", peer: "http://p:1", run: "t9" })).toBe("#page=task&id=req-1&peer=http%3A%2F%2Fp%3A1&run=t9")
    expect(taskHash({ task: "t1", agent: "ops", peer: null })).toBe("#page=task&task=t1&agent=ops")
  })
})

describe("where an old address goes when React draws the Task page", () => {
  it("#post=<id> opens the request, on the node that keeps it", () => {
    expect(taskRedirect("#post=req-1")).toBe("#page=task&id=req-1")
    expect(taskRedirect("#status=open&view=list&post=req%201")).toBe("#page=task&id=req+1")
    expect(taskRedirect("#post=req-1", (id) => (id === "req-1" ? "http://peer:18800" : null))).toBe("#page=task&id=req-1&peer=http%3A%2F%2Fpeer%3A18800")
  })
  it("the review id keeps every part of its address", () => {
    expect(taskRedirect("#page=task-preview&id=req-1&run=t9")).toBe("#page=task&id=req-1&run=t9")
    expect(taskRedirect("#page=task-preview&task=t1&agent=ops")).toBe("#page=task&task=t1&agent=ops")
  })
  it("an old run address is a Task page address already: it stays, and opens its run", () => {
    const old = "#page=task&task=t1&agent=ops&node=http%3A%2F%2Fpeer&ch=slack&ask=hi&done=1"
    expect(taskRedirect(old)).toBeNull()
    expect(addr(old)).toEqual({ id: null, task: "t1", agent: "ops", peer: "http://peer", run: "t1" })
  })
  it("leaves every other address alone", () => {
    for (const h of ["", "#status=open", "#page=live", "#page=task&id=req-1", "#page=settings&section=mesh"]) expect(taskRedirect(h), h).toBeNull()
  })
})

describe("where a Task page address goes when React does not draw it (legacyPages, ?legacy=1, not the owner)", () => {
  it("a request to the old post page", () => {
    expect(taskFallback("#page=task&id=req-1")).toBe("#status=open&post=req-1")
    expect(taskFallback("#page=task&id=req-1&peer=http%3A%2F%2Fp&run=t9")).toBe("#status=open&post=req-1")
    expect(taskFallback("#page=task-preview&id=req-1")).toBe("#status=open&post=req-1")
  })
  it("a run to the old run page, its peer as the node", () => {
    expect(keys(taskFallback("#page=task&task=t1&agent=ops&peer=http%3A%2F%2Fp&run=t1")!)).toEqual({ page: "task", task: "t1", agent: "ops", node: "http://p" })
    expect(keys(taskFallback("#page=task-preview&task=t1&agent=ops")!)).toEqual({ page: "task", task: "t1", agent: "ops" })
  })
  it("keeps an old run address as it is", () => {
    expect(taskFallback("#page=task&task=t1&agent=ops&node=http%3A%2F%2Fn&ch=slack&ask=hi&at=x&done=1")).toBeNull()
    expect(taskFallback("#status=open&post=req-1")).toBeNull()
    expect(taskFallback("#page=live")).toBeNull()
  })
})

describe("/tasks/<id>?agent= (old run Task page)", () => {
  it("lands on the Task page with that run open", () => {
    const to = classicRedirect("/tasks/t%201", new URLSearchParams("agent=ops&node=http://peer.test&channel=slack"), "http://daemon.test")!
    expect(to.startsWith("/hub#")).toBe(true)
    expect(keys(to)).toMatchObject({ page: "task", task: "t 1", agent: "ops", run: "t 1", node: "http://peer.test" })
    expect(addr(to)).toEqual({ id: null, task: "t 1", agent: "ops", peer: "http://peer.test", run: "t 1" })
  })
})

describe("a Task page that cannot be found", () => {
  it("is not found on a 404 from the node, a failure otherwise", () => {
    expect(taskLoadError(new HubApiError(404, "no post for that id"))).toBe("missing")
    expect(taskLoadError(new HubApiError(404, "unknown peer: http://gone"))).toBe("failed")
    expect(taskLoadError(new HubApiError(502, "daemon unreachable"))).toBe("failed")
    expect(taskLoadError(new Error("offline"))).toBe("failed")
  })
})

describe("links to a request point at the Task page", () => {
  it("a push or a chat message about a request (hubPostPath)", () => {
    expect(hubPostPath("req 7")).toBe("/hub#page=task&id=req+7")
  })
  it("a post in the feed opens on its node", () => {
    expect(postHash({ id: "req-1" })).toBe("#page=task&id=req-1")
    expect(postHash({ id: "req-1", node: { name: "mini", peer: "http://p" } })).toBe("#page=task&id=req-1&peer=http%3A%2F%2Fp")
  })
})

describe("the old Hub script sends old addresses on (wall.client.ts)", () => {
  const PAGES = [TASK_PAGE]
  const route = (url: string) => url.startsWith("/api/admin/wall?")
    ? { status: 200, body: { node: "node-a", syncedAt: Date.now(), nodes: [{ name: "node-a", ok: true }], failures: [], posts: [
      { id: "r-peer", state: "in_progress", headline: "On a peer", owner: "cx", createdAt: 1, lastMoveAt: 1, node: { name: "mini", peer: "http://mini:18800", daemonUrl: "http://mini:18800" } },
    ] } }
    : undefined

  it("#post=<id> opens the Task page, and tells the React Hub", async () => {
    const w = openWall({ hash: "#status=open&post=r1", hubPages: PAGES })
    await w.settle()
    expect(w.hash()).toBe("#page=task&id=r1")
    expect(w.dispatched).toContainEqual({ type: "hashchange", hash: "#page=task&id=r1" })
    expect(w.wall.classList.contains("is-hub")).toBe(true)
    expect(w.wall.classList.contains("is-post")).toBe(false)
  })

  it("#post=<id> of a request a peer keeps opens it there", async () => {
    const w = openWall({ hash: "#post=r-peer", hubPages: PAGES, route })
    await w.settle()
    expect(w.hash()).toBe("#page=task&id=r-peer&peer=http%3A%2F%2Fmini%3A18800")
  })

  it("a #post= link clicked later goes too", async () => {
    const w = openWall({ hash: "", hubPages: PAGES })
    await w.settle()
    await w.go("#post=r2")
    expect(w.hash()).toBe("#page=task&id=r2")
  })

  it("an old run address stays, drawn by React, and the old run page does not start", async () => {
    const old = "#page=task&task=t1&agent=cx&node=http%3A%2F%2Fnode-a"
    const w = openWall({ hash: old, hubPages: PAGES })
    await w.settle()
    expect(w.hash()).toBe(old)
    expect(w.wall.classList.contains("is-hub")).toBe(true)
    // The old run page streams its run; with React drawing it, nothing does.
    expect(w.sources.map((s: { url: string }) => s.url).filter((u: string) => u.includes("/api/task/"))).toEqual([])
    expect(w.calls.map((c) => c.url).filter((u) => u.startsWith("/api/task/"))).toEqual([])
  })

  it("the T1/T2 review id opens the Task page", async () => {
    const w = openWall({ hash: "#page=task-preview&id=r1&run=t9", hubPages: PAGES })
    await w.settle()
    expect(w.hash()).toBe("#page=task&id=r1&run=t9")
  })

  it("without React's Task page, a Task page address goes back to the old pages", async () => {
    const post = openWall({ hash: "#page=task&id=r1", hubPages: [] })
    await post.settle()
    expect(post.hash()).toBe("#status=open&post=r1")
    expect(post.wall.classList.contains("is-post")).toBe(true)

    const run = openWall({ hash: "#page=task&task=t1&agent=cx&peer=http%3A%2F%2Fnode-a&run=t1", hubPages: [] })
    await run.settle()
    expect(keys(run.hash())).toEqual({ page: "task", task: "t1", agent: "cx", node: "http://node-a" })
    expect(run.wall.classList.contains("is-hub")).toBe(false)
  })

  it("without React's Task page, #post= and old run addresses stay where they were", async () => {
    const w = openWall({ hash: "#status=open&post=r1", hubPages: [] })
    await w.settle()
    expect(w.hash()).toBe("#status=open&post=r1")
    expect(w.wall.classList.contains("is-post")).toBe(true)
  })
})
