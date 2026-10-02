import { describe, expect, it } from "vitest"
import { renderMemberPage } from "../src/daemon/ui/pages/member"
import { connectionNote, plainPreview } from "../src/daemon/ui/pages/member-logic"

// #489: the work page said "Offline" for any failed load and never asked
// for the name line a second time. These tests run the page's real script
// against a stubbed DOM, fetch and clock.

type Answer = "fail" | "hang" | number | { status: number; body: unknown }

const ME = { name: "Sara B", device: "Laptop", node: "node-a" }
const WORK = { open: [], recent: [], runs: [] as unknown[] }

function openPage(answers: { me?: Answer[]; work?: Answer[] }, opts: { online?: boolean } = {}) {
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
  new Function("document", "window", "navigator", "fetch", "location", "localStorage", "matchMedia", "setTimeout", "clearTimeout", "AbortController", script)(
    { getElementById: el, documentElement: { getAttribute: () => "light", setAttribute: () => {} } },
    { addEventListener: (t: string, f: () => void) => { windowListeners[t] = f } },
    navigatorStub, fetchStub, { replace: (to: string) => { left.push(to) } },
    { setItem: () => {} }, () => ({ matches: false }), setTimeoutStub, clearTimeoutStub, AbortController,
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
  return { el, calls, left, settle, fire, network, pending: () => timers.map((t) => t.ms) }
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
    expect(connectionNote(false, false, 20, false)?.text).toMatch(/^Offline/)
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
    expect(p.el("runs").innerHTML).toContain('<p class="text">Deploy &lt;b&gt;now&lt;/b&gt;</p>')
  })
})
