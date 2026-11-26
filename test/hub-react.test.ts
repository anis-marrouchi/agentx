// The React Hub's foundation (#2218 PR 0): the hash router, the extension
// registry, the one live connection, and the daemon's switch and tags.
import { describe, expect, it, vi } from "vitest"
import { buildHash, hashPage, parseHash, reactPageFor } from "../src/hub/router"
import { HubRegistry } from "../src/hub/registry"
import { HUB_REACT_PAGES, hubReactPageIds } from "../src/hub/pages"
import { LIVE_KEY, LIVE_LINGER_MS, LIVE_RETRY_MS, LiveStream, type SourceLike } from "../src/hub/live"
import { readBoot } from "../src/hub/boot"
import { hubReactHead, hubReactOn, type HubManifest } from "../src/daemon/ui/hub-react"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { dashboardConfigSchema } from "../src/boards/config"

describe("hash router: the Hub's addresses stay what they are", () => {
  it("reads the page and the other keys of today's hashes", () => {
    expect(hashPage(parseHash("#page=jobledger"))).toBe("jobledger")
    expect(hashPage(parseHash("#status=open&view=decide"))).toBe("wall")
    expect(hashPage(parseHash(""))).toBe("wall")
    const q = parseHash("#page=workflows&w-open=wf_1")
    expect(q.get("w-open")).toBe("wf_1")
  })
  it("writes a hash in the same grammar, empty values dropped", () => {
    expect(buildHash({ page: "catalog", tab: "", x: null })).toBe("#page=catalog")
    expect(buildHash({})).toBe("")
    expect(buildHash(parseHash("#status=open&view=decide"))).toBe("#status=open&view=decide")
  })
  it("gives React only the pages it owns", () => {
    expect(reactPageFor(parseHash("#page=catalog"), ["catalog"])).toBe("catalog")
    expect(reactPageFor(parseHash("#page=catalog"), [])).toBeNull()
    expect(reactPageFor(parseHash("#page=jobledger"), ["catalog"])).toBeNull()
    expect(reactPageFor(parseHash(""), ["catalog"])).toBeNull()
  })
})

describe("extension registry", () => {
  const page = () => Promise.resolve({ default: () => null })
  it("takes routes listed in pages.ts and finds them", () => {
    const r = new HubRegistry()
    r.define({ id: "a", routes: [{ page: "catalog", title: "Components", load: page }] })
    expect(r.route("catalog")?.title).toBe("Components")
    expect(r.pageComponent("catalog")).toBe(r.pageComponent("catalog"))
    expect(r.pageComponent("nope")).toBeUndefined()
  })
  it("refuses a page pages.ts does not list, a taken page and a second id", () => {
    const r = new HubRegistry()
    expect(() => r.define({ id: "a", routes: [{ page: "not-listed", title: "X", load: page }] })).toThrow(/pages\.ts/)
    r.define({ id: "a", routes: [{ page: "catalog", title: "X", load: page }] })
    expect(() => r.define({ id: "b", routes: [{ page: "catalog", title: "Y", load: page }] })).toThrow(/already taken/)
    expect(() => r.define({ id: "a" })).toThrow(/twice/)
  })
  it("orders nav and hides owner-only and phone-hidden items", () => {
    const r = new HubRegistry()
    r.define({ id: "a", nav: [
      { id: "jobs", group: "foot", label: "Jobs", icon: "clock", page: "jobledger", order: 2 },
      { id: "settings", group: "foot", label: "Settings", icon: "gear", page: "settings", ownerOnly: true, order: 3 },
      { id: "desk", group: "places", label: "Desk", icon: "inbox", page: "wall", order: 1, hiddenOnPhone: true },
    ] })
    expect(r.nav({ owner: true }).map((i) => i.id)).toEqual(["desk", "jobs", "settings"])
    expect(r.nav({ owner: false }).map((i) => i.id)).toEqual(["desk", "jobs"])
    expect(r.nav({ owner: true, phone: true }).map((i) => i.id)).toEqual(["jobs", "settings"])
  })
  it("keeps one renderer per Desk card kind and picks panel tabs by page", () => {
    const r = new HubRegistry()
    r.define({ id: "a", deskCards: [{ kind: "approval", load: page as any }], panelTabs: [{ kind: "files", label: "Files", opensFor: ["task"], load: page as any }] })
    expect(r.deskCard("approval")).toBeTruthy()
    expect(r.deskCard("unknown")).toBeUndefined()
    expect(() => r.define({ id: "b", deskCards: [{ kind: "approval", load: page as any }] })).toThrow(/already taken/)
    expect(r.panelTabs("task").map((t) => t.kind)).toEqual(["files"])
    expect(r.panelTabs("chat")).toEqual([])
  })
  it("the built-in extension's routes are all in pages.ts", async () => {
    const { hubRegistry } = await import("../src/hub/registry")
    await import("../src/hub/extensions/core")
    const listed = HUB_REACT_PAGES.map((p) => p.page)
    for (const r of hubRegistry.routes()) expect(listed).toContain(r.page)
  })
})

describe("React page ids per viewer", () => {
  it("keeps owner-only pages for the owner and drops legacy pages", () => {
    expect(hubReactPageIds(true)).toContain("catalog")
    expect(hubReactPageIds(false)).not.toContain("catalog")
    expect(hubReactPageIds(true, ["catalog"])).not.toContain("catalog")
  })
  it("reads the boot config defensively", () => {
    expect(readBoot({} as any)).toMatchObject({ pages: [], owner: false, layout: { layout: "simple" } })
    expect(readBoot({ AX_HUB: { pages: ["catalog", 3 as any], owner: true } } as any)).toMatchObject({ pages: ["catalog"], owner: true })
    // The layout (#2226 S1): the same keys the old Hub reads; a bad one is simple.
    expect(readBoot({ AX_HUB: { layout: { layout: "full", show: { workflows: false } } } } as any).layout.show).toMatchObject({ workflows: false, org: true })
    expect(readBoot({ AX_HUB: { layout: { layout: "nope" } } } as any).layout.layout).toBe("simple")
  })
})

class FakeSource implements SourceLike {
  static made: FakeSource[] = []
  closed = false
  private fns = new Map<string, ((ev: any) => void)[]>()
  constructor(readonly url: string) { FakeSource.made.push(this) }
  addEventListener(type: string, fn: (ev: any) => void) { this.fns.set(type, [...(this.fns.get(type) ?? []), fn]) }
  close() { this.closed = true }
  emit(type: string, ev: any) { for (const fn of this.fns.get(type) ?? []) fn(ev) }
}

function liveHarness() {
  FakeSource.made = []
  const timers: { fn: () => void; ms: number; done: boolean }[] = []
  const client = { setQueryData: vi.fn() }
  const stream = new LiveStream({
    client: client as any,
    open: (u) => new FakeSource(u),
    setTimer: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t },
    clearTimer: (t: any) => { if (t) t.done = true },
    now: () => 1000,
  })
  const fire = (ms: number) => {
    const t = timers.find((x) => !x.done && x.ms === ms)
    if (!t) throw new Error("no timer of " + ms)
    t.done = true
    t.fn()
  }
  return { stream, client, timers, fire }
}

describe("one live connection (C3)", () => {
  it("opens one stream however many parts read it, and writes snapshots into the cache", () => {
    const { stream, client } = liveHarness()
    const a = stream.acquire()
    const b = stream.acquire()
    expect(FakeSource.made).toHaveLength(1)
    expect(FakeSource.made[0].url).toBe("/api/live/stream")
    FakeSource.made[0].emit("snapshot", { data: JSON.stringify({ ts: "t", nodes: [] }) })
    expect(client.setQueryData).toHaveBeenCalledWith(LIVE_KEY, { ts: "t", nodes: [] })
    expect(stream.getStatus()).toMatchObject({ state: "open", snapshots: 1, lastAt: 1000 })
    a(); b()
  })
  it("ignores the server's own error event, which carries data", () => {
    const { stream } = liveHarness()
    stream.acquire()
    FakeSource.made[0].emit("error", { data: "one snapshot failed" })
    expect(FakeSource.made[0].closed).toBe(false)
    expect(stream.getStatus().state).toBe("connecting")
  })
  it("after a drop, shows reconnecting and reopens after 2 s, 5 s, 10 s, then 30 s", () => {
    const { stream, fire } = liveHarness()
    const onChange = vi.fn()
    stream.subscribe(onChange)
    stream.acquire()
    FakeSource.made[0].emit("snapshot", { data: "{}" })
    for (let i = 0; i < 5; i++) {
      const src = FakeSource.made[FakeSource.made.length - 1]
      src.emit("error", {})
      expect(src.closed).toBe(true)
      expect(stream.getStatus().state).toBe("reconnecting")
      fire(LIVE_RETRY_MS[Math.min(i, LIVE_RETRY_MS.length - 1)])
      expect(FakeSource.made).toHaveLength(i + 2)
    }
    // The daemon is back: the next snapshot opens it again and counts one return.
    FakeSource.made[FakeSource.made.length - 1].emit("snapshot", { data: "{}" })
    expect(stream.getStatus()).toMatchObject({ state: "open", reconnects: 1, snapshots: 2 })
    expect(onChange).toHaveBeenCalled()
    // The waits start over after a good snapshot.
    FakeSource.made[FakeSource.made.length - 1].emit("error", {})
    fire(LIVE_RETRY_MS[0])
  })
  it("closes a while after the last reader leaves, and stays open if one comes back", () => {
    const { stream, fire, timers } = liveHarness()
    const a = stream.acquire()
    a()
    expect(FakeSource.made[0].closed).toBe(false)
    const b = stream.acquire()
    expect(timers.filter((t) => t.ms === LIVE_LINGER_MS && !t.done)).toHaveLength(0)
    b()
    fire(LIVE_LINGER_MS)
    expect(FakeSource.made[0].closed).toBe(true)
    expect(stream.getStatus().state).toBe("idle")
    expect(FakeSource.made).toHaveLength(1)
  })
})

describe("the daemon's switch and tags", () => {
  const manifest: HubManifest = {
    "main.tsx": { file: "hub-abc.js", isEntry: true, css: ["hub-abc.css"], imports: ["vendor.tsx"] },
    "vendor.tsx": { file: "vendor-def.js", css: ["vendor-def.css"] },
    "pages/CatalogPage.tsx": { file: "CatalogPage-x.js" },
  }
  it("is off by default; ?react=1 and ?legacy=1 change one load", () => {
    expect(dashboardConfigSchema.parse({}).hub).toEqual({ react: false, legacyPages: [], layout: "simple", show: {} })
    expect(hubReactOn(undefined, new URLSearchParams())).toBe(false)
    expect(hubReactOn({ react: true }, new URLSearchParams())).toBe(true)
    expect(hubReactOn({ react: false }, new URLSearchParams("react=1"))).toBe(true)
    expect(hubReactOn({ react: true }, new URLSearchParams("legacy=1"))).toBe(false)
  })
  it("writes the entry, its CSS, its static imports and the boot config", () => {
    const html = hubReactHead({ owner: true }, manifest)
    expect(html).toContain(`<script type="module" src="/assets/hub/hub-abc.js"></script>`)
    expect(html).toContain(`<link rel="stylesheet" href="/assets/hub/hub-abc.css">`)
    expect(html).toContain(`<link rel="stylesheet" href="/assets/hub/vendor-def.css">`)
    expect(html).toContain(`<link rel="modulepreload" href="/assets/hub/vendor-def.js">`)
    expect(html).not.toContain("CatalogPage")
    expect(html).toContain(`window.AX_HUB = {"pages":["catalog"],"owner":true}`)
    expect(hubReactHead({ owner: false }, manifest)).toContain(`{"pages":[],"owner":false}`)
    expect(hubReactHead({ owner: true, legacyPages: ["catalog"] }, manifest)).toContain(`{"pages":[],"owner":true}`)
  })
  it("adds nothing when the app is not built", () => {
    expect(hubReactHead({ owner: true }, null)).toBe("")
    expect(hubReactHead({ owner: true }, {})).toBe("")
  })
  it("the old Hub page is unchanged with the switch off", () => {
    const off = renderWallPage({ owner: true })
    expect(off).not.toContain("ax-hub-root")
    expect(off).not.toContain("AX_HUB =")
    expect(renderWallPage({ owner: true, hub: { react: false } })).toBe(off)
  })
})
