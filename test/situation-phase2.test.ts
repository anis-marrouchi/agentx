import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageRouter } from "../src/channels/router"
import { setMessageRouter } from "../src/channels/router-instance"
import { setSendToChatStore } from "../src/situations/send-to-chat"
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../src/channels/types"
import { SituationStore } from "../src/situations/store"
import { SituationGate } from "../src/situations/gate"
import { situationKey } from "../src/situations/key"
import { DEFAULT_SITUATIONS_CONFIG, type SituationsConfig } from "../src/situations/config"
import { renderSituationLayer, setSituationContextSource, situationContextFor } from "../src/situations/context"
import { situationsList, situationsOverride } from "../src/situations/api"
import { buildAgentContext } from "../src/agents/context"
import { getEventBus, type AgentXEvents } from "../src/events/bus"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { situationRowsHtml, situationPhaseLabel } from "../src/daemon/ui/pages/situation-chip"
import { handleSituationsPanel } from "../src/daemon/situations-panel"

// #1892 phase 2: see it and override it. The [Situation] prompt layer,
// the situation:phase bus event, the chip, the CLI's API and the override.
// Proof of done: the agent's prompt shows the phase; a person ends a
// situation from the chip and the next courtesy message is dropped.
// Neutral ids only.

const GROUP = "120363000000000000@g.us"
const C = { id: "15550100@s.whatsapp.net", name: "C" }
const P = { id: "15550111@s.whatsapp.net", name: "Candidate" }
const KEY = situationKey("whatsapp", "default", GROUP)
// WhatsApp chat ids are keyed without the "@g.us" ending (normalizeChat).
const GROUP_N = "120363000000000000"

let n = 0
let dir: string
const cwd = process.cwd()
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agentx-1892p2-")); process.chdir(dir) })
afterAll(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) })
afterEach(() => { setSendToChatStore(null); setMessageRouter(null); setSituationContextSource(null) })

function world(opts: { mode?: SituationsConfig["mode"]; reply?: (t: string) => string } = {}) {
  const store = new SituationStore(new Database(":memory:"))
  const cfg: SituationsConfig = { ...DEFAULT_SITUATIONS_CONFIG, mode: opts.mode ?? "active" }
  const turns: Array<{ message: string; context: Record<string, unknown>; layer?: string }> = []
  const sent: OutgoingMessage[] = []
  const registry = {
    getAgent: (id: string) => (id === "recruiter" ? { name: "Recruiter", mentions: [] } : undefined),
    getSessionStore: () => ({ addAgentMessage: () => {} }),
    execute: async (req: { message: string; context: Record<string, unknown> }) => {
      // What the registry would put in the prompt for this turn.
      turns.push({ ...req, layer: situationContextFor(req.context.situationKey as string | undefined, { fresh: true }) })
      const latest = req.message.split("\n\n").pop() ?? req.message
      return { content: (opts.reply ?? (() => "Noted."))(latest) }
    },
  }
  const router = new MessageRouter(registry as any, { channels: { telegram: { accounts: {} } }, agents: {} } as any, undefined, () => {})
  const adapter = {
    name: "whatsapp",
    start: async () => {}, stop: async () => {}, onMessage: () => {},
    send: async (m: OutgoingMessage) => { sent.push(m); return `out-${sent.length}` },
    react: async () => {},
    sendTyping: async () => {},
  } as unknown as ChannelAdapter
  router.addChannel(adapter)
  setMessageRouter(router)
  setSendToChatStore(store)
  const gate = new SituationGate({ store, settings: () => cfg })
  router.setSituationGate(gate)
  setSituationContextSource({ store, settings: () => cfg, hold: () => ({ active: false, mode: null, reason: "" }) })
  const say = async (from: { id: string; name: string; isBot?: boolean }, text: string) => {
    const msg: IncomingMessage = {
      id: `in-${++n}`, channel: "whatsapp", accountId: "default", sender: from,
      group: { id: GROUP, name: "Interview" }, text, timestamp: new Date(), resolvedAgent: "recruiter",
    }
    await (router as any).handleMessage(adapter, msg)
  }
  return { store, cfg, turns, sent, say, gate, phase: () => store.get(KEY)?.phase }
}

describe("proof: a person ends the talk from the chip, the next courtesy message is dropped", () => {
  it("end by a person, then 'thanks' from the other side starts no run", async () => {
    const w = world()
    await w.say(C, "Hello, I am here for the interview.")
    expect(w.phase()).toBe("during")
    expect(w.turns).toHaveLength(1)

    // The chip's End button posts this (through the dashboard proxy).
    const row = w.store.get(KEY)!
    const r = situationsOverride(w.store, { id: row.id, action: "end", by: "owner (dashboard)" })
    expect(r.status).toBe(200)
    expect(w.phase()).toBe("ended")
    expect(w.store.get(KEY)).toMatchObject({ setBy: "person", endReason: "person" })

    await w.say(C, "Thank you, goodbye!")
    expect(w.turns).toHaveLength(1) // no run
    expect(w.store.gateLog().map((g) => g.outcome)).toEqual(["drop"])
    expect(w.store.gateLog()[0].reason).toMatch(/ended \(person\)/)

    // A real message still opens the talk again (fail open).
    await w.say(C, "One more question: when is the start date?")
    expect(w.turns).toHaveLength(2)
    expect(w.phase()).toBe("during")
  })
})

describe("proof: the agent's prompt shows the phase", () => {
  it("the router passes the chat's key, and the layer names the phase", async () => {
    const w = world({ reply: (t) => (/thank you/i.test(t) ? "Goodbye, and good luck." : "Welcome.") })
    await w.say(C, "Hello")
    expect(w.turns[0].context.situationKey).toBe(KEY)
    expect(w.turns[0].layer).toMatch(/^\[Situation\] Conversation, phase: during/)
    await w.say(C, "Thank you, goodbye!")
    expect(w.turns[1].layer).toMatch(/phase: ending/)
    expect(w.turns[1].layer).toMatch(/one short goodbye/)
  })

  it("the routed agent becomes the record's owner", async () => {
    const w = world()
    await w.say(C, "Hello")
    expect(w.store.get(KEY)?.ownerAgent).toBe("recruiter")
  })

  it("buildAgentContext prints the layer", () => {
    const out = buildAgentContext({ channel: "whatsapp", agentId: "a", agentName: "A", sender: "C", message: "hi", situation: "[Situation] Conversation, phase: ending." } as any)
    expect(out).toContain("[Situation] Conversation, phase: ending.")
  })
})

describe("[Situation] layer: short, fresh sessions only except at the end", () => {
  const base = { id: "s1", key: KEY, template: "conversation", endGeneration: 0, enteredAt: 0, phaseChangedAt: 0, slot: "free", slotBy: null, ownerAgent: null, override: null } as const

  it("during: shown on a fresh session, not on a resumed one", () => {
    const row = { ...base, phase: "during", endReason: null, setBy: "rule", why: "first message on this chat" } as const
    expect(renderSituationLayer(row as any, { fresh: true })).toBe("[Situation] Conversation, phase: during.")
    expect(renderSituationLayer(row as any, { fresh: false })).toBeUndefined()
  })

  it("ending and ended: shown on a resumed session too, one line", () => {
    const ending = { ...base, phase: "ending", endReason: null, setBy: "rule", why: "a closer from person C" } as const
    const ended = { ...base, phase: "ended", endReason: "person", setBy: "person", why: "ended by owner (dashboard)" } as const
    const now = 10 * 60_000 // 10 min after the phase changed
    for (const row of [ending, ended]) {
      const line = renderSituationLayer(row as any, { fresh: false, now })!
      expect(line).toMatch(/^\[Situation\] Conversation, phase: (ending|ended)/)
      expect(line.split("\n")).toHaveLength(1)
      expect(line.length).toBeLessThan(400)
    }
    expect(renderSituationLayer(ended as any, { fresh: false, now })).toMatch(/set by a person/)
  })

  it("the resumed-session exception is bounded: only soon after the phase changed", () => {
    const ended = { ...base, phase: "ended", endReason: "closed", setBy: "rule", why: "the goodbye was sent" } as const
    expect(renderSituationLayer(ended as any, { fresh: false, now: 29 * 60_000 })).toMatch(/phase: ended/)
    // Hours later an "ok" that does not reopen: fresh-only again.
    expect(renderSituationLayer(ended as any, { fresh: false, now: 3 * 3600_000 })).toBeUndefined()
    expect(renderSituationLayer(ended as any, { fresh: true, now: 3 * 3600_000 })).toMatch(/phase: ended/)
  })

  it("a busy owner is named generically, never with the hold's reason", () => {
    const row = { ...base, phase: "during", endReason: null, setBy: "rule", why: "" } as const
    expect(renderSituationLayer(row as any, { fresh: true, ownerBusy: true })).toMatch(/The owner is busy now; do not promise an immediate answer from them\.$/)
    // A customer chat while the owner's Mac reports sleep mode.
    const store = new SituationStore(new Database(":memory:"))
    store.create(KEY, "during", "first message on this chat")
    setSituationContextSource({
      store, settings: () => ({ ...DEFAULT_SITUATIONS_CONFIG, mode: "active" }),
      hold: () => ({ active: true, mode: "focus" as any, reason: "Focus assertion present (com.apple.sleep.sleep-mode)" }),
    })
    const line = situationContextFor(KEY, { fresh: true })!
    expect(line).toMatch(/owner is busy now/)
    expect(line).not.toMatch(/sleep|Focus|assertion|apple/i)
  })

  it("nothing in shadow or off mode, for an unknown chat, or when reading fails (fail open)", () => {
    const store = new SituationStore(new Database(":memory:"))
    store.create(KEY, "ending", "test")
    const cfg = { ...DEFAULT_SITUATIONS_CONFIG, mode: "shadow" as const }
    setSituationContextSource({ store, settings: () => cfg })
    expect(situationContextFor(KEY, { fresh: true })).toBeUndefined()
    cfg.mode = "active" as any
    expect(situationContextFor(KEY, { fresh: true })).toMatch(/ending/)
    expect(situationContextFor("whatsapp|default|other", { fresh: true })).toBeUndefined()
    expect(situationContextFor(undefined, { fresh: true })).toBeUndefined()
    setSituationContextSource({ store: { get: () => { throw new Error("db busy") } } as any, settings: () => cfg })
    expect(situationContextFor(KEY, { fresh: true })).toBeUndefined()
  })
})

describe("situation:phase bus event (one emit point: the store)", () => {
  it("each committed change emits once, with who set it", () => {
    const events: AgentXEvents["situation:phase"][] = []
    const fn = (e: AgentXEvents["situation:phase"]) => { events.push(e) }
    getEventBus().on("situation:phase", fn)
    try {
      const store = new SituationStore(new Database(":memory:"))
      store.create(KEY, "during", "first message on this chat")
      const row = store.get(KEY)!
      expect(store.move(KEY, { phase: "during", since: row.phaseChangedAt }, "ending", { why: "a closer" })).toBe(true)
      // A lost race writes nothing and emits nothing.
      expect(store.move(KEY, { phase: "during", since: row.phaseChangedAt }, "ending", { why: "again" })).toBe(false)
      store.override(row.id, "end", "operator (CLI)")
      expect(events.map((e) => [e.from, e.to, e.setBy])).toEqual([
        [null, "during", "rule"], ["during", "ending", "rule"], ["ending", "ended", "person"],
      ])
      expect(events[2]).toMatchObject({ situationId: row.id, key: KEY, channel: "whatsapp", chatId: GROUP_N, endReason: "person" })
      // The envelope peers see names the chat and phase, never the why.
      const env = getEventBus().recent({ kind: "situation" }).at(-1)!
      expect(env.type).toBe("situation:phase")
      expect(env.summary).not.toMatch(/CLI/)
    } finally {
      getEventBus().off("situation:phase", fn)
    }
  })
})

describe("override", () => {
  it("not-this: back to during, and a closer does not move it to ending again", () => {
    const store = new SituationStore(new Database(":memory:"))
    const gate = new SituationGate({ store, settings: () => ({ ...DEFAULT_SITUATIONS_CONFIG, mode: "active" }) })
    store.create(KEY, "ending", "the first message is a closer")
    const r = store.override(store.get(KEY)!.id, "not-this", "owner (dashboard)")
    expect(r.ok).toBe(true)
    expect(store.get(KEY)).toMatchObject({ phase: "during", setBy: "person", override: "not-this" })
    const msg = { id: "m1", channel: "whatsapp", accountId: "default", sender: P, group: { id: GROUP, name: "x" }, text: "Thanks, bye!", timestamp: new Date() } as IncomingMessage
    const d = gate.decide(msg)
    expect(d.changes).toEqual([])
    gate.commit(d)
    expect(store.get(KEY)?.phase).toBe("during")
  })

  it("not-this on an ended talk reopens it (one more end generation)", () => {
    const store = new SituationStore(new Database(":memory:"))
    store.create(KEY, "ended", "test", "closed")
    store.override(store.get(KEY)!.id, "not-this", "x")
    expect(store.get(KEY)).toMatchObject({ phase: "during", endGeneration: 1 })
  })

  it("clear removes the record; the next message starts a new one", () => {
    const store = new SituationStore(new Database(":memory:"))
    store.create(KEY, "ended", "test", "closed")
    expect(store.override(KEY, "clear", "x").ok).toBe(true)
    expect(store.get(KEY)).toBeNull()
  })

  it("a record is found by id, a unique id prefix, or its key", () => {
    const store = new SituationStore(new Database(":memory:"))
    store.create(KEY, "during", "test")
    const id = store.get(KEY)!.id
    expect(store.resolve(id)?.key).toBe(KEY)
    expect(store.resolve(id.slice(0, 8))?.key).toBe(KEY)
    expect(store.resolve(KEY)?.id).toBe(id)
    expect(store.resolve("abc")).toBeNull() // too short to be a prefix
    expect(store.resolve("ffffffff-none")).toBeNull()
  })

  it("an end on an ended talk, an unknown record or action answers an error", () => {
    const store = new SituationStore(new Database(":memory:"))
    store.create(KEY, "ended", "test", "closed")
    expect(situationsOverride(store, { id: KEY, action: "end" }).status).toBe(409)
    expect(situationsOverride(store, { id: "nope-nope", action: "end" }).status).toBe(404)
    expect(situationsOverride(store, { id: KEY, action: "explode" }).status).toBe(400)
    expect(situationsOverride(store, { action: "end" }).status).toBe(400)
  })
})

describe("GET /situations", () => {
  it("lists records, newest first, filtered by agent and phase", () => {
    const store = new SituationStore(new Database(":memory:"))
    store.create(KEY, "during", "a")
    store.claimOwner(KEY, "recruiter")
    store.create("telegram|default|42", "ended", "b", "closed")
    const all = situationsList(store, new URLSearchParams(), "active")
    expect(all.status).toBe(200)
    expect((all.body as any).rows).toHaveLength(2)
    const mine = situationsList(store, new URLSearchParams({ agent: "recruiter" }), "active").body as any
    expect(mine.rows.map((r: any) => [r.channel, r.chatId, r.phase])).toEqual([["whatsapp", GROUP_N, "during"]])
    const ended = situationsList(store, new URLSearchParams({ phase: "ended" }), "active").body as any
    expect(ended.rows).toHaveLength(1)
    expect(ended.mode).toBe("active")
  })

  it("is mesh-gated: the rows name chats and why their phase moved", () => {
    expect(isMeshGatedPath("/situations")).toBe(true)
  })
})

describe("the chip", () => {
  const row = { id: "0123456789ab", key: KEY, channel: "whatsapp", chatId: GROUP, template: "conversation", phase: "ending", endReason: null, setBy: "rule", why: "a closer from <b>C</b>", phaseChangedAt: Date.now() - 120_000, ownerAgent: "recruiter", override: null }

  it("shows the situation and phase, why, and End / Not this buttons", () => {
    const html = situationRowsHtml([row as any], Date.now())
    expect(html).toContain("Conversation · ending")
    expect(html).toContain("a closer from &lt;b&gt;C&lt;/b&gt;") // escaped
    expect(html).toMatch(/<button[^>]*data-sit-act="end"[^>]*data-sit-id="0123456789ab"/)
    expect(html).toMatch(/<button[^>]*data-sit-act="not-this"/)
    expect(html).toMatch(/aria-label="End this talk/)
  })

  it("an ended talk has no End button; an empty list says so", () => {
    expect(situationRowsHtml([{ ...row, phase: "ended", endReason: "person" } as any], Date.now())).not.toContain('data-sit-act="end"')
    expect(situationRowsHtml([], Date.now())).toMatch(/No conversations/)
    expect(situationPhaseLabel({ ...row, phase: "ended", endReason: "courtesy loop" } as any)).toBe("Conversation · ended (courtesy loop)")
  })
})

describe("dashboard proxy", () => {
  function fakeRes() {
    const out: { status?: number; body?: string } = {}
    return { out, res: { writeHead: (s: number) => { out.status = s }, setHeader: () => {}, end: (b: string) => { out.body = b } } as any }
  }
  it("an override needs the owner; others get 401 and nothing reaches the daemon", async () => {
    let called = 0
    const { out, res } = fakeRes()
    const handled = await handleSituationsPanel({ method: "POST" } as any, res, "/api/admin/situations/override", new URLSearchParams(), {
      daemonUrl: "http://127.0.0.1:1", token: "t", owner: false,
      readBody: async () => ({ id: "x", action: "end" }),
      fetch: (async () => { called++; return new Response("{}") }) as any,
    })
    expect(handled).toBe(true)
    expect(out.status).toBe(401)
    expect(called).toBe(0)
  })

  it("the owner's override goes to the daemon with the node token and a person label", async () => {
    const calls: Array<{ url: string; init: any }> = []
    const { out, res } = fakeRes()
    await handleSituationsPanel({ method: "POST" } as any, res, "/api/admin/situations/override", new URLSearchParams(), {
      daemonUrl: "http://127.0.0.1:1/", token: "t", owner: true,
      readBody: async () => ({ id: "abc123", action: "end", by: "someone else" }),
      fetch: (async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }) }) as any,
    })
    expect(out.status).toBe(200)
    expect(calls[0].url).toBe("http://127.0.0.1:1/situations/override")
    expect(calls[0].init.headers.Authorization).toBe("Bearer t")
    expect(JSON.parse(calls[0].init.body)).toEqual({ id: "abc123", action: "end", by: "owner (dashboard)" })
  })

  it("a daemon that is not on this machine gets a clear error, and no token is sent to it", async () => {
    let called = 0
    const { out, res } = fakeRes()
    await handleSituationsPanel({ method: "GET" } as any, res, "/api/admin/situations", new URLSearchParams(), {
      daemonUrl: "http://10.0.0.5:18800", token: "t", owner: true, readBody: async () => ({}),
      fetch: (async () => { called++; return new Response("{}") }) as any,
    })
    expect(called).toBe(0)
    expect(out.status).toBe(503)
    expect(JSON.parse(out.body!).error).toMatch(/same machine/)
  })

  it("other paths are not handled", async () => {
    const { res } = fakeRes()
    expect(await handleSituationsPanel({ method: "GET" } as any, res, "/api/admin/other", new URLSearchParams(), { daemonUrl: "x", token: "", owner: true, readBody: async () => ({}) })).toBe(false)
  })
})
