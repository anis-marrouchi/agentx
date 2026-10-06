import { describe, expect, it } from "vitest"
import { renderMemberPage } from "../src/daemon/ui/pages/member"
import { connectionNote, freedAgents, plainPreview } from "../src/daemon/ui/pages/member-logic"

// #489: the work page said "Offline" for any failed load and never asked
// for the name line a second time. These tests run the page's real script
// against a stubbed DOM, fetch and clock.

type Answer = "fail" | "hang" | number | { status: number; body: unknown }

const ME = { name: "Sara B", device: "Laptop", node: "node-a" }
const WORK = { open: [], recent: [], runs: [] as unknown[] }

function openPage(answers: { me?: Answer[]; work?: Answer[] }, opts: { online?: boolean; Notification?: unknown } = {}) {
  const page = renderMemberPage()
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop()!
  const els = new Map<string, any>()
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*id="${id}"[^>]*>([^<]*)`).exec(page)
      if (!tag) throw new Error(`no element #${id} on the page`)
      const listeners: Record<string, () => void> = {}
      els.set(id, {
        hidden: /\shidden[\s>]/.test(tag[0]), textContent: tag[1], innerHTML: "", disabled: false,
        addEventListener: (t: string, f: () => void) => { listeners[t] = f },
        click: () => listeners.click(),
      })
    }
    return els.get(id)
  }
  const timers: Array<{ id: number; fn: () => void; ms: number }> = []
  let seq = 0
  const setTimeoutStub = (fn: () => void, ms: number) => { timers.push({ id: ++seq, fn, ms }); return seq }
  const clearTimeoutStub = (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) }
  const calls = { me: 0, work: 0 }
  const queue = { me: [...(answers.me ?? [])], work: [...(answers.work ?? [])] }
  const fetchStub = (url: string, init: { signal: AbortSignal }) => {
    const kind = url === "/api/member/me" ? "me" : "work"
    calls[kind]++
    // Past the listed answers, the server is well.
    const a: Answer = queue[kind].shift() ?? 200
    if (a === "fail") return Promise.reject(new TypeError("Failed to fetch"))
    if (a === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
    const status = typeof a === "number" ? a : a.status
    const body = typeof a === "number" ? (kind === "me" ? ME : WORK) : a.body
    return Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body })
  }
  const windowListeners: Record<string, () => void> = {}
  const navigatorStub = { onLine: opts.online ?? true, userAgent: "Macintosh" }
  const left: string[] = []
  const doc = { getElementById: el, documentElement: { getAttribute: () => "light", setAttribute: () => {} }, activeElement: null as unknown }
  new Function("document", "window", "navigator", "fetch", "location", "localStorage", "matchMedia", "setTimeout", "clearTimeout", "AbortController", "Notification", script)(
    doc,
    { addEventListener: (t: string, f: () => void) => { windowListeners[t] = f } },
    navigatorStub, fetchStub, { replace: (to: string) => { left.push(to) } },
    { setItem: () => {} }, () => ({ matches: false }), setTimeoutStub, clearTimeoutStub, AbortController, opts.Notification,
  )
  const settle = () => new Promise<void>((r) => setImmediate(r))
  /** Run the one pending timer of this length; throws when there is none. */
  const fire = async (ms: number) => {
    const i = timers.findIndex((t) => t.ms === ms)
    if (i < 0) throw new Error(`no ${ms} ms timer; pending: ${timers.map((t) => t.ms).join(", ") || "none"}`)
    timers.splice(i, 1)[0].fn()
    await settle()
  }
  const network = async (on: boolean) => { navigatorStub.onLine = on; windowListeners[on ? "online" : "offline"](); await settle() }
  return { el, doc, calls, left, settle, fire, network, pending: () => timers.map((t) => t.ms) }
}

describe("the name line", () => {
  it("is asked for again on the next round until it loads, then no more", async () => {
    const p = openPage({ me: ["fail", 500] })
    await p.settle()
    expect(p.el("who").textContent).toBe("Connecting…")
    await p.fire(30_000)
    expect(p.el("who").textContent).toBe("Connecting…")
    await p.fire(30_000)
    expect(p.el("who").textContent).toBe("Sara B · Laptop · node-a")
    await p.fire(30_000)
    expect(p.calls).toEqual({ me: 3, work: 4 })
  })
})

describe("the connection strip", () => {
  it("stays hidden while loads work, and the next round is in 30 seconds", async () => {
    const p = openPage({})
    await p.settle()
    expect(p.el("offline").hidden).toBe(true)
    expect(p.pending()).toEqual([30_000])
  })

  it("says the server cannot be reached, not offline, when a load fails with the network up", async () => {
    for (const first of ["fail", 500, { status: 200, body: { error: "not the work lists" } }] as Answer[]) {
      const p = openPage({ work: [first] })
      await p.settle()
      expect(p.el("offline").hidden).toBe(false)
      expect(p.el("offline-text").textContent).toBe("Can't reach the server. Trying again every 20 seconds.")
      expect(p.el("retry").hidden).toBe(false)
      expect(p.pending()).toEqual([20_000])
      await p.fire(20_000)
      expect(p.el("offline").hidden).toBe(true)
      expect(p.pending()).toEqual([30_000])
    }
  })

  it("Try now loads at once and replaces the waiting round", async () => {
    const p = openPage({ work: ["fail", "fail"] })
    await p.settle()
    p.el("retry").click()
    expect(p.el("retry").disabled).toBe(true)
    await p.settle()
    expect(p.calls.work).toBe(2)
    expect(p.el("retry").disabled).toBe(false)
    expect(p.el("offline").hidden).toBe(false)
    expect(p.pending()).toEqual([20_000])
    p.el("retry").click()
    await p.settle()
    expect(p.el("offline").hidden).toBe(true)
    expect(p.pending()).toEqual([30_000])
  })

  it("says it shows what was last loaded only once something has loaded", async () => {
    const p = openPage({ work: [200, 503] })
    await p.settle()
    await p.fire(30_000)
    expect(p.el("offline-text").textContent).toBe("Can't reach the server. Showing what was last loaded. Trying again every 20 seconds.")
  })

  it("says offline only when the browser is, and loads when the network is back", async () => {
    const p = openPage({ work: ["fail"] }, { online: false })
    await p.settle()
    expect(p.el("offline").hidden).toBe(false)
    expect(p.el("offline-text").textContent).toMatch(/^Offline\. /)
    expect(p.el("retry").hidden).toBe(true)
    await p.network(true)
    expect(p.el("offline").hidden).toBe(true)
    expect(p.calls.work).toBe(2)
    await p.network(false)
    expect(p.el("offline-text").textContent).toMatch(/^Offline\. /)
  })

  // #496: a browser can report no network while the server is reachable.
  it("hides after a load that worked, even when the browser reports no network", async () => {
    const p = openPage({ work: [200, "fail"] }, { online: false })
    expect(p.el("offline").hidden).toBe(false)
    await p.settle()
    expect(p.el("offline").hidden).toBe(true)
    expect(p.pending()).toEqual([30_000])
    await p.fire(30_000)
    expect(p.el("offline").hidden).toBe(false)
    expect(p.el("offline-text").textContent).toMatch(/^Offline\. /)
    await p.fire(20_000)
    expect(p.el("offline").hidden).toBe(true)
  })

  it("counts a server that does not answer in 15 seconds as failed and keeps trying", async () => {
    const p = openPage({ me: ["hang"], work: ["hang"] })
    await p.settle()
    expect(p.el("offline").hidden).toBe(true)
    expect(p.pending()).toEqual([15_000, 15_000])
    await p.fire(15_000)
    await p.fire(15_000)
    expect(p.el("offline-text").textContent).toMatch(/^Can't reach the server\. /)
    await p.fire(20_000)
    expect(p.el("offline").hidden).toBe(true)
    expect(p.el("who").textContent).toBe("Sara B · Laptop · node-a")
  })

  it("goes back to /member when the machine's key ended", async () => {
    for (const status of [401, 403]) {
      const p = openPage({ work: [status] })
      await p.settle()
      expect(p.left).toEqual(["/member"])
      expect(p.el("offline").hidden).toBe(true)
    }
  })
})

describe("connectionNote", () => {
  it("offers Try now only when the server is the one not answering", () => {
    expect(connectionNote(false, true, 20, true)).toBeNull()
    expect(connectionNote(true, true, 20, true)).toMatchObject({ retry: true })
    expect(connectionNote(true, false, 20, true)).toMatchObject({ retry: false })
    expect(connectionNote(true, false, 20, false)?.text).toMatch(/^Offline/)
    expect(connectionNote(false, false, 20, true)).toBeNull()
  })
})

describe("previews of the latest turns", () => {
  it("are plain sentences", () => {
    expect(plainPreview("## Problem Description\nThe **member page** tells a `teammate` the *wrong* thing.")).toBe("Problem Description The member page tells a teammate the wrong thing.")
    expect(plainPreview("- [ ] first\n- [x] second\n1. third\n> quoted")).toBe("first second third quoted")
    expect(plainPreview("See [the issue](https://example.com/i/1) and ![shot](a.png)")).toBe("See the issue and shot")
    expect(plainPreview("```ts\nconst a = 1\n```")).toBe("const a = 1")
    expect(plainPreview("~~old~~ new")).toBe("old new")
  })

  it("survive a mark cut in half by the 200-character limit", () => {
    expect(plainPreview("Fix the **login pa")).toBe("Fix the login pa")
    expect(plainPreview("Run `pnpm te")).toBe("Run pnpm te")
  })

  it("leave names and arithmetic alone", () => {
    expect(plainPreview("call __init__ in my_module, then 2 * 3 * 4")).toBe("call __init__ in my_module, then 2 * 3 * 4")
    expect(plainPreview("#489 is open")).toBe("#489 is open")
    expect(plainPreview(null)).toBe("")
  })

  it("are used by the page, and escaped after the marks are removed", async () => {
    const runs = [{ taskId: "t1", agentId: "coder", channel: "telegram", chatId: "c1", status: "ok", startedAt: Date.now(), messagePreview: "**Deploy** <b>now</b>" }]
    const p = openPage({ work: [{ status: 200, body: { open: [], recent: [], runs } }] })
    await p.settle()
    expect(p.el("sent").innerHTML).toContain('<p class="text">Deploy &lt;b&gt;now&lt;/b&gt;</p>')
  })
})

describe("the agent cards and what needs a person (#443)", () => {
  const now = Date.now()
  const body = {
    open: [{ id: "r1", state: "waiting_owner", agentId: "billing", text: "Put our **logo** on it", question: "Blue or black?", createdAt: now, updatedAt: now, where: { label: "WhatsApp", url: null } }],
    recent: [],
    runs: [{ taskId: "t1", agentId: "coder", channel: "telegram", chatId: "c1", status: "in-flight", startedAt: now, finishedAt: null, messagePreview: "Fix the banner", where: { label: "Telegram", url: null }, request: null }],
    agents: [
      { agentId: "coder", state: "working", by: "you", at: now, text: "Fix the banner", fullText: "Fix the banner on staging", where: { label: "Telegram", url: null } },
      { agentId: "ops", state: "working", by: "owner", at: now, text: null, fullText: null, where: null },
    ],
  }

  it("open the member's own task only, and put the owner's question first", async () => {
    const p = openPage({ work: [{ status: 200, body }] })
    await p.settle()
    const cards = p.el("agents").innerHTML
    expect(p.el("agents-box").hidden).toBe(false)
    expect(cards.match(/class="more"/g)).toHaveLength(1)
    expect(cards).toContain("Fix the banner on staging")
    expect(cards).toContain("Busy with someone else&#39;s task")
    expect(p.el("sum").textContent).toBe("coder is working on your task. ops is busy with someone else's task.")
    expect(p.el("need").hidden).toBe(false)
    expect(p.el("need-list").innerHTML).toContain('<p class="q">Blue or black?</p>')
    expect(p.el("need-list").innerHTML).toContain("For <b>Put our logo on it</b>")
    expect(p.el("sent").innerHTML).toContain(">Running<")
  })

  // The owner's decisions on #443 (2026-10-05): a busy card says what the
  // task is, and the line behind it; a waiting message of the person's
  // shows as "In line" in What you sent.
  it("say what someone else's task is, and what waits in line", async () => {
    const line = {
      ...body,
      agents: [
        { ...body.agents[0], queue: { waiting: 2, yours: 1, ahead: 1 } },
        { ...body.agents[1], text: "Rotate the **staging** keys", queue: { waiting: 1, yours: 0, ahead: null } },
      ],
      queued: [{ agentId: "coder", channel: "telegram", chatId: "c1", queuedAt: now - 60_000, messagePreview: "Then run the *tests*", where: { label: "Telegram", url: null }, ahead: 1 }],
    }
    const p = openPage({ work: [{ status: 200, body: line }] })
    await p.settle()
    const cards = p.el("agents").innerHTML
    expect(cards).toContain('<p class="what">Rotate the staging keys</p>')
    expect(cards).not.toContain("Busy with someone else")
    expect(cards).toContain("Your message is in line, 1 message ahead of it.")
    expect(cards).toContain("1 message waits in line. A new one from you waits behind it.")
    expect(cards).toContain("<dt>In line</dt><dd>2 messages wait behind this, 1 of them yours.</dd>")
    const sent = p.el("sent").innerHTML
    expect(sent.indexOf("Then run the tests")).toBeLessThan(sent.indexOf("Fix the banner"))
    expect(sent).toContain(">In line<")
    expect(sent).toContain("1 message ahead of it")
    expect(p.el("sum").textContent).toBe("coder is working on your task. ops is busy with someone else's task.")
  })

  // A keyboard or screen-reader user must not lose their place, or hear
  // the summary again, every 30 seconds.
  it("leave the lists and the summary alone when a round brings nothing new", async () => {
    const p = openPage({ work: [{ status: 200, body }, { status: 200, body }] })
    await p.settle()
    const writes: string[] = []
    for (const id of ["sum", "agents", "need-list", "sent"]) {
      const e = p.el(id)
      let html = e.innerHTML, text = e.textContent
      Object.defineProperty(e, "innerHTML", { get: () => html, set: (v: string) => { writes.push(id); html = v } })
      Object.defineProperty(e, "textContent", { get: () => text, set: (v: string) => { writes.push(id); text = v } })
    }
    await p.fire(30_000)
    expect(writes).toEqual([])
  })

  it("keep focus on the same agent's button when the cards change", async () => {
    const later = { ...body, agents: [{ agentId: "qa", state: "free", by: null, at: now, text: null, fullText: null, where: null }, ...body.agents] }
    const p = openPage({ work: [{ status: 200, body }, { status: 200, body: later }] })
    await p.settle()
    const list = p.el("agents")
    let focused: unknown = null
    // The buttons in the list's current markup, as the browser would give
    // them: the same objects until the markup is replaced.
    const made = new Map<string, unknown[]>()
    const buttons = () => {
      const html = String(list.innerHTML)
      if (!made.has(html)) {
        made.set(html, [...html.matchAll(/<button[^>]*data-agent="([^"]*)"/g)].map((m) => {
          const b = { inList: true, getAttribute: (n: string) => (n === "data-agent" ? m[1] : null), focus: () => { focused = b } }
          return b
        }))
      }
      return made.get(html)!
    }
    list.contains = (x: { inList?: boolean }) => !!x?.inList
    list.querySelectorAll = buttons
    p.doc.activeElement = buttons()[0]
    await p.fire(30_000)
    expect(list.innerHTML).toContain(">qa<")
    expect((focused as { getAttribute: (n: string) => string } | null)?.getAttribute("data-agent")).toBe("coder")
  })

  it("say the state is from the last load when a round fails", async () => {
    const p = openPage({ work: [{ status: 200, body }, "fail"] })
    await p.settle()
    await p.fire(30_000)
    expect(p.el("agents").innerHTML).toMatch(/Working when this page last loaded, at /)
    expect(p.el("agents").innerHTML).not.toContain(" live")
  })
})

describe("Saber's answers on #443: order and a notification when an agent is free", () => {
  it("puts Needs a person above the agent cards", () => {
    const page = renderMemberPage()
    expect(page.indexOf('id="need"')).toBeGreaterThan(page.indexOf('id="sum"'))
    expect(page.indexOf('id="need"')).toBeLessThan(page.indexOf('id="agents-box"'))
    expect(page.indexOf('id="agents-box"')).toBeLessThan(page.indexOf('id="sent"'))
  })

  it("finds the agents that went from Working to Free, and nothing on the first load", () => {
    const working = [{ agentId: "coder", state: "working" }, { agentId: "ops", state: "blocked" }, { agentId: "qa", state: "working" }]
    const after = [{ agentId: "coder", state: "free" }, { agentId: "ops", state: "free" }, { agentId: "qa", state: "working" }, { agentId: "new", state: "free" }]
    expect(freedAgents(working, after)).toEqual(["coder"])
    expect(freedAgents(null, after)).toEqual([])
  })

  function notificationStub(permission: string) {
    const shown: Array<{ title: string; body: string }> = []
    function N(this: unknown, title: string, o: { body: string }) { shown.push({ title, body: o.body }) }
    const stub = Object.assign(N, { permission, requestPermission: () => Promise.resolve((stub.permission = "granted")) })
    return { stub, shown }
  }
  const agents = (state: string) => ({ status: 200, body: { open: [], recent: [], runs: [], agents: [
    { agentId: "coder", state, by: "owner", at: Date.now(), text: null, fullText: null, where: null },
  ] } })

  it("notifies once when an agent becomes Free, with no word of the task", async () => {
    const { stub, shown } = notificationStub("granted")
    const p = openPage({ work: [agents("working"), agents("free"), agents("free")] }, { Notification: stub })
    await p.settle()
    expect(shown).toEqual([])
    await p.fire(30_000)
    expect(shown).toEqual([{ title: "coder is free", body: "Ready for your next message." }])
    await p.fire(30_000)
    expect(shown).toHaveLength(1)
  })

  it("offers the button only while the browser has not been asked, and hides it once allowed", async () => {
    const { stub, shown } = notificationStub("default")
    const p = openPage({ work: [agents("working"), agents("free")] }, { Notification: stub })
    await p.settle()
    expect(p.el("notify").hidden).toBe(false)
    p.el("notify").click()
    await p.settle()
    expect(p.el("notify").hidden).toBe(true)
    await p.fire(30_000)
    expect(shown).toHaveLength(1)
    for (const permission of ["denied", "granted"]) {
      const q = openPage({}, { Notification: notificationStub(permission).stub })
      expect(q.el("notify").hidden).toBe(true)
    }
    expect(openPage({}).el("notify").hidden).toBe(true)
  })
})
