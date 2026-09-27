import { describe, it, expect } from "vitest"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AttachRegistry, type BindingStore, type SavedBinding } from "../../src/attach/registry"
import { fileBindingStore } from "../../src/attach"

// #193 — an `attach as` binding must survive a daemon restart and an idle
// spell. Only `detach` or the session really ending forgets it.

function memoryStore(): BindingStore & { data: Record<string, SavedBinding> } {
  const store = {
    data: {} as Record<string, SavedBinding>,
    load: () => structuredClone(store.data),
    save: (all: Record<string, SavedBinding>) => { store.data = structuredClone(all) },
  }
  return store
}

const now = () => Date.now()

describe("attach bindings persistence", () => {
  it("restores a binding after a daemon restart when the session registers again", () => {
    const store = memoryStore()
    const before = new AttachRegistry({}, store)
    before.register("s1", { cwd: "/work/mtgl" })
    before.bind("s1", "dev-session", "notify")

    const after = new AttachRegistry({}, store) // the daemon restarted
    expect(after.sessionFor("dev-session")).toBeUndefined()
    const s = after.register("s1", { cwd: "/work/mtgl" })
    expect(s.agentIds).toEqual(["dev-session"])
    expect(after.sessionFor("dev-session")?.sessionId).toBe("s1")
  })

  it("revives a bound session on a prompt/stop touch, but never an unbound one", () => {
    const store = memoryStore()
    const before = new AttachRegistry({}, store)
    before.register("bound")
    before.bind("bound", "coder-agent")
    before.register("plain")

    const after = new AttachRegistry({}, store)
    expect(after.touch("bound")?.agentIds).toEqual(["coder-agent"])
    expect(after.touch("plain")).toBeUndefined()
  })

  it("keeps the binding through an idle drop and gives it back on return", () => {
    const store = memoryStore()
    const reg = new AttachRegistry({ staleSessionMs: 1_000 }, store)
    reg.register("s1", { now: now() })
    reg.bind("s1", "dev-session")

    reg.sweep(now() + 5_000) // idle: dropped from live sessions
    expect(reg.sessionFor("dev-session")).toBeUndefined()
    expect(reg.touch("s1")?.agentIds).toEqual(["dev-session"])
  })

  it("forgets on session end and on detach", () => {
    const store = memoryStore()
    const reg = new AttachRegistry({}, store)
    reg.register("ended"); reg.bind("ended", "a1")
    reg.register("detached"); reg.bind("detached", "a2")

    reg.deregister("ended", now(), { forget: true })
    reg.unbind("detached")
    expect(store.data).toEqual({})
    expect(new AttachRegistry({}, store).touch("ended")).toBeUndefined()
  })

  it("does not hand back an agent another session has taken since", () => {
    const store = memoryStore()
    const reg = new AttachRegistry({ staleSessionMs: 1_000 }, store)
    reg.register("old", { now: now() }); reg.bind("old", "dev-session")
    reg.sweep(now() + 5_000)
    reg.register("new"); reg.bind("new", "dev-session")

    // Nothing left to restore, so the old session comes back as a plain one.
    expect(reg.touch("old")).toBeUndefined()
    expect(reg.sessionFor("dev-session")?.sessionId).toBe("new")
  })

  it("drops saved bindings older than a week and survives a corrupt store", () => {
    const store = memoryStore()
    store.data = { gone: { agentIds: ["a"], mode: "notify", savedAt: now() - 8 * 24 * 3_600_000 } }
    expect(new AttachRegistry({}, store).touch("gone")).toBeUndefined()

    const broken: BindingStore = { load: () => { throw new Error("bad json") }, save: () => {} }
    expect(() => new AttachRegistry({}, broken)).not.toThrow()
  })

  it("writes the file store atomically with owner-only permissions", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ax-bind-")), "attach-bindings.json")
    const reg = new AttachRegistry({}, fileBindingStore(path))
    reg.register("s1"); reg.bind("s1", "dev-session", "auto")

    expect(JSON.parse(readFileSync(path, "utf-8")).s1).toMatchObject({ agentIds: ["dev-session"], mode: "auto" })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(new AttachRegistry({}, fileBindingStore(path)).register("s1").mode).toBe("auto")
  })
})
