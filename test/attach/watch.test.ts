import { describe, it, expect, beforeEach } from "vitest"
import { execSync } from "node:child_process"
import { createServer } from "node:net"
import { getAttachRegistry, resetAttachRegistry, DEFAULT_WATCH_SUBSCRIPTIONS, cursorAtEnd } from "../../src/attach"
import { AttachRegistry, type BindingStore, type SavedBinding } from "../../src/attach/registry"
import { onSessionStart, onPrompt, onStop } from "../../src/attach/service"
import { attachHookBlock } from "../../src/attach/install"
import {
  eventsAfter,
  parseWatchSubscriptions,
  renderWatchDigest,
  watchDigest,
  WATCH_DIGEST_MAX_CHARS,
  WATCH_DIGEST_MAX_LINES,
} from "../../src/attach/watch"
import { groupSessions, watchFilterFromOptions } from "../../src/commands/attach"
import { getEventBus } from "../../src/events/bus"
import { matchesFilters } from "../../src/events/subscriptions"
import type { EventEnvelope } from "../../src/events/envelope"

// #167 — a watching session answers for nobody and hears about the mesh
// only through a capped digest on its own prompts.

const SID = "watch-sess"

function parse(out: string): any {
  return out === "" ? null : JSON.parse(out)
}

function watch(sessionId = SID) {
  const reg = getAttachRegistry()
  reg.register(sessionId, { cwd: "/tmp/w" })
  reg.watch(sessionId, { subscriptions: DEFAULT_WATCH_SUBSCRIPTIONS, cursor: cursorAtEnd(getEventBus().recent()) })
  return reg
}

function failTurn(agentId: string, n = 0) {
  getEventBus().publish({ kind: "agent", type: "task:completed", agentId, summary: `failed after ${n}ms: boom` })
}

function env(p: Partial<EventEnvelope>): EventEnvelope {
  return { id: "e", rootId: "e", node: "n1", kind: "agent", type: "x", at: new Date().toISOString(), summary: "", ...p }
}

beforeEach(() => {
  resetAttachRegistry()
  getEventBus().removeAllListeners()
})

describe("a watching session is offered nothing", () => {
  it("a message for agent X is not queued to the watcher, so X handles it as usual", () => {
    const reg = watch()
    expect(reg.offer({ agentId: "helper", text: "hi", channel: "telegram", chatId: "c1", sender: "sam" })).toBeNull()
    expect(reg.pendingCount(SID)).toBe(0)
    expect(onStop({ session_id: SID, last_assistant_message: "anything" })).toBe("")
  })

  it("switching a bound session to watch releases the identity and its queue", async () => {
    const reg = getAttachRegistry()
    reg.register(SID)
    reg.bind(SID, "helper", "auto")
    const offered = reg.offer({ agentId: "helper", text: "hi", channel: "telegram", chatId: "c1", sender: "sam" })!
    reg.watch(SID, { subscriptions: DEFAULT_WATCH_SUBSCRIPTIONS, cursor: cursorAtEnd([]) })
    expect(await offered).toMatchObject({ kind: "expired" })
    expect(reg.sessionFor("helper")).toBeUndefined()
    // Even with auto mode left over, Stop never takes the turn.
    expect(onStop({ session_id: SID, last_assistant_message: "x" })).toBe("")
  })

  it("binding an identity ends watching", () => {
    const reg = watch()
    reg.bind(SID, "helper")
    expect(reg.get(SID)?.watch).toBeUndefined()
  })

  it("SessionStart injects nothing; the prompt is the only injection", () => {
    watch()
    failTurn("helper")
    expect(onSessionStart({ session_id: SID })).toBe("")
  })

  it("a full detach ends watching, releasing one identity does not", () => {
    const reg = watch()
    reg.unbind(SID, "helper")
    expect(reg.get(SID)?.watch).toBeDefined()
    reg.unbind(SID)
    expect(reg.get(SID)?.watch).toBeUndefined()
    failTurn("helper")
    expect(onPrompt({ session_id: SID })).toBe("")
  })
})

describe("the prompt digest", () => {
  it("lists events since the last turn, then only newer ones", () => {
    failTurn("before-watching")
    watch()
    failTurn("helper", 1)
    const first = parse(onPrompt({ session_id: SID }))
    expect(first.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(first.hookSpecificOutput.additionalContext).toContain("helper@")
    expect(first.hookSpecificOutput.additionalContext).not.toContain("before-watching")

    expect(onPrompt({ session_id: SID })).toBe("")
    getEventBus().publish({ kind: "mesh", type: "lost", summary: "peer office-mini lost" })
    const third = parse(onPrompt({ session_id: SID }))
    expect(third.hookSpecificOutput.additionalContext).toContain("office-mini")
    expect(third.hookSpecificOutput.additionalContext).not.toContain("helper@")
  })

  it("stays quiet when only unmatched events arrived, and moves past them", () => {
    const reg = watch()
    getEventBus().publish({ kind: "agent", type: "task:step", agentId: "helper", summary: "tool_use Bash" })
    expect(onPrompt({ session_id: SID })).toBe("")
    const last = getEventBus().recent().at(-1)!
    expect(reg.get(SID)?.watch?.cursor.id).toBe(last.id)
  })

  it("200 events respect the caps and say how many were left out", () => {
    watch()
    for (let i = 0; i < 200; i++) failTurn(`agent-${i}`, i)
    const text: string = parse(onPrompt({ session_id: SID })).hookSpecificOutput.additionalContext
    const lines = text.split("\n")
    expect(lines.length).toBeLessThanOrEqual(WATCH_DIGEST_MAX_LINES)
    expect(text.length).toBeLessThanOrEqual(WATCH_DIGEST_MAX_CHARS)
    const shown = lines.filter((l) => l.startsWith("- ")).length
    expect(shown).toBeGreaterThan(0)
    expect(lines.at(-1)).toMatch(new RegExp(`^\\+${200 - shown} more — \`agentx events --since `))
    expect(lines[0]).toContain("200 events")
    // The newest events are the ones kept.
    expect(text).toContain("agent-199@")
  })

  it("the character cap binds before the line cap on long summaries", () => {
    const long = Array.from({ length: 12 }, (_, i) => env({ id: `e${i}`, summary: `${i} `.padEnd(300, "x") }))
    const { text, shown } = renderWatchDigest(long, "e0")
    expect(text.length).toBeLessThanOrEqual(WATCH_DIGEST_MAX_CHARS)
    expect(shown).toBeLessThan(12)
    expect(text).toContain(`+${12 - shown} more`)
  })

  it("a cursor whose event left the ring falls back to its time", () => {
    const old = new Date(Date.now() - 60_000).toISOString()
    const events = [env({ id: "a", at: old }), env({ id: "b", at: new Date().toISOString() })]
    expect(eventsAfter(events, { id: "gone", at: old }).map((e) => e.id)).toEqual(["b"])
    expect(eventsAfter(events, { at: old }).map((e) => e.id)).toEqual(["a", "b"])
    expect(watchDigest({ subscriptions: [{ kinds: ["*"] }], cursor: { id: "b", at: old }, startedAt: 0 }, events).matched).toBe(0)
  })
})

describe("default filter: failures, completions, approvals waiting, peers down", () => {
  const hit = (e: EventEnvelope) => DEFAULT_WATCH_SUBSCRIPTIONS.some((s) => matchesFilters(s, e))

  it("matches the events the daemon publishes for them", () => {
    expect(hit(env({ kind: "agent", type: "task:completed", summary: "failed after 3ms: x" }))).toBe(true)
    expect(hit(env({ kind: "agent", type: "task:completed", summary: "completed in 3ms" }))).toBe(true)
    expect(hit(env({ kind: "run", type: "failed", summary: "wf n1 failed boom" }))).toBe(true)
    expect(hit(env({ kind: "run", type: "timeout", summary: "wf n1 timeout" }))).toBe(true)
    expect(hit(env({ kind: "run", type: "completed", summary: "wf completed" }))).toBe(true)
    expect(hit(env({ kind: "run", type: "paused", summary: "wf approve paused checkpoint" }))).toBe(true)
    expect(hit(env({ kind: "mesh", type: "lost", summary: "peer p lost" }))).toBe(true)
  })

  it("leaves routine traffic out", () => {
    expect(hit(env({ kind: "agent", type: "task:started" }))).toBe(false)
    expect(hit(env({ kind: "agent", type: "task:step" }))).toBe(false)
    expect(hit(env({ kind: "message", type: "message:matched" }))).toBe(false)
    expect(hit(env({ kind: "run", type: "paused", summary: "wf wait paused timerWait" }))).toBe(false)
    expect(hit(env({ kind: "mesh", type: "recovered" }))).toBe(false)
  })
})

describe("persistence", () => {
  it("a watcher survives a daemon restart with its filter and cursor", () => {
    const store = {
      data: {} as Record<string, SavedBinding>,
      load: () => structuredClone(store.data),
      save: (all: Record<string, SavedBinding>) => { store.data = structuredClone(all) },
    } satisfies BindingStore & { data: Record<string, SavedBinding> }
    const before = new AttachRegistry({}, store)
    before.register("s1")
    before.watch("s1", { subscriptions: [{ kinds: ["lost"] }], cursor: { id: "x", at: "2026-01-01T00:00:00.000Z" } })
    const after = new AttachRegistry({}, store)
    const s = after.touch("s1")
    expect(s?.watch?.subscriptions).toEqual([{ kinds: ["lost"] }])
    expect(s?.watch?.cursor.id).toBe("x")
    after.unbind("s1")
    expect(store.data.s1).toBeUndefined()
  })
})

describe("filter input", () => {
  it("uses the default when none is given and validates a custom one", () => {
    expect(parseWatchSubscriptions(undefined)).toEqual({ ok: true, subscriptions: DEFAULT_WATCH_SUBSCRIPTIONS })
    expect(parseWatchSubscriptions([{ kinds: ["lost"] }])).toMatchObject({ ok: true })
    expect(parseWatchSubscriptions([{ kinds: [] }])).toMatchObject({ ok: false })
    expect(parseWatchSubscriptions("nope")).toMatchObject({ ok: false })
  })

  it("CLI options build one subscription, or none for the default", () => {
    expect(watchFilterFromOptions({})).toBeUndefined()
    expect(watchFilterFromOptions({ kinds: "failed, lost" })).toEqual([{ kinds: ["failed", "lost"] }])
    expect(watchFilterFromOptions({ agents: "helper", match: "deploy" })).toEqual([{ kinds: ["*"], agents: ["helper"], match: "deploy" }])
  })
})

describe("attach list", () => {
  it("shows watchers separately from identities", () => {
    const reg = getAttachRegistry()
    reg.register("bound")
    reg.bind("bound", "helper")
    reg.register("idle")
    watch("watcher")
    const g = groupSessions(reg.list())
    expect(g.bound.map((s) => s.sessionId)).toEqual(["bound"])
    expect(g.watching.map((s) => s.sessionId)).toEqual(["watcher"])
    expect(g.idle).toBe(1)
  })
})

describe("hooks fail open", () => {
  it("the prompt and stop hooks print nothing and exit 0 when the daemon is stopped", async () => {
    // A port that was free a moment ago: nothing is listening on it.
    const port = await new Promise<number>((resolve) => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port
        srv.close(() => resolve(p))
      })
    })
    const block = attachHookBlock(String(port))
    for (const event of ["UserPromptSubmit", "Stop"]) {
      const cmd = block[event][0].hooks[0].command
      const out = execSync(cmd, { input: JSON.stringify({ session_id: SID, prompt: "hi" }), encoding: "utf-8", shell: "/bin/sh" })
      expect(out).toBe("")
    }
  })
})
