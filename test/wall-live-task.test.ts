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

function openWall(opts: { hash: string; live?: unknown; history?: unknown; thread?: unknown; action?: unknown; replies?: Record<string, unknown> }) {
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
    const reply = Object.entries(opts.replies ?? {}).find(([k]) => url.startsWith(k))
    const body = reply ? reply[1]
      : url.startsWith("/api/admin/wall?") ? { node: "node-a", syncedAt: NOW, nodes: [{ name: "node-a", ok: true }], failures: [], posts: [] }
      : url === "/api/live" ? (opts.live ?? LIVE)
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
  /** Press the button whose tag is the first in `html` to match `attr`. */
  const press = (html: string, attr: string) => {
    const tag = new RegExp(`<button[^>]*${attr.replace(/[[\]]/g, "\\$&")}[^>]*>`).exec(html)
    if (!tag) throw new Error(`no button ${attr}`)
    const attrs = attrsOf(tag[0])
    const t = { getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs }
    const ev = {
      preventDefault() {}, stopPropagation() {},
      target: { closest: (sel: string) => sel.split(",").some((x) => { const m = /^\[([\w-]+)\]$/.exec(x.trim()); return !!m && m[1] in attrs }) ? t : null },
    }
    for (const f of onDoc.click ?? []) f(ev)
  }
  return { el, calls, settle, loc, streams, go, press }
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

// #1439: what the owner did on classic /live and /monitor, on Wall Live.
const PAUSED = { id: "t7", agentId: "cx", channel: "telegram", chatId: "demo", state: "stopped", stoppedAt: iso(NOW - 600e3), stoppedBy: "owner",
  reason: "Waiting for the new price list", request: "Update the price list", plan: { author: "agent", text: "1. Read the new list\n2. Update the page" }, resumable: true }
const OPS = { nodes: [
  { ...LIVE.nodes[0], uptimeSec: 7200, inflight: 2, restart: { state: "none" }, stoppedTasks: [PAUSED],
    attachSessions: [{ session: "abcd1234", project: "demo-site", agentIds: ["cx"], mode: "notify", lastSeenAt: NOW - 30e3, startedAt: NOW - 3600e3, pending: 0 }] },
  { name: "node-b", url: "http://node-b", reachable: false, error: "connect ECONNREFUSED", agents: [] },
] }
const posts = (w: ReturnType<typeof openWall>, path: string) => w.calls.filter((c) => c.url.startsWith(path) && c.init?.method === "POST")

describe("Wall Live: paused tasks, Resume and Drop (#1439)", () => {
  it("lists a paused task with who stopped it, why, its plan and Resume", async () => {
    const w = openWall({ hash: "#page=live", live: OPS })
    await w.settle()
    const html = w.el("wall-live").innerHTML
    expect(html).toContain("<h3>Paused <small>1</small></h3>")
    const card = html.split('class="wls is-stopped"')[1].split("</article>")[0]
    expect(card).toContain("stopped by you")
    expect(card).toContain("Update the price list")
    expect(card).toContain("Why: Waiting for the new price list")
    expect(card).toContain("<summary>Resume plan, by Customer Desk</summary>")
    expect(card).toContain('data-lv="resume"')
    expect(card).toContain("#page=task&amp;task=t7&amp;agent=cx")
  })

  it("resumes it on its machine with the same API as classic Live", async () => {
    const w = openWall({ hash: "#page=live", live: OPS })
    await w.settle()
    w.press(w.el("wall-live").innerHTML, 'data-lv="resume"')
    await w.settle()
    const sent = posts(w, "/api/signals/resume")
    expect(sent.map((c) => c.url)).toEqual(["/api/signals/resume?node=http%3A%2F%2Fnode-a"])
    expect(JSON.parse(sent[0].init.body)).toEqual({ id: "t7" })
    expect(sent[0].init.headers["X-Requested-With"]).toBe("agentx-board")
    expect(w.el("wall-live").innerHTML).toContain("Resumed: it goes on from its plan.")
  })

  it("asks once more on the button before it drops a paused task", async () => {
    const w = openWall({ hash: "#page=live", live: OPS })
    await w.settle()
    w.press(w.el("wall-live").innerHTML, 'data-lv="drop"')
    await w.settle()
    expect(posts(w, "/api/signals/drop")).toHaveLength(0)
    expect(w.el("wall-live").innerHTML).toContain("Drop it for good?")
    w.press(w.el("wall-live").innerHTML, 'data-lv="drop"')
    await w.settle()
    expect(JSON.parse(posts(w, "/api/signals/drop")[0].init.body)).toEqual({ id: "t7" })
  })

  it("shows the same task as Paused, with Resume, on its Task page", async () => {
    const w = openWall({ hash: "#page=task&task=t7&agent=cx&node=http%3A%2F%2Fnode-a&ch=telegram&done=1", live: OPS, history: { ok: true, channel: "telegram", message: "Update the price list" } })
    await w.settle()
    const ops = w.el("wtask-ops").innerHTML
    expect(ops).toContain("❚❚ Paused")
    w.press(ops, 'data-lv="resume"')
    await w.settle()
    expect(posts(w, "/api/signals/resume").map((c) => c.url)).toEqual(["/api/signals/resume?node=http%3A%2F%2Fnode-a"])
  })

  it("offers Pause on a live run's Task page, which stops it with a resume plan", async () => {
    const w = openWall({ hash: "#page=task&task=t9&agent=cx&node=http%3A%2F%2Fnode-a&ch=telegram", live: OPS })
    await w.settle()
    w.press(w.el("wtask-ops").innerHTML, 'data-lv="pause"')
    w.press(w.el("wtask-ops").innerHTML, 'data-lv="pause"')
    await w.settle()
    expect(JSON.parse(posts(w, "/api/signals/stop")[0].init.body)).toEqual({ taskId: "t9" })
  })
})

describe("Wall Live: a run's workflow step, as classic Live had it (#1439)", () => {
  it("names the workflow and the step a run is on", async () => {
    const live = { nodes: [{ ...LIVE.nodes[0], agents: [
      { id: "cx", name: "Customer Desk", runningTasks: [{ id: "t9", channel: "telegram", startedAt: iso(NOW), messagePreview: "Rename the report", workflow: { runId: "run-1", workflowId: "task", step: "Rename the report (2/3)" } }] },
      { id: "ops", name: "Night Shift", runningTasks: [{ id: "t5", channel: "cron", startedAt: iso(NOW), messagePreview: "Digest", workflow: { runId: "run-2", workflowId: "digest", title: "Morning digest", step: "reply" } }] },
    ] }] }
    const w = openWall({ hash: "#page=live", live })
    await w.settle()
    const html = w.el("wall-live").innerHTML
    expect(html).toContain('<div class="wls__k">Workflow step Rename the report (2/3)</div>')
    expect(html).toContain('<div class="wls__k">Workflow Morning digest · step reply</div>')
  })
})

describe("Wall Live: machines (#1439)", () => {
  it("restarts a machine when idle, and shows the restart it waits on with Cancel", async () => {
    const w = openWall({ hash: "#page=live", live: OPS })
    await w.settle()
    const html = w.el("wall-live").innerHTML
    expect(html).toContain("<h3>Machines <small>2</small></h3>")
    w.press(html, 'data-lv="restart"')
    w.press(w.el("wall-live").innerHTML, 'data-lv="restart"')
    await w.settle()
    expect(posts(w, "/api/node/restart").map((c) => c.url)).toEqual(["/api/node/restart?node=http%3A%2F%2Fnode-a"])
    const live = w.streams.find((s) => s.url === "/api/live/stream")!
    const deadline = NOW + 1800e3
    live.on.snapshot({ data: JSON.stringify({ nodes: [{ ...OPS.nodes[0], restart: { state: "pending", deadline: iso(deadline) } }] }) })
    const after = w.el("wall-live").innerHTML
    expect(after).toMatch(/Restart waiting · 2 running · until \d\d:\d\d/)
    expect(after).not.toContain('data-lv="restart"')
    w.press(after, 'data-lv="cancel"')
    await w.settle()
    expect(posts(w, "/api/node/restart/cancel")).toHaveLength(1)
  })

  it("lists the attached Claude Code sessions with their agent and start time", async () => {
    const w = openWall({ hash: "#page=live", live: OPS })
    await w.settle()
    const s = w.el("wall-live").innerHTML.split("Claude Code sessions <small>1</small>")[1].split("</section>")[0]
    expect(s).toContain("<b>Customer Desk</b>")
    expect(s).toContain("<b>demo-site</b>")
    expect(s).toMatch(/started \d\d:\d\d \(60 min ago\)/)
    // No raw session id in what is shown.
    expect(s).not.toContain("abcd1234")
  })

  it("finds CLI sessions on a machine and connects one", async () => {
    const w = openWall({ hash: "#page=live", live: OPS, replies: {
      "/api/monitor/discover?": { sessions: [{ id: "sess-1", label: "/home/demo/demo-site", runtime: "claude" }], processes: [] },
      "/api/monitor/register?": { ok: true },
    } })
    await w.settle()
    w.press(w.el("wall-live").innerHTML, 'data-lv="find"')
    await w.settle()
    expect(w.calls.some((c) => c.url === "/api/monitor/discover?node=http%3A%2F%2Fnode-a")).toBe(true)
    const html = w.el("wall-live").innerHTML
    expect(html).toContain("<b>Claude Code in demo-site</b>")
    w.press(html, 'data-lv="reg"')
    await w.settle()
    const sent = posts(w, "/api/monitor/register")
    expect(sent.map((c) => c.url)).toEqual(["/api/monitor/register?node=http%3A%2F%2Fnode-a"])
    expect(JSON.parse(sent[0].init.body)).toEqual({ id: "sess-1", runtime: "claude", label: "/home/demo/demo-site" })
    expect(w.el("wall-live").innerHTML).toContain("Connected</span>")
  })

  it("says a machine that does not answer is unreachable, without its controls", async () => {
    const w = openWall({ hash: "#page=live", live: OPS })
    await w.settle()
    const b = w.el("wall-live").innerHTML.split('aria-label="Machine node-a"')[1].split("<b>node-b</b>")[1].split("</article>")[0]
    expect(b).toContain("unreachable")
    expect(b).toContain("connect ECONNREFUSED")
    expect(b).not.toContain("data-lv=")
  })
})
