import { describe, expect, it } from "vitest"
import { APP_SERVICE_WORKER, renderAppLockedPage } from "../src/daemon/ui/pages/app"
import { afterUnauthorized, mayBounce } from "../src/daemon/ui/pages/app-pair-logic"

// #234: a paired phone must never be thrown back to "This phone isn't
// paired" because one navigation arrived without its cookie. These tests
// run the real service worker and locked-page scripts against stubbed
// fetch, caches and DOM.

describe("afterUnauthorized", () => {
  it("retries when the probe is accepted, locks only when it is refused too", () => {
    expect(afterUnauthorized(200)).toBe("retry")
    expect(afterUnauthorized(204)).toBe("retry")
    expect(afterUnauthorized(401)).toBe("lock")
    for (const s of [0, 403, 404, 500, 502, 503]) expect(afterUnauthorized(s)).toBe("keep")
  })
})

describe("mayBounce", () => {
  it("allows one bounce per 30 seconds", () => {
    expect(mayBounce(null, 1_000_000)).toBe(true)
    expect(mayBounce(1_000_000, 1_000_000 + 5_000)).toBe(false)
    expect(mayBounce(1_000_000, 1_000_000 + 29_999)).toBe(false)
    expect(mayBounce(1_000_000, 1_000_000 + 30_000)).toBe(true)
    expect(mayBounce(2_000_000, 1_000_000)).toBe(true) // clock went back
  })
})

// --- Service worker ----------------------------------------------------

type Answer = number | "offline"
interface Plan { nav: Answer; probe?: Answer; retry?: Answer }

function makeSw(plan: Plan, saved: Record<string, string> = {}) {
  const store = new Map<string, Response>()
  for (const [k, body] of Object.entries(saved)) store.set(k, new Response(body, { status: k === "/app/locked" ? 401 : 200 }))
  const calls: string[] = []
  const answer = (a: Answer | undefined, body: string) => {
    if (a === undefined) throw new Error(`unexpected request: ${body}`)
    return a === "offline" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(new Response(body, { status: a }))
  }
  const fetchStub = (input: any) => {
    const path = typeof input === "string" ? input : new URL(input.url).pathname
    const kind = typeof input === "string" ? (path === "/api/app/me" ? "probe" : "retry") : "nav"
    calls.push(kind)
    if (kind === "nav") return answer(plan.nav, plan.nav === 401 ? "locked" : "shell")
    if (kind === "probe") return answer(plan.probe, "me")
    return answer(plan.retry, plan.retry === 200 ? "shell-again" : "locked-again")
  }
  const cache = {
    put: async (k: string, r: Response) => { store.set(k, r) },
    delete: async (k: string) => store.delete(k),
    addAll: async () => {},
  }
  const cachesStub = {
    open: async () => cache,
    match: async (k: string) => store.get(k)?.clone(),
    keys: async () => [],
    delete: async () => true,
  }
  const listeners: Record<string, (e: any) => void> = {}
  const self = {
    addEventListener: (t: string, f: any) => { listeners[t] = f },
    location: new URL("https://phone.example/app/sw.js"),
    registration: {}, clients: {}, skipWaiting: () => Promise.resolve(),
  }
  new Function("self", "caches", "fetch", "Response", "URL", APP_SERVICE_WORKER)(self, cachesStub, fetchStub, Response, URL)

  async function open(): Promise<{ status: number; body: string }> {
    let responded: Promise<Response> | null = null
    const waits: Promise<unknown>[] = []
    listeners.fetch({
      request: { url: "https://phone.example/app", method: "GET", mode: "navigate" },
      respondWith: (p: Promise<Response>) => { responded = p },
      waitUntil: (p: Promise<unknown>) => { waits.push(p) },
    })
    const res = await responded!
    await Promise.all(waits)
    return { status: res.status, body: await res.text() }
  }
  const cached = async () => Object.fromEntries(await Promise.all([...store].map(async ([k, r]) => [k, await r.clone().text()])))
  return { open, calls, cached }
}

describe("service worker: opening /app", () => {
  it("saves the shell when the server lets the phone in", async () => {
    const sw = makeSw({ nav: 200 }, { "/app/locked": "old-locked" })
    expect(await sw.open()).toEqual({ status: 200, body: "shell" })
    expect(await sw.cached()).toEqual({ "/app": "shell" })
  })

  it("on a 401 whose probe succeeds, retries once and keeps the app", async () => {
    const sw = makeSw({ nav: 401, probe: 200, retry: 200 }, { "/app": "old-shell" })
    expect(await sw.open()).toEqual({ status: 200, body: "shell-again" })
    expect(sw.calls).toEqual(["nav", "probe", "retry"])
    expect(await sw.cached()).toEqual({ "/app": "shell-again" })
  })

  it("serves the saved shell when the retry is refused but the probe succeeded", async () => {
    const sw = makeSw({ nav: 401, probe: 200, retry: 401 }, { "/app": "old-shell" })
    expect(await sw.open()).toEqual({ status: 200, body: "old-shell" })
    expect(await sw.cached()).toEqual({ "/app": "old-shell" })
  })

  it("serves the saved shell when the retry fails to connect", async () => {
    const sw = makeSw({ nav: 401, probe: 200, retry: "offline" }, { "/app": "old-shell" })
    expect(await sw.open()).toEqual({ status: 200, body: "old-shell" })
  })

  it("drops the shell only when the probe is refused too", async () => {
    const sw = makeSw({ nav: 401, probe: 401 }, { "/app": "old-shell" })
    expect(await sw.open()).toEqual({ status: 401, body: "locked" })
    expect(sw.calls).toEqual(["nav", "probe"])
    expect(await sw.cached()).toEqual({ "/app/locked": "locked" })
  })

  it("changes no cache when the probe gets no answer", async () => {
    for (const probe of ["offline", 502] as const) {
      const sw = makeSw({ nav: 401, probe }, { "/app": "old-shell" })
      expect(await sw.open()).toEqual({ status: 401, body: "locked" })
      expect(await sw.cached()).toEqual({ "/app": "old-shell" })
    }
  })

  it("still opens the saved app offline", async () => {
    const sw = makeSw({ nav: "offline" }, { "/app": "old-shell", "/app/locked": "old-locked" })
    expect(await sw.open()).toEqual({ status: 200, body: "old-shell" })
  })
})

// --- Locked page -------------------------------------------------------

function runLockedPage(me: Answer, lastBounce: number | null = null) {
  const scripts = [...renderAppLockedPage().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).slice(1)
  const el = () => ({ addEventListener() {}, focus() {}, select() {}, hidden: false, disabled: false, textContent: "", className: "", value: "" })
  const els: Record<string, any> = {}
  const session = new Map<string, string>(lastBounce ? [["ax-heal", String(lastBounce)]] : [])
  const replaced: string[] = []
  const probes: string[] = []
  const g = {
    document: { getElementById: (id: string) => (els[id] ??= el()), addEventListener() {}, hidden: false },
    window: { addEventListener() {} },
    navigator: { onLine: true },
    location: { replace: (u: string) => { replaced.push(u) } },
    sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v) } },
    fetch: (url: string) => {
      probes.push(url)
      return me === "offline" ? Promise.reject(new TypeError("offline")) : Promise.resolve(new Response("{}", { status: me }))
    },
  }
  new Function(...Object.keys(g), scripts.join(";\n"))(...Object.values(g))
  return { replaced, probes, session, msg: () => els["pair-msg"]?.textContent }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

describe("locked page self-heal", () => {
  it("goes straight back to /app when /api/app/me knows the phone", async () => {
    const page = runLockedPage(200)
    await settle()
    expect(page.probes).toEqual(["/api/app/me"])
    expect(page.replaced).toEqual(["/app"])
    expect(page.msg()).toContain("paired")
  })

  it("stays and shows the form when the phone is really unpaired", async () => {
    for (const me of [401, "offline"] as const) {
      const page = runLockedPage(me)
      await settle()
      expect(page.replaced).toEqual([])
    }
  })

  it("does not bounce twice within 30 seconds, so it can't loop", async () => {
    const page = runLockedPage(200, Date.now() - 5_000)
    await settle()
    expect(page.probes).toEqual([])
    expect(page.replaced).toEqual([])
  })
})
