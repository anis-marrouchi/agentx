import { describe, it, expect, beforeEach } from "vitest"
import { AttachRegistry, type OfferOutcome } from "../../src/attach/registry"

// The registry is the correctness core of attach mode. What is tested here
// is not "does it store things" but the one invariant that lets attach mode
// sit in front of production channel traffic:
//
//   every offered message settles exactly once — answered OR expired,
//   never both, never neither.
//
// Everything below is a way of racing claim() against expire() and checking
// that invariant holds.

let reg: AttachRegistry
const T0 = 1_700_000_000_000

function mkSession(id = "sess-1", agentId = "cx-agent") {
  reg.register(id, { cwd: "/tmp/work", now: T0 })
  reg.bind(id, agentId)
  return id
}

function offer(agentId = "cx-agent", text = "deploy status?", now = T0) {
  return reg.offer(
    { agentId, text, channel: "telegram", chatId: "chat-9", sender: "bob" },
    now,
  )
}

beforeEach(() => {
  reg = new AttachRegistry({ claimTimeoutMs: 1_000, staleSessionMs: 10_000, maxDrainPerTurn: 3 })
})

describe("binding", () => {
  it("returns null from offer when no session is bound", () => {
    reg.register("sess-1", { now: T0 })
    expect(offer()).toBeNull()
  })

  it("routes to the session bound to the agent", async () => {
    const s = mkSession()
    const p = offer()
    expect(p).not.toBeNull()
    expect(reg.pendingCount(s)).toBe(1)
  })

  it("a later bind steals the agent from an earlier session", () => {
    reg.register("sess-1", { now: T0 })
    reg.register("sess-2", { now: T0 })
    reg.bind("sess-1", "cx-agent")
    reg.bind("sess-2", "cx-agent")
    expect(reg.get("sess-1")!.agentIds).toEqual([])
    expect(reg.sessionFor("cx-agent")!.sessionId).toBe("sess-2")
  })

  it("keeps bindings when SessionStart fires again (resume/compact)", () => {
    const s = mkSession()
    reg.setMode(s, "auto")
    reg.register(s, { cwd: "/tmp/work", now: T0 + 5 })
    expect(reg.get(s)!.agentIds).toEqual(["cx-agent"])
    expect(reg.get(s)!.mode).toBe("auto")
  })
})

describe("the claim/expire race", () => {
  it("resolves answered when the session claims and answers", async () => {
    const s = mkSession()
    const p = offer()!
    const item = reg.claim(s, T0 + 10)
    expect(item?.text).toBe("deploy status?")
    reg.answer(s, "all green", T0 + 20)
    await expect(p).resolves.toEqual({ kind: "answered", text: "all green", sessionId: s })
  })

  it("resolves expired when the claim deadline passes", async () => {
    mkSession()
    const p = offer()!
    reg.sweep(T0 + 1_000)
    const out = (await p) as OfferOutcome
    expect(out.kind).toBe("expired")
  })

  it("a drain arriving after expiry finds nothing — no double answer", async () => {
    const s = mkSession()
    const p = offer()!
    reg.sweep(T0 + 1_000)
    await expect(p).resolves.toMatchObject({ kind: "expired" })

    // The session wakes up late and tries to drain.
    expect(reg.claim(s, T0 + 1_500)).toBeUndefined()
    expect(reg.answer(s, "too late", T0 + 1_600)).toBeUndefined()
  })

  it("expire loses once the item is claimed within the deadline", async () => {
    const s = mkSession()
    const p = offer()!
    const item = reg.claim(s, T0 + 500)!
    // Sweep at the claim deadline: the item is no longer pending, and its
    // own answer budget has not run out yet, so it must survive.
    reg.sweep(T0 + 1_000)
    expect(reg.item(item.id)!.state).toBe("claimed")
    reg.answer(s, "answered after all", T0 + 1_100)
    await expect(p).resolves.toMatchObject({ kind: "answered", text: "answered after all" })
  })

  it("a claimed-but-never-answered item still expires", async () => {
    const s = mkSession()
    const p = offer()!
    reg.claim(s, T0 + 100)
    reg.sweep(T0 + 1_101)
    await expect(p).resolves.toMatchObject({ kind: "expired" })
    // and the session is no longer holding it
    expect(reg.get(s)!.awaitingAnswer).toBeUndefined()
  })

  it("settles exactly once under repeated sweeps", async () => {
    mkSession()
    const p = offer()!
    let settles = 0
    p.then(() => settles++)
    reg.sweep(T0 + 1_000)
    reg.sweep(T0 + 2_000)
    reg.sweep(T0 + 3_000)
    await p
    expect(settles).toBe(1)
  })

  it("explicit expire is idempotent", () => {
    mkSession()
    const p = offer()!
    const id = reg.pending("sess-1")[0].id
    expect(reg.expire(id, "first", T0 + 5)).toBe(true)
    expect(reg.expire(id, "second", T0 + 6)).toBe(false)
    return expect(p).resolves.toMatchObject({ kind: "expired", reason: "first" })
  })
})

describe("serial answering", () => {
  it("only one item is outstanding per session at a time", () => {
    const s = mkSession()
    offer("cx-agent", "first")
    offer("cx-agent", "second")
    const a = reg.claim(s, T0 + 1)
    expect(a?.text).toBe("first")
    // A second claim is refused while the first is unanswered — otherwise
    // last_assistant_message could not be attributed to one question.
    expect(reg.claim(s, T0 + 2)).toBeUndefined()
    reg.answer(s, "answer to first", T0 + 3)
    expect(reg.claim(s, T0 + 4)?.text).toBe("second")
  })

  it("release puts an unanswered item back in the queue", () => {
    const s = mkSession()
    offer("cx-agent", "handle me")
    const item = reg.claim(s, T0 + 1)!
    reg.release(s, T0 + 2)
    expect(reg.item(item.id)!.state).toBe("pending")
    expect(reg.pendingCount(s)).toBe(1)
    expect(reg.claim(s, T0 + 3)?.id).toBe(item.id)
  })

  it("counts drains per turn and resets on endTurn", () => {
    const s = mkSession()
    offer("cx-agent", "one")
    offer("cx-agent", "two")
    reg.claim(s, T0 + 1)
    reg.answer(s, "a", T0 + 2)
    reg.claim(s, T0 + 3)
    expect(reg.get(s)!.drainedThisTurn).toBe(2)
    reg.endTurn(s)
    expect(reg.get(s)!.drainedThisTurn).toBe(0)
  })
})

describe("session lifecycle", () => {
  it("deregister expires queued work so it falls back to spawn", async () => {
    const s = mkSession()
    const p = offer()!
    reg.deregister(s, T0 + 10)
    await expect(p).resolves.toMatchObject({ kind: "expired", reason: "session ended" })
    expect(reg.get(s)).toBeUndefined()
  })

  it("a stale session is not offered traffic", () => {
    const s = mkSession()
    // No hook events for longer than staleSessionMs.
    expect(offer("cx-agent", "hello", T0 + 10_001)).toBeNull()
    expect(reg.get(s)).toBeUndefined()
  })

  it("touch keeps a session alive without creating unknown ones", () => {
    const s = mkSession()
    reg.touch(s, T0 + 9_000)
    expect(offer("cx-agent", "hello", T0 + 10_001)).not.toBeNull()
    expect(reg.touch("never-seen")).toBeUndefined()
  })

  it("sweep reaps stale sessions", () => {
    const s = mkSession()
    reg.sweep(T0 + 10_001)
    expect(reg.get(s)).toBeUndefined()
  })
})

describe("hygiene", () => {
  it("clips oversized messages so one channel dump cannot flood a context", () => {
    const r = new AttachRegistry({ maxItemChars: 20 })
    r.register("s", { now: T0 })
    r.bind("s", "cx-agent")
    r.offer({ agentId: "cx-agent", text: "x".repeat(500), channel: "t", chatId: "c", sender: "b" }, T0)
    const item = r.pending("s")[0]
    expect(item.text.length).toBeLessThan(100)
    expect(item.text).toContain("truncated")
  })

  it("prune drops settled items but never in-flight ones", async () => {
    const s = mkSession()
    const p = offer("cx-agent", "old")
    reg.sweep(T0 + 1_000)
    await p
    offer("cx-agent", "current", T0 + 1_000)
    expect(reg.prune(T0 + 3_600_001 + 1_000)).toBe(1)
    expect(reg.pendingCount(s)).toBe(1)
  })
})
