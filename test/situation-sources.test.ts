import { afterEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { SituationStore } from "../src/situations/store"
import { situationKey } from "../src/situations/key"
import { DEFAULT_SITUATIONS_CONFIG, situationsConfigSchema, type SituationsConfig } from "../src/situations/config"
import { SignalSources } from "../src/situations/sources/registry"
import { UNKNOWN, isUnknown, unknownSignal, type Signal, type SignalSource } from "../src/situations/sources/types"
import { onSignal, publishSignal, setSignalInterest, wantsSignal } from "../src/situations/sources/hub"
import { applySignal } from "../src/situations/sources/apply"
import { getEventBus } from "../src/events/bus"

// #1892 phase 3: signal sources behind one interface. A source that is down
// or missing answers `unknown` with a reason, treated as absent (fail open).
// A sensitive source without consent is never read (fail closed). Neutral
// ids only.

const NOW = 1_800_000_000_000

function readSource(over: Partial<SignalSource> = {}, read = vi.fn((): Signal[] => [
  { source: "demo", kind: "present", subject: "owner", value: true, checkedAt: NOW, expiresAt: null, reason: "seen" },
])): SignalSource {
  return { id: "demo", kind: "present", sensitivity: "open", platforms: ["any"], mode: "read", read, ...over }
}

describe("the signal interface", () => {
  it("unknown is not no: a value of its own, with a reason", () => {
    const s = unknownSignal("demo", "present", "owner", "the source is down", NOW)
    expect(s.value).toBe(UNKNOWN)
    expect(isUnknown(s)).toBe(true)
    expect(s.reason).toBe("the source is down")
    expect(isUnknown({ ...s, value: false })).toBe(false)
  })
})

describe("SignalSources: which sources load", () => {
  it("an adapter that does not fit the platform is not loaded, and says why", () => {
    const reg = new SignalSources({ platform: "linux" })
    expect(reg.register(readSource({ id: "mac-only", platforms: ["darwin"] }))).toBe(false)
    expect(reg.register(readSource({ id: "anywhere" }))).toBe(true)
    expect(reg.loaded().map((s) => s.id)).toEqual(["anywhere"])
    expect(reg.skipped()).toEqual([{ id: "mac-only", reason: "needs darwin, this node is linux" }])
  })

  it("reading a source that is not loaded gives unknown with a reason", () => {
    const reg = new SignalSources({ platform: "linux", now: () => NOW })
    const read = vi.fn((): Signal[] => [])
    reg.register(readSource({ id: "mac-only", platforms: ["darwin"] }, read))
    const [s] = reg.read("mac-only", {})
    expect(isUnknown(s)).toBe(true)
    expect(s.reason).toMatch(/not loaded on this node/)
    expect(read).not.toHaveBeenCalled()
    expect(isUnknown(reg.read("nothing-like-it", {})[0])).toBe(true)
  })
})

describe("SignalSources: down, off, per agent", () => {
  it("a source that throws answers unknown with its reason (fail open)", () => {
    const reg = new SignalSources({ now: () => NOW })
    reg.register(readSource({}, vi.fn(() => { throw new Error("socket closed") })))
    const [s] = reg.read("demo", {})
    expect(isUnknown(s)).toBe(true)
    expect(s.reason).toBe("source down: socket closed")
  })

  it("a source switched off in settings is not read", () => {
    const read = vi.fn((): Signal[] => [])
    const reg = new SignalSources({ settings: () => ({ demo: { enabled: false } }), now: () => NOW })
    reg.register(readSource({}, read))
    expect(reg.read("demo", {})[0].reason).toBe("switched off in situations.sources")
    expect(read).not.toHaveBeenCalled()
  })

  it("a source limited to some agents answers unknown for the others", () => {
    const read = vi.fn((): Signal[] => [{ source: "demo", kind: "present", subject: "owner", value: true, checkedAt: NOW, expiresAt: null, reason: "seen" }])
    const reg = new SignalSources({ settings: () => ({ demo: { agents: ["helper"] } }), now: () => NOW })
    reg.register(readSource({}, read))
    expect(reg.read("demo", { agentId: "helper" })[0].value).toBe(true)
    expect(isUnknown(reg.read("demo", { agentId: "other" })[0])).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("an expired answer is unknown", () => {
    const reg = new SignalSources({ now: () => NOW })
    reg.register(readSource({}, vi.fn((): Signal[] => [{ source: "demo", kind: "present", subject: "owner", value: true, checkedAt: NOW - 10, expiresAt: NOW - 1, reason: "seen" }])))
    const [s] = reg.read("demo", {})
    expect(isUnknown(s)).toBe(true)
    expect(s.reason).toMatch(/expired/)
  })
})

describe("SignalSources: consent (design 2.3, Anis Q3)", () => {
  it("a sensitive source without consent is never read (fail closed)", () => {
    const read = vi.fn((): Signal[] => [])
    const reg = new SignalSources({ now: () => NOW })
    reg.register(readSource({ id: "tabs", sensitivity: "sensitive" }, read))
    const [s] = reg.read("tabs", { agentId: "helper" })
    expect(isUnknown(s)).toBe(true)
    expect(s.reason).toBe("no consent")
    expect(read).not.toHaveBeenCalled()
  })

  it("settings cannot lower a sensitive source's consent to none", () => {
    const read = vi.fn((): Signal[] => [])
    const reg = new SignalSources({ settings: () => ({ tabs: { consent: "none" } }), now: () => NOW })
    reg.register(readSource({ id: "tabs", sensitivity: "sensitive" }, read))
    reg.read("tabs", {})
    expect(read).not.toHaveBeenCalled()
  })

  it("with the person's yes (checked per read, with the scope), it is read; once the yes expires, it is not", () => {
    const read = vi.fn((): Signal[] => [{ source: "tabs", kind: "tab", subject: "owner", value: "a page", checkedAt: NOW, expiresAt: null, reason: "read" }])
    let until = NOW + 1000
    const consent = vi.fn((_id: string, _scope: unknown, now: number) => now < until)
    const reg = new SignalSources({ consent, now: () => NOW })
    reg.register(readSource({ id: "tabs", sensitivity: "sensitive" }, read))
    expect(reg.read("tabs", { agentId: "helper", requestId: "r1" })[0].value).toBe("a page")
    expect(consent).toHaveBeenCalledWith("tabs", { agentId: "helper", requestId: "r1" }, NOW)
    until = NOW
    expect(reg.read("tabs", { agentId: "helper" })[0].reason).toBe("no consent")
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("an open source set to consent: person needs the yes too", () => {
    const read = vi.fn((): Signal[] => [])
    const reg = new SignalSources({ settings: () => ({ demo: { consent: "person" } }), now: () => NOW })
    reg.register(readSource({}, read))
    expect(reg.read("demo", {})[0].reason).toBe("no consent")
    expect(read).not.toHaveBeenCalled()
  })

  it("a pushed signal from a sensitive source without consent is not accepted", () => {
    const reg = new SignalSources({ now: () => NOW })
    reg.register(readSource({ id: "tabs", sensitivity: "sensitive", mode: "push", read: undefined }))
    reg.register(readSource({ id: "groups", mode: "push", read: undefined }))
    const sig = (source: string): Signal => ({ source, kind: "left", subject: "u1", value: true, checkedAt: NOW, expiresAt: null, reason: "left", scope: "k" })
    expect(reg.accepts(sig("tabs"))).toBe(false)
    expect(reg.accepts(sig("groups"))).toBe(true)
    expect(reg.accepts(sig("not-registered"))).toBe(false)
  })
})

describe("the settings key", () => {
  it("situations.sources is optional and defaults to none", () => {
    expect(DEFAULT_SITUATIONS_CONFIG.sources).toEqual({})
    const s = situationsConfigSchema.parse({ sources: { "whatsapp-groups": { enabled: false }, tabs: { consent: "person", agents: ["helper"] } } })
    expect(s.sources["whatsapp-groups"].enabled).toBe(false)
    expect(s.sources.tabs.consent).toBe("person")
  })
})

describe("the push hub: node-local, never on the event bus", () => {
  afterEach(() => setSignalInterest(null))

  it("delivers to listeners; one failing listener does not stop the others", () => {
    const got: Signal[] = []
    const off1 = onSignal(() => { throw new Error("bad listener") })
    const off2 = onSignal((s) => got.push(s))
    const s: Signal = { source: "demo", kind: "left", subject: "u1", value: true, checkedAt: NOW, expiresAt: null, reason: "left", scope: "k" }
    publishSignal(s)
    off1(); off2()
    publishSignal(s)
    expect(got).toEqual([s])
  })

  it("a signal never reaches the event bus (signals stay on the node, design 2.3)", () => {
    const bus = getEventBus()
    const seen: unknown[] = []
    const unsub = bus.subscribe((e) => seen.push(e))
    publishSignal({ source: "demo", kind: "left", subject: "15550001111", value: true, checkedAt: NOW, expiresAt: null, reason: "left", scope: "whatsapp|default|1203" })
    unsub()
    expect(JSON.stringify(seen)).not.toContain("15550001111")
  })

  it("wantsSignal: false with no interest, else what the interest says", () => {
    expect(wantsSignal("k")).toBe(false)
    setSignalInterest((k) => k === "k")
    expect(wantsSignal("k")).toBe(true)
    expect(wantsSignal("other")).toBe(false)
    setSignalInterest(() => { throw new Error("broken") })
    expect(wantsSignal("k")).toBe(false)
  })
})

describe("a leave event moves the talk to ending (phase 3 proof)", () => {
  const key = situationKey("whatsapp", "default", "120363000000000001@g.us")
  const left = (over: Partial<Signal> = {}): Signal => ({
    source: "whatsapp-groups", kind: "left", subject: "15550002222", value: true, checkedAt: NOW, expiresAt: null,
    reason: "left the group", scope: key, remaining: 0, ...over,
  })
  const active: SituationsConfig = { ...DEFAULT_SITUATIONS_CONFIG, mode: "active" }

  function storeWith(phase: "during" | "ending" | "ended" = "during") {
    const store = new SituationStore(new Database(":memory:"), () => NOW)
    store.create(key, phase, "first message on this chat")
    return store
  }

  it("the last other party left: during → ending, once, with one bus event", () => {
    const store = storeWith()
    const events: Array<{ from: unknown; to: unknown; cause: string }> = []
    const fn = (p: any) => events.push(p)
    getEventBus().on("situation:phase", fn)
    const r = applySignal(store, () => active, left())
    expect(r.moved).toBe(true)
    expect(store.get(key)!.phase).toBe("ending")
    // The why goes into the agent's prompt: it names no one.
    expect(store.get(key)!.why).toBe("the last other party left (whatsapp-groups)")
    expect(store.get(key)!.why).not.toContain("15550002222")
    // A second copy of the same leave (another account, a service message) does nothing.
    expect(applySignal(store, () => active, left()).moved).toBe(false)
    getEventBus().off("situation:phase", fn)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ from: "during", to: "ending" })
  })

  it("shadow mode keeps the record too (as the gate does); off changes nothing", () => {
    const a = storeWith()
    expect(applySignal(a, () => ({ ...active, mode: "shadow" }), left()).moved).toBe(true)
    const b = storeWith()
    expect(applySignal(b, () => ({ ...active, mode: "off" }), left()).moved).toBe(false)
    expect(b.get(key)!.phase).toBe("during")
  })

  it("others still there, or an unknown count, or an unknown value: nothing moves (unknown is absent)", () => {
    const store = storeWith()
    expect(applySignal(store, () => active, left({ remaining: 2 })).moved).toBe(false)
    expect(applySignal(store, () => active, left({ remaining: null })).moved).toBe(false)
    expect(applySignal(store, () => active, left({ remaining: undefined })).moved).toBe(false)
    expect(applySignal(store, () => active, left({ value: UNKNOWN })).moved).toBe(false)
    expect(store.get(key)!.phase).toBe("during")
  })

  it("no record, another kind, an expired signal, or a person's not-this: nothing moves", () => {
    const store = storeWith()
    expect(applySignal(store, () => active, left({ scope: "whatsapp|default|other" })).moved).toBe(false)
    expect(applySignal(store, () => active, left({ kind: "present" })).moved).toBe(false)
    expect(applySignal(store, () => active, left({ expiresAt: Date.now() - 1 })).moved).toBe(false)
    store.override(key, "not-this", "a person")
    expect(applySignal(store, () => active, left()).moved).toBe(false)
    expect(store.get(key)!.phase).toBe("during")
  })

  it("ending or ended stays where it is", () => {
    for (const phase of ["ending", "ended"] as const) {
      const store = storeWith(phase)
      expect(applySignal(store, () => active, left()).moved).toBe(false)
      expect(store.get(key)!.phase).toBe(phase)
    }
  })

  it("never throws", () => {
    const broken = { get: () => { throw new Error("db closed") } } as unknown as SituationStore
    expect(applySignal(broken, () => active, left())).toEqual({ moved: false })
  })
})

describe("the node's wiring (daemon start)", () => {
  it("loads the adapters that fit, applies an accepted leave, ignores one from a source switched off", async () => {
    const { attachSignalSources, sourcesView } = await import("../src/situations/sources/node")
    const { isMeshGatedPath } = await import("../src/daemon/mesh-auth")
    const key = situationKey("whatsapp", "default", "120363000000000009@g.us")
    const store = new SituationStore(new Database(":memory:"))
    store.create(key, "during", "first")
    let cfg: SituationsConfig = { ...DEFAULT_SITUATIONS_CONFIG, mode: "active" }
    const logs: string[] = []
    const node = attachSignalSources({ store, settings: () => cfg, calls: () => undefined, log: (m) => logs.push(m) })
    try {
      const ids = node.sources.loaded().map((s) => s.id).sort()
      expect(ids).toEqual(expect.arrayContaining(["call-hold", "calls", "telegram-members", "whatsapp-groups", "widget-hold"]))
      expect(ids.includes("macos-focus")).toBe(process.platform === "darwin")
      // Interest: chats in `during` only, and nothing when the feature is off.
      expect(wantsSignal(key)).toBe(true)
      expect(wantsSignal("whatsapp|default|unknown-chat")).toBe(false)
      const leave: Signal = { source: "whatsapp-groups", kind: "left", subject: "u1", value: true, checkedAt: 1, expiresAt: null, reason: "remove", scope: key, remaining: 0 }
      cfg = { ...cfg, sources: { "whatsapp-groups": { enabled: false } } }
      publishSignal(leave)
      expect(store.get(key)!.phase).toBe("during")
      cfg = { ...cfg, sources: {} }
      publishSignal(leave)
      expect(store.get(key)!.phase).toBe("ending")
      expect(logs.some((l) => l.includes("talk → ending") && !l.includes("u1"))).toBe(true)
      cfg = { ...cfg, mode: "off" }
      expect(wantsSignal(key)).toBe(false)
      // The view: a push source has no answer; the calls source, with no store, answers unknown.
      const view = sourcesView(node.sources)
      expect(view.loaded.find((s) => s.id === "whatsapp-groups")).toEqual({ id: "whatsapp-groups", kind: "left", sensitivity: "open", mode: "push" })
      expect(view.loaded.find((s) => s.id === "calls")).toMatchObject({ value: "unknown", reason: "source down: no call store on this node" })
      expect(isMeshGatedPath("/situations/sources")).toBe(true)
    } finally {
      node.detach()
    }
    expect(wantsSignal(key)).toBe(false)
  })

  it("a push source limited to some agents applies a leave only for a talk those agents own (#1945)", async () => {
    const { attachSignalSources } = await import("../src/situations/sources/node")
    const store = new SituationStore(new Database(":memory:"))
    const cfg: SituationsConfig = {
      ...DEFAULT_SITUATIONS_CONFIG, mode: "active",
      sources: { "whatsapp-groups": { agents: ["helper"] }, "telegram-members": { agents: ["helper"] } },
    }
    const node = attachSignalSources({ store, settings: () => cfg, calls: () => undefined })
    try {
      const cases: Array<[string, string]> = [
        ["whatsapp-groups", situationKey("whatsapp", "default", "120363000000000011@g.us")],
        ["telegram-members", situationKey("telegram", "default", "-1001")],
      ]
      for (const [source, base] of cases) {
        const mine = `${base}-mine`, other = `${base}-other`, unowned = `${base}-unowned`
        for (const k of [mine, other, unowned]) store.create(k, "during", "first")
        store.claimOwner(mine, "helper")
        store.claimOwner(other, "writer")
        const leave = (scope: string): Signal => ({ source, kind: "left", subject: "u1", value: true, checkedAt: 1, expiresAt: null, reason: "left", scope, remaining: 0 })
        publishSignal(leave(mine))
        publishSignal(leave(other))
        publishSignal(leave(unowned))
        expect(store.get(mine)!.phase).toBe("ending")
        expect(store.get(other)!.phase).toBe("during")
        expect(store.get(unowned)!.phase).toBe("during")
      }
    } finally {
      node.detach()
    }
  })
})
