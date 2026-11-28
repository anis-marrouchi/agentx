// The Task page's read, sent by the /hub document before the old Hub
// script's reads (req-01M8CTCW, src/hub/task/early.ts).
import { describe, expect, it, vi } from "vitest"
import { taskEarlyRead, taskEarlyStart, type TaskEarly } from "../src/hub/task/early"
import { taskAddress, taskThreadPath, taskThreadQuery } from "../src/hub/task/task-data"
import { injectFns } from "../src/daemon/ui/inject"

const PAGES = ["task", "home"]

function fakeWindow(hash: string, opts: { pages?: string[]; token?: string; reply?: { ok: boolean; body?: unknown } | Error } = {}) {
  const reply = opts.reply ?? { ok: true, body: { post: { id: "req-1" } } }
  const fetch = vi.fn(async () => {
    if (reply instanceof Error) throw reply
    return { ok: reply.ok, json: async () => reply.body }
  })
  const w = { location: { hash }, AX_HUB: { pages: opts.pages ?? PAGES }, AX_LOCAL_TOKEN: opts.token, fetch } as unknown as Window & { AX_TASK_EARLY?: TaskEarly }
  return { w, fetch }
}

describe("taskEarlyRead: the read a Task page address needs", () => {
  it("reads a request by id, else by run, with its peer", () => {
    expect(taskEarlyRead("#page=task&id=req-1", PAGES)).toEqual({ path: "/api/admin/wall/thread?id=req-1", peer: null })
    expect(taskEarlyRead("#page=task&id=a%2Fb&peer=http%3A%2F%2Fp", PAGES)).toEqual({ path: "/api/admin/wall/thread?id=a%2Fb", peer: "http://p" })
    expect(taskEarlyRead("#page=task&task=t1&agent=ops&node=http%3A%2F%2Fn", PAGES)).toEqual({ path: "/api/admin/wall/thread?task=t1", peer: "http://n" })
    // The old post link and the T1/T2 review id go to the Task page too.
    expect(taskEarlyRead("#post=req-2", PAGES)).toEqual({ path: "/api/admin/wall/thread?id=req-2", peer: null })
    expect(taskEarlyRead("#page=task-preview&id=req-3", PAGES)?.path).toBe("/api/admin/wall/thread?id=req-3")
  })
  it("is null off the Task page, with no request named, or when the old Hub draws it", () => {
    expect(taskEarlyRead("", PAGES)).toBeNull()
    expect(taskEarlyRead("#page=jobledger", PAGES)).toBeNull()
    expect(taskEarlyRead("#page=task", PAGES)).toBeNull()
    expect(taskEarlyRead("#page=task&id=req-1", ["home"])).toBeNull()
    expect(taskEarlyRead("#post=req-1", [])).toBeNull()
  })
  it("names the same read, and the same query entry, as the page", () => {
    for (const hash of ["#page=task&id=a%2Fb&peer=http%3A%2F%2Fp", "#page=task&task=t1&agent=ops&node=http%3A%2F%2Fn", "#page=task&id=r&task=t"]) {
      const addr = taskAddress(new URLSearchParams(hash.slice(1)))
      const early = taskEarlyRead(hash, PAGES)!
      expect(taskThreadQuery(early.path, early.peer).queryKey).toEqual(taskThreadQuery(taskThreadPath(addr), addr.peer).queryKey)
    }
  })
})

describe("taskEarlyStart: sends it once, from the /hub document", () => {
  it("sends the read with the token and the peer, and leaves the reply for the page", async () => {
    const { w, fetch } = fakeWindow("#page=task&id=req-1&peer=http%3A%2F%2Fp", { token: "tok" })
    taskEarlyStart(w)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe("/api/admin/wall/thread?id=req-1")
    expect(init.headers).toEqual({ "X-Requested-With": "agentx-board", Authorization: "Bearer tok", "X-Agentx-Peer": "http://p" })
    expect(w.AX_TASK_EARLY).toMatchObject({ path: "/api/admin/wall/thread?id=req-1", peer: "http://p" })
    await expect(w.AX_TASK_EARLY!.reply).resolves.toEqual({ ok: true, body: { post: { id: "req-1" } } })
  })
  it("sends nothing off the Task page", () => {
    const { w, fetch } = fakeWindow("#page=jobledger")
    taskEarlyStart(w)
    expect(fetch).not.toHaveBeenCalled()
    expect(w.AX_TASK_EARLY).toBeUndefined()
  })
  it("a refused or failed read leaves the page to read it itself", async () => {
    const refused = fakeWindow("#page=task&id=req-1", { reply: { ok: false } })
    taskEarlyStart(refused.w)
    await expect(refused.w.AX_TASK_EARLY!.reply).resolves.toEqual({ ok: false, body: null })
    const down = fakeWindow("#page=task&id=req-1", { reply: new Error("network") })
    taskEarlyStart(down.w)
    await expect(down.w.AX_TASK_EARLY!.reply).resolves.toBeNull()
  })
  it("runs as the page ships it (injectFns, no module scope)", () => {
    const { w, fetch } = fakeWindow("#post=req-9")
    new Function("window", injectFns({ taskEarlyRead, taskEarlyStart }) + "taskEarlyStart(window);")(w)
    expect(fetch).toHaveBeenCalledWith("/api/admin/wall/thread?id=req-9", expect.anything())
  })
})
