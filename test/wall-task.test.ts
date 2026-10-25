import { describe, expect, it } from "vitest"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"
import { lastActivityOf, LAST_ACTIVITY_MAX } from "../src/agents/last-activity"

// #1381: the Wall's Live page lists the sessions and jobs running now, and
// each opens the Task page: its conversation, live or stored, and the steer
// box (a message as the next turn, or Stop). These run the page's real
// script against a stubbed DOM, fetch and EventSource.

const NOW = Date.now()
const node = { name: "node-a", peer: null, daemonUrl: null }
const WALL = {
  node: "node-a", syncedAt: NOW, nodes: [{ name: "node-a", ok: true }], failures: [],
  posts: [{
    id: "r1", owner: "cx", state: "in_progress", headline: "Refund for order 12", askedBy: "Demo operator", group: { channel: "telegram", chatId: "demo" },
    project: null, node, createdAt: NOW - 7200e3, lastMoveAt: NOW - 600e3, closedAt: null, runs: 1, failedRuns: 0, runMs: 120e3,
    blocked: null, timeFlag: null, home: null, evidence: null, lastRun: { taskId: "t9", agentId: "cx" },
  }],
}
const LIVE = { nodes: [
  { name: "node-a", url: "http://node-a", reachable: true, agents: [
    { id: "cx", name: "Customer Desk", runningTasks: [{ id: "t9", traceId: "tr9", channel: "telegram", chatId: "demo", startedAt: new Date(NOW - 125e3).toISOString(), messagePreview: "Answering a refund", message: "Please answer the refund question", lastActivity: "Using Read" }] },
    { id: "ops", name: "Night Shift", runningTasks: [{ id: "t10", channel: "cron", chatId: "cron:daily-digest", startedAt: new Date(NOW - 30e3).toISOString(), messagePreview: "Write the digest", step: "agent" }] },
  ] },
  { name: "node-b", url: "http://node-b", reachable: false, error: "unreachable", agents: [] },
] }

type Reply = { ok?: boolean; status?: number; body: unknown }
function openWall(opts: { hash: string; live?: unknown; history?: unknown; thread?: unknown; action?: (kind: string) => Reply }) {
  const page = renderWallPage()
  const script = CRON_VALUE_SCRIPT + "\n" + WALL_PAGE_SCRIPT
  const els = new Map<string, any>()
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c) } }
  const el = (id: string) => {
    if (!els.has(id)) {
      // The steer box (tk-*) and the post's action box (wdo-*) are drawn by the script.
      const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(page) ?? (/^(wdo|tk)-/.test(id) ? [`<x id="${id}">`] : null)
      if (!tag) throw new Error(`no element #${id} on the page`)
      let html = ""
      els.set(id, {
        get innerHTML() { return html },
        set innerHTML(v: string) {
          html = v
          for (const m of v.matchAll(/<(textarea|input)\b[^>]*\bid="([^"]+)"[^>]*>([^<]*)/g)) {
            if (els.has(m[2])) els.get(m[2]).value = m[1] === "textarea" ? m[3] : ""
          }
        },
        id, hidden: /\shidden[\s>]/.test(tag[0]), textContent: "", value: id === "f-status" ? "open" : "", checked: false, disabled: false,
        type: /type="checkbox"/.test(tag[0]) ? "checkbox" : /type="search"/.test(tag[0]) ? "search" : "select",
        classList: classes(), parentNode: { classList: classes() },
        addEventListener: () => {}, setAttribute: () => {},
      })
    }
    return els.get(id)
  }
  const onDoc: Record<string, Array<(ev: any) => void>> = {}
  const onWindow: Record<string, () => void> = {}
  const doc = {
    getElementById: (id: string) => (/^(wdo|tk)-/.test(id) && !els.has(id) && !new RegExp(`id="${id}"`).test(drawn()) ? null : el(id)),
    hidden: false,
    querySelector: (sel: string) => (sel === ".ax-wall" ? { classList: classes() } : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (ev: any) => void) => { (onDoc[t] ??= []).push(f) },
  }
  /** Everything the script has drawn, to know which of its fields exist. */
  const drawn = () => [...els.values()].map((e) => e.innerHTML).join("")
  const loc = { hash: opts.hash, search: "" }
  const calls: Array<{ url: string; init: any }> = []
  const fetchStub = (url: string, init: any) => {
    calls.push({ url, init })
    let r: Reply = { body: { runs: [] } }
    if (url.startsWith("/api/admin/wall?")) r = { body: WALL }
    else if (url === "/api/live") r = { body: opts.live ?? LIVE }
    else if (url.startsWith("/api/task/history?")) r = opts.history ? { body: opts.history } : { ok: false, status: 404, body: { error: "no record" } }
    else if (url.startsWith("/api/admin/wall/thread?")) r = opts.thread ? { body: opts.thread } : { ok: false, status: 404, body: { error: "no post for that id" } }
    else if (url.startsWith("/api/task/action?")) r = opts.action ? opts.action(new URL(url, "http://x").searchParams.get("kind")!) : { body: { ok: true } }
    return Promise.resolve({ ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body })
  }
  /** The run's live stream: the test sends its events. */
  const streams: Array<{ url: string; on: Record<string, (ev: any) => void>; closed: boolean; emit: (t: string, data?: unknown) => void }> = []
  class FakeEventSource {
    url: string; on: Record<string, (ev: any) => void> = {}; closed = false
    constructor(url: string) { this.url = url; streams.push(this as any) }
    addEventListener(t: string, f: (ev: any) => void) { this.on[t] = f }
    close() { this.closed = true }
    emit(t: string, data?: unknown) { this.on[t]?.(data === undefined ? {} : { data: JSON.stringify(data) }) }
  }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", script)(
    doc, { addEventListener: (t: string, f: () => void) => { onWindow[t] = f }, EventSource: FakeEventSource }, fetchStub, loc,
    { replaceState: (_: unknown, __: string, h: string) => { loc.hash = h } },
    { getItem: () => null, setItem: () => {} }, () => 0,
  )
  const click = (attrs: Record<string, string>) => {
    const t = { hasAttribute: (k: string) => k in attrs, getAttribute: (k: string) => attrs[k] }
    const ev = { preventDefault: () => {}, target: { closest: (sel: string) => Object.keys(attrs).some((k) => sel.includes(`[${k}]`)) ? t : null } }
    for (const f of onDoc.click ?? []) f(ev)
  }
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  const actions = () => calls.filter((c) => c.url.startsWith("/api/task/action?"))
  return { el, calls, click, settle, loc, streams, actions }
}

const TASK = "#page=task&task=t9&agent=cx&node=http%3A%2F%2Fnode-a&ch=telegram&trace=tr9"

describe("Wall v2 Live: the sessions and jobs running now (#1381)", () => {
  it("shows each run with its agent, what it works on, how long and what it did last, and opens its Task page", async () => {
    const w = openWall({ hash: "#page=live" })
    await w.settle()
    const html = w.el("wall-live").innerHTML
    const session = html.split('<a class="wls is-work"')[1].split("</a>")[0]
    expect(session).toContain('href="#page=task&amp;task=t9&amp;agent=cx&amp;node=http%3A%2F%2Fnode-a&amp;ch=telegram&amp;trace=tr9"')
    expect(session).toContain("● Session")
    expect(session).toContain("Answering a refund")
    expect(session).toContain('<span class="k">Latest</span> Using Read')
    expect(session).toMatch(/data-since="\d+">2m 0[45]s<\/b>/)
    expect(session).toContain("<span>Customer Desk</span>")
    // A job is named by its job id; its prompt stays on its Task page.
    const job = html.split('<a class="wls is-job"')[1].split("</a>")[0]
    expect(job).toContain("● Job")
    expect(job).toContain('<p class="wls__t">daily-digest</p>')
    expect(job).not.toContain("Write the digest")
    expect(job).toContain("Step: agent")
    expect(job).toContain("ch=cron")
    // A machine that does not answer is named, not left out silently.
    expect(html).toContain("node-b does not answer: what runs there is missing until it does.")
  })

  it("names a picked-up request by what was asked, not by its hand-over prompt", async () => {
    const pickup = "[agentx:request-pickup id=wp-1]\nThe owner gave you this task on the Wall on 2026-10-25 21:05 UTC.\n\nWhat they asked:\n@cx check the backlog\n\nDo the work now."
    const live = { nodes: [{ ...LIVE.nodes[0], agents: [{ id: "cx", name: "Customer Desk", runningTasks: [{ id: "t9", channel: "requests", startedAt: new Date(NOW).toISOString(), messagePreview: pickup.slice(0, 200), message: pickup }] }] }] }
    const w = openWall({ hash: "#page=live", live })
    await w.settle()
    expect(w.el("wall-live").innerHTML).toContain('<p class="wls__t">@cx check the backlog</p>')
    const t = openWall({ hash: "#page=task&task=t9&agent=cx&node=http%3A%2F%2Fnode-a", live })
    await t.settle()
    const conv = t.el("tk-conv").innerHTML
    expect(conv).toContain('<div class="ax-md"><p>@cx check the backlog</p></div><details class="wcv__full"><summary>The whole message the agent got</summary>')
  })

  it("opens the Task page from Join live on a post", async () => {
    const w = openWall({ hash: "#status=open&post=r1" })
    await w.settle()
    expect(w.el("wall-post").innerHTML).toContain('href="#page=task&amp;task=t9&amp;agent=cx&amp;node=http%3A%2F%2Fnode-a&amp;ch=telegram&amp;trace=tr9" title="Customer Desk is working now">● Join live</a>')
  })
})

describe("Wall v2 Task page and its steer box (#1381)", () => {
  it("streams a live run's conversation under its request", async () => {
    const w = openWall({ hash: TASK })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Task")
    expect(w.streams.map((s) => s.url)).toEqual(["/api/task/stream?node=http%3A%2F%2Fnode-a&agent=cx&task=t9"])
    w.streams[0].emit("start", { message: "Please answer the refund question", sender: "Demo operator", startedAt: new Date(NOW - 125e3).toISOString(), initial: "→ Read({\"file\":\"orders.md\"})\n← 12 lines\n" })
    w.streams[0].emit("chunk", { text: "The refund is **approved**.\nIt goes out today.\n" })
    await w.settle()
    const head = w.el("tk-head").innerHTML
    expect(head).toContain("● Live")
    expect(head).toContain('Running for <b id="tk-elapsed">2m')
    const conv = w.el("tk-conv").innerHTML
    expect(conv).toContain("<b>Demo operator</b>")
    expect(conv).toContain("Please answer the refund question")
    expect(conv).toContain("<summary>Used <b>Read</b></summary><pre>{&quot;file&quot;:&quot;orders.md&quot;}</pre>")
    expect(conv).toContain("<summary>Tool result</summary><pre>12 lines</pre>")
    expect(conv).toContain("<strong>approved</strong>")
    expect(conv.indexOf("refund question")).toBeLessThan(conv.indexOf("Used <b>Read"))
  })

  it("sends a message as the next turn, and stops the turn", async () => {
    const w = openWall({ hash: TASK })
    await w.settle()
    w.streams[0].emit("start", { initial: "" })
    await w.settle()
    const steer = w.el("tk-steer").innerHTML
    expect(steer).toContain('data-tk="stop"')
    expect(steer).toContain('data-tk="send"')
    w.click({ "data-tk": "send" })
    await w.settle()
    expect(w.actions()).toHaveLength(0)
    expect(w.el("tk-note").textContent).toBe("Write the message first.")
    w.el("tk-text").value = "Also mention the delivery date"
    w.click({ "data-tk": "send" })
    await w.settle()
    expect(w.actions().map((c) => c.url)).toEqual(["/api/task/action?node=http%3A%2F%2Fnode-a&task=t9&kind=followup"])
    expect(JSON.parse(w.actions()[0].init.body)).toEqual({ message: "Also mention the delivery date", agent: "cx" })
    expect(w.actions()[0].init.method).toBe("POST")
    expect(w.el("tk-text").value).toBe("")
    expect(w.el("tk-note").textContent).toBe("Sent: queued as the next turn.")
    expect(w.el("tk-conv").innerHTML).toContain('<li class="wcv is-you">')
    expect(w.el("tk-conv").innerHTML).toContain("Also mention the delivery date")
    w.click({ "data-tk": "stop" })
    await w.settle()
    expect(w.actions()[1].url).toBe("/api/task/action?node=http%3A%2F%2Fnode-a&task=t9&kind=cancel")
    expect(w.el("tk-note").textContent).toBe("Stop asked: the turn ends at its next step.")
  })

  it("says why a message was not sent", async () => {
    const w = openWall({ hash: TASK, action: () => ({ ok: false, status: 404, body: { error: "task not running" } }) })
    await w.settle()
    w.streams[0].emit("start", { initial: "" })
    w.el("tk-text").value = "Hello"
    w.click({ "data-tk": "send" })
    await w.settle()
    expect(w.el("tk-note").textContent).toBe("Not sent: task not running")
    expect(w.el("tk-text").value).toBe("Hello")
  })

  it("keeps what is typed when the snapshot refreshes the page", async () => {
    const w = openWall({ hash: TASK })
    await w.settle()
    w.el("tk-text").value = "half a thought"
    w.click({ "data-tab": "open" })
    await w.settle()
    expect(w.el("tk-text").value).toBe("half a thought")
    expect(w.streams).toHaveLength(1)
  })

  it("makes a finished run from another channel read-only", async () => {
    const history = { ok: true, channel: "telegram", message: "Please answer the refund question", sender: "Demo operator", startedAt: new Date(NOW - 600e3).toISOString(), transcript: "The refund is approved.\n", durationMs: 95e3 }
    const w = openWall({ hash: "#page=task&task=t9&agent=cx&node=http%3A%2F%2Fnode-a&done=1", history })
    await w.settle()
    expect(w.streams).toHaveLength(0)
    expect(w.calls.some((c) => c.url === "/api/task/history?node=http%3A%2F%2Fnode-a&agent=cx&task=t9")).toBe(true)
    expect(w.el("tk-head").innerHTML).toContain("Finished")
    expect(w.el("tk-head").innerHTML).toContain('Ran <b id="tk-elapsed">1m 35s</b>')
    expect(w.el("tk-conv").innerHTML).toContain("The refund is approved.")
    const steer = w.el("tk-steer").innerHTML
    expect(steer).toContain("This run came from telegram and has finished: it is read-only here.")
    expect(steer).not.toContain("tk-text")
    expect(steer).not.toContain("data-tk")
    w.click({ "data-tk": "send" })
    w.click({ "data-tk": "stop" })
    await w.settle()
    expect(w.actions()).toHaveLength(0)
  })

  it("points a finished tracked run to its post for a follow-up", async () => {
    const history = { ok: true, channel: "requests", message: "Check the stock", transcript: "Done.\n" }
    const w = openWall({ hash: "#page=task&task=t9&agent=cx&node=http%3A%2F%2Fnode-a&trace=tr9&done=1", history, thread: { post: WALL.posts[0], events: [], plan: [] } })
    await w.settle()
    await w.settle()
    const steer = w.el("tk-steer").innerHTML
    expect(steer).toContain("read-only here")
    expect(steer).toContain('comment on its post (<a href="')
    expect(steer).toContain('data-open="r1">open the post</a>')
    expect(steer).not.toContain("tk-text")
  })

  it("continues a finished scheduled run and follows the new turn", async () => {
    const history = { ok: true, channel: "cron", message: "Write the digest", sender: "cron:daily-digest", startedAt: new Date(NOW - 600e3).toISOString(), transcript: "Digest sent.\n" }
    const w = openWall({ hash: "#page=task&task=t10&agent=ops&node=http%3A%2F%2Fnode-a&done=1", history,
      action: () => ({ body: { ok: true, resumed: true, taskId: "t11", channel: "cron" } }) })
    await w.settle()
    expect(w.el("tk-conv").innerHTML).toContain("<b>Scheduled job daily-digest</b>")
    const steer = w.el("tk-steer").innerHTML
    expect(steer).toContain("Continue this scheduled run")
    expect(steer).toContain('data-tk="send"')
    expect(steer).not.toContain('data-tk="stop"')
    w.el("tk-text").value = "Add last week's numbers"
    w.click({ "data-tk": "send" })
    await w.settle()
    expect(w.actions().map((c) => new URL(c.url, "http://x").searchParams.get("kind"))).toEqual(["followup"])
    expect(w.loc.hash).toContain("task=t11")
    expect(w.loc.hash).toContain("ch=cron")
    expect(w.streams.map((s) => s.url)).toEqual(["/api/task/stream?node=http%3A%2F%2Fnode-a&agent=ops&task=t11"])
  })

  it("turns read-only when a live run from a chat ends, and offers to continue a job that ends", async () => {
    const chat = openWall({ hash: TASK })
    await chat.settle()
    chat.streams[0].emit("start", { initial: "" })
    chat.streams[0].emit("end", { reason: "completed" })
    await chat.settle()
    expect(chat.streams[0].closed).toBe(true)
    expect(chat.el("tk-head").innerHTML).toContain("Finished")
    expect(chat.el("tk-steer").innerHTML).toContain("read-only")
    const job = openWall({ hash: "#page=task&task=t10&agent=ops&node=http%3A%2F%2Fnode-a&ch=cron" })
    await job.settle()
    job.streams[0].emit("start", { initial: "" })
    job.streams[0].emit("end", { reason: "completed" })
    await job.settle()
    expect(job.el("tk-steer").innerHTML).toContain("Continue this scheduled run")
  })

  it("reads the stored record when the daemon no longer holds the run", async () => {
    const history = { ok: false, channel: "telegram", message: "Check the stock", transcript: "", error: "timed out" }
    const w = openWall({ hash: TASK, history })
    await w.settle()
    w.streams[0].emit("error", { message: "task not found or already evicted" })
    await w.settle()
    expect(w.el("tk-head").innerHTML).toContain("Failed")
    expect(w.el("tk-conv").innerHTML).toContain('<li class="wcv is-err"><b>Error</b><pre>timed out</pre></li>')
    expect(w.el("tk-steer").innerHTML).toContain("read-only")
  })

  it("shows the tracked request the run works on: where it stands, its plan and its facts", async () => {
    const plan = [{ idx: 1, name: "Answer the client", agentId: "cx", state: "active", doneWhen: "reply sent", evidence: null, note: null }]
    const w = openWall({ hash: TASK, thread: { node: "node-a", post: WALL.posts[0], events: [], plan } })
    await w.settle()
    await w.settle()
    const asked = w.calls.filter((c) => c.url.startsWith("/api/admin/wall/thread?")).map((c) => c.url)
    expect(asked).toEqual(["/api/admin/wall/thread?task=tr9"])
    const req = w.el("tk-req").innerHTML
    expect(req).toContain('data-open="r1">Refund for order 12</a>')
    expect(req).toContain('<ol class="wtk__prog"')
    expect(req).toContain("<b>Answer the client</b>")
    expect(req).toContain("<details class=\"wtp__facts\"><summary>Details</summary>")
    expect(req).toContain("<dt>Asked by</dt><dd>Demo operator</dd>")
  })

  it("asks a peer for the request of a run on that peer", async () => {
    const live = { nodes: [LIVE.nodes[0], { name: "node-b", url: "http://node-b", reachable: true, agents: [] }] }
    const w = openWall({ hash: "#page=task&task=t5&agent=far&node=http%3A%2F%2Fnode-b", live })
    await w.settle()
    const asked = w.calls.filter((c) => c.url.startsWith("/api/admin/wall/thread?"))
    expect(asked.map((c) => c.init.headers["X-Agentx-Peer"])).toEqual(["http://node-b"])
    expect(w.el("tk-req").innerHTML).toBe("")
  })

  it("closes the stream on leaving the page, and goes back to Live", async () => {
    const w = openWall({ hash: TASK })
    await w.settle()
    w.click({ "data-back": "" })
    await w.settle()
    expect(w.streams[0].closed).toBe(true)
    expect(w.loc.hash).toBe("#page=live")
    expect(w.el("wall-task").hidden).toBe(true)
  })

  it("names no task for a link without one", async () => {
    const w = openWall({ hash: "#page=task&task=t9" })
    await w.settle()
    expect(w.el("wall-task").innerHTML).toContain("This link names no task.")
    expect(w.streams).toHaveLength(0)
  })
})

describe("A running task's latest activity (#1381)", () => {
  it("names a tool call without its arguments, and a result only by whether it failed", () => {
    expect(lastActivityOf("→ Read({\"file\":\"secret.md\"})\n")).toBe("Using Read")
    expect(lastActivityOf("→ Bash({\"cmd\":\"ls\"})\n← total 3\n")).toBe("Read a tool result")
    expect(lastActivityOf("← [error] permission denied\n")).toBe("A tool failed")
  })

  it("reads the last complete line, bounded", () => {
    expect(lastActivityOf(undefined)).toBeUndefined()
    expect(lastActivityOf("")).toBeUndefined()
    expect(lastActivityOf("💭 checking the order\n\n")).toBe("Thinking: checking the order")
    expect(lastActivityOf("· compacting\nThe refund is appr")).toBe("compacting")
    expect(lastActivityOf("The refund is approved\n")).toBe("Writing: The refund is approved")
    expect(lastActivityOf("[error] timed out\n")).toBe("Error: timed out")
    expect(lastActivityOf("done\n[task finished]\n")).toBe("Finished")
    const long = lastActivityOf("x".repeat(500) + "\n")!
    expect(long.length).toBe(LAST_ACTIVITY_MAX)
    expect(long.endsWith("…")).toBe(true)
  })
})
