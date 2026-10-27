import { describe, expect, it } from "vitest"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"
import { lastActivityLine } from "../src/agents/registry"

// #1381: the Wall's Live page lists the sessions and jobs running now, and
// each opens the Wall's Task page: the request, the run's conversation and
// a steer box (followup, Stop). These run the page's real script against a
// stubbed DOM, fetch and EventSource.

const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const LIVE = { nodes: [
  { name: "node-a", url: "http://node-a", reachable: true, agents: [
    { id: "cx", name: "Customer Desk", runningTasks: [{ id: "t9", traceId: "tr9", channel: "telegram", startedAt: iso(NOW - 125e3), messagePreview: "Answering a refund", message: "Answering a refund for order 47", lastActivity: '→ Bash({"command":"ls"})' }] },
    { id: "ops", name: "Night Shift", runningTasks: [{ id: "t5", channel: "cron", sender: "cron:digest", startedAt: iso(NOW - 30e3), messagePreview: "Morning digest", step: "agent" }] },
  ] },
] }

function openWall(opts: { hash: string; live?: unknown; history?: unknown; thread?: unknown; action?: unknown }) {
  const page = renderWallPage()
  const script = CRON_VALUE_SCRIPT + "\n" + WALL_PAGE_SCRIPT
  const els = new Map<string, any>()
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c), add: (c: string) => s.add(c) } }
  const attrsOf = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"')]))
  const make = (id: string, tag: string) => {
    const on: Record<string, (ev?: unknown) => void> = {}
    let html = ""
    const e: any = {
      on, id, attrs: attrsOf(tag), hidden: /\shidden[\s>]/.test(tag), textContent: "", value: id === "f-status" ? "open" : "", checked: false,
      type: /type="checkbox"/.test(tag) ? "checkbox" : "select", style: {}, disabled: false, placeholder: "", children: [] as any[],
      classList: classes(), parentNode: { classList: classes() },
      get innerHTML() { return html },
      set innerHTML(v: string) {
        html = v
        // Elements the script draws: each tag with an id becomes one.
        for (const m of v.matchAll(/<(\w+)\b[^>]*\sid="([^"]+)"[^>]*>/g)) els.set(m[2], make(m[2], m[0]))
      },
      getAttribute: (k: string) => e.attrs[k] ?? null, setAttribute: (k: string, v: string) => { e.attrs[k] = v },
      hasAttribute: (k: string) => k in e.attrs,
      addEventListener: (t: string, f: (ev?: unknown) => void) => { on[t] = f },
      appendChild: (c: any) => { e.children.push(c); return c },
      querySelector: (sel: string) => {
        const cls = sel.replace(/^\./, "")
        for (const x of els.values()) if ((x.attrs.class || "").split(" ").includes(cls)) return x
        return null
      },
    }
    return e
  }
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(page)
      if (!tag) throw new Error(`no element #${id} on the page`)
      els.set(id, make(id, tag[0]))
    }
    return els.get(id)
  }
  const onDoc: Record<string, Array<(ev: any) => void>> = {}
  const onWindow: Record<string, () => void> = {}
  const doc = {
    getElementById: el, hidden: false,
    querySelector: (sel: string) => (sel === ".ax-wall" ? { classList: classes() } : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (ev: any) => void) => { (onDoc[t] ??= []).push(f) },
    createElement: () => { const c: any = { className: "", innerHTML: "", setAttribute() {}, querySelector: () => ({ setAttribute() {}, innerHTML: "" }) }; return c },
  }
  const loc: any = { hash: opts.hash, search: "", href: "" }
  const calls: Array<{ url: string; init: any }> = []
  const fetchStub = (url: string, init: any) => {
    calls.push({ url, init })
    const body = url.startsWith("/api/admin/wall?") ? { node: "node-a", syncedAt: NOW, nodes: [{ name: "node-a", ok: true }], failures: [], posts: [] }
      : url === "/api/live?quick=1" ? (opts.live ?? LIVE)
      : url.startsWith("/api/task/history?") ? (opts.history ?? {})
      : url.startsWith("/api/task/action?") ? (opts.action ?? { ok: true })
      : url.startsWith("/api/admin/wall/thread?") ? (opts.thread ?? null)
      : { runs: [] }
    return Promise.resolve({ ok: body !== null, status: body === null ? 404 : 200, json: async () => body })
  }
  const streams: Array<{ url: string; on: Record<string, (ev: any) => void>; closed: boolean }> = []
  class FakeEventSource {
    s: { url: string; on: Record<string, (ev: any) => void>; closed: boolean }
    constructor(url: string) { this.s = { url, on: {}, closed: false }; streams.push(this.s) }
    addEventListener(t: string, f: (ev: any) => void) { this.s.on[t] = f }
    close() { this.s.closed = true }
  }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", "EventSource", "requestAnimationFrame", script)(
    doc, { addEventListener: (t: string, f: () => void) => { onWindow[t] = f } }, fetchStub, loc,
    { replaceState: (_: unknown, __: string, h: string) => { loc.hash = h } },
    { getItem: () => null, setItem: () => {} }, () => 0, FakeEventSource, (f: () => void) => { f(); return 1 },
  )
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  const go = (hash: string) => { loc.hash = hash; onWindow.hashchange?.() }
  return { el, calls, settle, loc, streams, go }
}

describe("Wall Live: sessions and jobs running now (#1381)", () => {
  it("shows each run's agent, what it is on, how long it has run and its latest activity", async () => {
    const w = openWall({ hash: "#page=live" })
    await w.settle()
    const html = w.el("wall-live").innerHTML
    expect(html).toContain("<h3>Running now <small>2</small></h3>")
    const cx = html.split("task=t9")[1].split("</a>")[0]
    expect(cx).toContain("● Session")
    expect(cx).toContain("<b>Customer Desk</b><span class=\"h\">@cx</span>")
    expect(cx).toContain("Answering a refund")
    expect(cx).toContain("for 2 min")
    expect(cx).toContain("Using Bash")
    const job = html.split("task=t5")[1].split("</a>")[0]
    expect(job).toContain("● Job")
    expect(job).toContain('<span class="chip chip--ghost">digest</span>')
    expect(job).toContain("Step: agent")
  })

  it("opens the run's Task page from a card, and follows the live stream while open", async () => {
    const w = openWall({ hash: "#page=live" })
    await w.settle()
    const html = w.el("wall-live").innerHTML
    expect(html).toContain('<a class="wls is-work" href="#page=task&amp;task=t9&amp;agent=cx&amp;node=http%3A%2F%2Fnode-a&amp;trace=tr9&amp;ch=telegram&amp;ask=Answering+a+refund+for+order+47&amp;at=')
    const live = w.streams.find((s) => s.url === "/api/live/stream")!
    expect(live).toBeTruthy()
    // A snapshot with the run gone takes its card away.
    live.on.snapshot({ data: JSON.stringify({ nodes: [{ ...LIVE.nodes[0], agents: [{ id: "cx", name: "Customer Desk", runningTasks: [] }] }] }) })
    expect(w.el("wall-live").innerHTML).toContain("No session or job is running.")
    w.go("#page=agents")
    await w.settle()
    expect(live.closed).toBe(true)
  })

  it("points Join live on an agent's page at the Wall's Task page", async () => {
    const w = openWall({ hash: "#page=agents" })
    await w.settle()
    const cx = w.el("wall-agents-page").innerHTML.split('id="agent-cx"')[1].split('id="agent-')[0]
    expect(cx).toContain('href="#page=task&amp;task=t9&amp;agent=cx')
    expect(cx).toContain("● Join live</a>")
  })
})

describe("Wall Task: the run, its conversation and a steer box (#1381)", () => {
  const LIVE_HASH = "#page=task&task=t9&agent=cx&node=http%3A%2F%2Fnode-a&trace=tr9&ch=telegram&ask=Answering+a+refund"

  it("streams a running task and shows the request it was given", async () => {
    const w = openWall({ hash: LIVE_HASH })
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Task")
    expect(w.el("wall-task").hidden).toBe(false)
    expect(w.el("wtask-root").getAttribute("data-task-id")).toBe("t9")
    expect(w.el("task-ask").hidden).toBe(false)
    const stream = w.streams.find((s) => s.url.startsWith("/api/task/stream?"))!
    expect(stream.url).toBe("/api/task/stream?node=http%3A%2F%2Fnode-a&agent=cx&task=t9")
    stream.on.start({ data: JSON.stringify({ initial: "" }) })
    expect(w.el("task-status").textContent).toBe("live")
    expect(w.el("wtask-steer").hidden).toBe(false)
  })

  it("sends the steer box's message as the next turn (followup)", async () => {
    const w = openWall({ hash: LIVE_HASH })
    await w.settle()
    w.el("task-input").value = "Use the new refund form"
    w.el("task-send").on.click()
    await w.settle()
    const sent = w.calls.filter((c) => c.url.startsWith("/api/task/action?"))
    expect(sent.map((c) => c.url)).toEqual(["/api/task/action?node=http%3A%2F%2Fnode-a&task=t9&kind=followup"])
    expect(sent[0].init.method).toBe("POST")
    expect(JSON.parse(sent[0].init.body)).toEqual({ message: "Use the new refund form", agent: "cx" })
    expect(w.el("task-input").value).toBe("")
    expect(w.el("task-hint").textContent).toBe("queued — dispatches as the next turn")
  })

  it("stops the running turn (cancel)", async () => {
    const w = openWall({ hash: LIVE_HASH })
    await w.settle()
    w.el("task-stop").on.click()
    await w.settle()
    const sent = w.calls.filter((c) => c.url.startsWith("/api/task/action?"))
    expect(sent.map((c) => c.url)).toEqual(["/api/task/action?node=http%3A%2F%2Fnode-a&task=t9&kind=cancel"])
    expect(JSON.parse(sent[0].init.body)).toEqual({})
    expect(w.el("task-hint").textContent).toBe("stop requested")
  })

  it("keeps a finished run from another channel read-only", async () => {
    const w = openWall({ hash: "#page=task&task=t1&agent=cx&node=http%3A%2F%2Fnode-a&ch=telegram&done=1",
      history: { ok: true, channel: "telegram", message: "Ship it", transcript: "done\n" } })
    await w.settle()
    expect(w.calls.some((c) => c.url === "/api/task/history?node=http%3A%2F%2Fnode-a&agent=cx&task=t1")).toBe(true)
    expect(w.streams.some((s) => s.url.startsWith("/api/task/stream?"))).toBe(false)
    expect(w.el("task-status").textContent).toBe("archived")
    expect(w.el("wtask-steer").hidden).toBe(true)
    expect(w.el("wall-task").innerHTML).toContain("This run is finished.")
  })

  it("lets a finished cron run be continued, and follows the new turn on the Wall", async () => {
    const w = openWall({ hash: "#page=task&task=t5&agent=ops&node=http%3A%2F%2Fnode-a&ch=cron&done=1",
      history: { ok: true, channel: "cron", message: "Morning digest" },
      action: { resumed: true, taskId: "t6", channel: "cron" } })
    await w.settle()
    expect(w.el("wtask-steer").hidden).toBe(false)
    expect(w.el("task-stop").style.display).toBe("none")
    w.el("task-input").value = "Add the weekend numbers"
    w.el("task-send").on.click()
    await w.settle()
    expect(w.loc.href).toBe("#page=task&task=t6&agent=ops&node=http%3A%2F%2Fnode-a&ch=cron")
  })

  it("shows the tracked request's status strip, plan and facts", async () => {
    const post = { id: "r1", owner: "cx", state: "in_progress", headline: "Refund order 47", askedBy: "Demo operator", group: { channel: "telegram", chatId: "demo" },
      project: null, createdAt: NOW - 7200e3, lastMoveAt: NOW - 600e3, closedAt: null, runs: 1, failedRuns: 0, runMs: 120e3, blocked: null, timeFlag: null }
    const w = openWall({ hash: LIVE_HASH, thread: { post, plan: [{ name: "Check the order", agentId: "cx", state: "active" }] } })
    await w.settle()
    expect(w.calls.find((c) => c.url.startsWith("/api/admin/wall/thread?"))!.url).toBe("/api/admin/wall/thread?task=tr9")
    const d = w.el("wtask-details").innerHTML
    expect(d).toContain("Refund order 47")
    expect(d).toContain('href="#post=r1">Open the post</a>')
    expect(d).toContain('class="wtk__prog"')
    expect(d).toContain('class="wtk__plan"')
    expect(d).toContain('class="wtk__facts"')
  })

  it("closes the run's stream when the page is left", async () => {
    const w = openWall({ hash: LIVE_HASH })
    await w.settle()
    const stream = w.streams.find((s) => s.url.startsWith("/api/task/stream?"))!
    w.go("#page=live")
    await w.settle()
    expect(stream.closed).toBe(true)
    expect(w.el("wall-task").hidden).toBe(true)
  })
})

describe("Wall: no internal marker in visible text (#1443)", () => {
  const MARKED = { nodes: [
    { name: "node-a", url: "http://node-a", reachable: true, agents: [
      { id: "cx", name: "Customer Desk", runningTasks: [{ id: "t9", channel: "a2a", startedAt: iso(NOW - 60e3),
        messagePreview: "[agentx:delegation-result task=dlg-1 from=dev-session status=done]",
        message: "[agentx:delegation-result task=dlg-1 from=dev-session status=done]\nEarlier in this conversation you asked dev-session to help.",
        lastActivity: "· [agentx:plan-step id=req-1 step=2]\nWorking on the refund form" }] },
      { id: "ops", name: "Night Shift", runningTasks: [{ id: "t5", channel: "cron", sender: "cron:digest", startedAt: iso(NOW - 30e3),
        messagePreview: "[agentx:plan-step id=req-1 step=2]\nYou own step 2 of 3", step: "agent" }] },
    ] },
  ] }

  it("says a Live card's marker-only headline in plain words and drops markers from the rest", async () => {
    const w = openWall({ hash: "#page=live", live: MARKED })
    await w.settle()
    const html = w.el("wall-live").innerHTML
    const text = html.replace(/href="[^"]*"/g, "")
    expect(text).not.toContain("[agentx:")
    const cx = html.split("task=t9")[1].split("</a>")[0]
    expect(cx).toContain('<p class="wls__t">Result from dev-session</p>')
    expect(cx).toContain('<span class="wls__k">Latest</span> Working on the refund form</div>')
    expect(html.split("task=t5")[1].split("</a>")[0]).toContain("You own step 2 of 3")
    // The card's link carries what was asked, without the marker either.
    expect(html).toContain("ask=Earlier+in+this+conversation")
    w.go("#page=running")
    await w.settle()
    expect(w.el("wall-running").innerHTML.replace(/href="[^"]*"/g, "")).not.toContain("[agentx:")
  })

  it("drops markers from the Task page's request and the tracked post's headline", async () => {
    const post = { id: "r1", owner: "cx", state: "in_progress", headline: "[agentx:request-pickup id=r1]", askedBy: "Demo operator", group: { channel: "telegram", chatId: "demo" },
      project: null, createdAt: NOW - 7200e3, lastMoveAt: NOW - 600e3, closedAt: null, runs: 1, failedRuns: 0, runMs: 120e3, blocked: null, timeFlag: null }
    const w = openWall({ hash: "#page=task&task=t1&agent=cx&node=http%3A%2F%2Fnode-a&ch=a2a&done=1",
      history: { ok: true, channel: "a2a", message: "[agentx:plan-step id=r1 step=2]\nYou own step 2 of 3", transcript: "done\n" }, thread: { post, plan: [] } })
    await w.settle()
    expect(w.el("task-ask-body").innerHTML).toContain("You own step 2 of 3")
    expect(w.el("task-ask-body").innerHTML).not.toContain("[agentx:")
    expect(w.el("wtask-details").innerHTML).toContain("A request picked up again")
    expect(w.el("wtask-details").innerHTML).not.toContain("[agentx:")
  })
})

describe("lastActivityLine (#1381)", () => {
  it("gives the last non-empty line, cut to 160 characters", () => {
    expect(lastActivityLine("→ Read({})\n← ok\n\n")).toBe("← ok")
    expect(lastActivityLine("")).toBeUndefined()
    expect(lastActivityLine("x".repeat(300))).toHaveLength(160)
  })

  it("redacts a secret before cutting the line, since /health carries it", () => {
    const key = "sk-ant-" + "a".repeat(40)
    expect(lastActivityLine("← export KEY=" + key)).toBe("← export KEY=[redacted]")
    const cut = lastActivityLine("y".repeat(140) + " " + key) ?? ""
    expect(cut).not.toContain("sk-ant-")
  })
})
