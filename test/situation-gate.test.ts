import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { MessageRouter } from "../src/channels/router"
import { setMessageRouter } from "../src/channels/router-instance"
import { setSendToChatStore } from "../src/situations/send-to-chat"
import { channelReply } from "../src/actions/builtin/channel"
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../src/channels/types"
import { HookRegistry } from "../src/hooks/registry"
import { SituationStore } from "../src/situations/store"
import { SituationGate } from "../src/situations/gate"
import { situationKey } from "../src/situations/key"
import { DEFAULT_SITUATIONS_CONFIG, type SituationsConfig } from "../src/situations/config"
import { RunStore, WorkflowDispatcher, WorkflowStore, workflowSchema } from "../src/workflows"
import { createWorkflowHookHandlers } from "../src/workflows/hooks"
import { TimerService } from "../src/workflows/timers"
import { deliver } from "../src/workflows/nodes/follow-up"

// #1892 phase 1: the courtesy-close gate, run through the real router.
// The chat: one of our agents ("recruiter") and another party ("C") that
// may be an agent of another organisation. Neutral ids only.

const GROUP = "120363000000000000@g.us"
const C = { id: "15550100@s.whatsapp.net", name: "C" }
const P = { id: "15550111@s.whatsapp.net", name: "Candidate" }

const tick = () => new Promise((r) => setTimeout(r, 0))

interface World {
  router: MessageRouter
  adapter: ChannelAdapter
  store: SituationStore
  gate: SituationGate
  cfg: SituationsConfig
  sent: OutgoingMessage[]
  reacts: Array<{ chatId: string; messageId: string; emoji?: string }>
  turns: string[]
  hookCalls: number
  hooks: HookRegistry
  dispatcher?: WorkflowDispatcher
  wfStore?: WorkflowStore
  runs?: RunStore
  forwarded: unknown[]
  broadcasts: unknown[]
  /** One inbound message; resolves when the router is done with it. */
  say(from: { id: string; name: string; isBot?: boolean }, text: string, extra?: Partial<IncomingMessage>): Promise<void>
  phase(): string | undefined
}

let n = 0
let dir: string
const cwd = process.cwd()
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agentx-1892-")); process.chdir(dir) })
afterAll(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) })
afterEach(() => { setSendToChatStore(null); setMessageRouter(null) })

function world(opts: {
  channel?: string
  mode?: SituationsConfig["mode"]
  /** The agent's turn: returns the final reply text. */
  reply?: (text: string, w: World) => Promise<string> | string
  workflows?: boolean
  hooks?: boolean
  claimant?: () => { runId: string; kind: string } | null
} = {}): World {
  const channel = opts.channel ?? "whatsapp"
  const db = new Database(":memory:")
  const store = new SituationStore(db)
  const cfg: SituationsConfig = { ...DEFAULT_SITUATIONS_CONFIG, mode: opts.mode ?? "active" }
  const w = { sent: [], reacts: [], turns: [], hookCalls: 0, forwarded: [], broadcasts: [], store, cfg } as unknown as World
  const registry = {
    getAgent: (id: string) => (id === "recruiter" ? { name: "Recruiter", mentions: [] } : undefined),
    getSessionStore: () => ({ addAgentMessage: () => {} }),
    execute: async (req: { message: string }) => {
      w.turns.push(req.message)
      // The turn text starts with the group's recent history; the stub
      // answers the latest message only.
      const latest = req.message.split("\n\n").pop() ?? req.message
      const content = await (opts.reply ?? (() => "Noted."))(latest, w)
      return { content }
    },
  }
  const hooks = new HookRegistry()
  w.hooks = hooks
  const router = new MessageRouter(registry as any, { channels: { telegram: { accounts: {} } }, agents: {} } as any, opts.hooks === false ? undefined : hooks, () => {})
  const adapter = {
    name: channel,
    start: async () => {}, stop: async () => {}, onMessage: () => {},
    send: async (m: OutgoingMessage) => { w.sent.push(m); return `out-${w.sent.length}` },
    react: async (chatId: string, messageId: string, emoji?: string) => { w.reacts.push({ chatId, messageId, emoji }) },
    sendTyping: async () => {},
  } as unknown as ChannelAdapter
  router.addChannel(adapter)
  setMessageRouter(router)
  setSendToChatStore(store)

  if (opts.workflows) {
    const base = resolve(dir, `wf-${++n}`)
    mkdirSync(base, { recursive: true })
    const wfStore = new WorkflowStore({ baseDir: base })
    const runs = new RunStore({ baseDir: base, nodeId: "node-a" })
    const timers = new TimerService({ baseDir: resolve(base, "_timers") })
    const dispatcher = new WorkflowDispatcher({
      store: wfStore, runs, nodeId: "node-a", timers,
      agents: { execute: async () => ({ content: "" }) },
      channels: { [channel]: adapter as any },
      forwarder: {
        forwardTransition: async (peer: string, payload: unknown) => { w.forwarded.push({ peer, payload }) },
        broadcastTrigger: async (p: unknown) => { w.broadcasts.push(p) },
      },
      owner: { notify: async () => {}, ask: async () => ({ cardId: `card-${++n}` }) },
      followUp: () => ({ stallMinutes: 30, maxNudges: 2, approval: "step" as const }),
    } as any)
    Object.assign(w, { dispatcher, wfStore, runs })
    for (const [event, handler] of Object.entries(createWorkflowHookHandlers(dispatcher))) {
      if (handler) hooks.registerHandler(event as any, `workflows:${event}`, handler, 50)
    }
  }
  hooks.registerHandler("pre:channel-message" as any, "spy", async () => { w.hookCalls++; return {} }, 10)

  const gate = new SituationGate({
    store,
    settings: () => w.cfg,
    claimant: () => opts.claimant ? () => opts.claimant!() : w.dispatcher ? (m) => w.dispatcher!.claimantFor(m) : undefined,
  })
  router.setSituationGate(gate)
  Object.assign(w, { router, adapter, gate })

  w.say = async (from, text, extra = {}) => {
    const msg: IncomingMessage = {
      id: `in-${++n}`, channel, accountId: "default", sender: from,
      group: { id: GROUP, name: "Interview" }, text, timestamp: new Date(),
      resolvedAgent: "recruiter", ...extra,
    }
    await (router as any).handleMessage(adapter, msg)
  }
  w.phase = () => store.get(situationKey(channel, "default", GROUP))?.phase
  return w
}

describe("(a) two-agent goodbye: at most one goodbye, then nothing", () => {
  it("goodbye sent as the agent's final reply", async () => {
    const w = world({ channel: "discord", reply: (t) => (/goodbye/i.test(t) ? "Goodbye, and good luck." : "Welcome, let us begin.") })
    const bot = { ...C, isBot: true }
    await w.say(bot, "Hello, I am here for the interview.")
    expect(w.phase()).toBe("during")
    await w.say(bot, "Thank you, goodbye!")
    expect(w.phase()).toBe("ended")
    expect(w.sent.map((m) => m.text)).toEqual(["Welcome, let us begin.", "Goodbye, and good luck."])

    const hooksBefore = w.hookCalls
    for (const t of ["Thank you so much, goodbye!", "Bye! 🙏", "Thanks again, take care"]) await w.say(bot, t)
    expect(w.turns).toHaveLength(2) // zero runs after the goodbye
    expect(w.hookCalls).toBe(hooksBefore) // no hook, so no workflow, saw them
    expect(w.sent).toHaveLength(2)
    expect(w.reacts.filter((r) => r.emoji === "🙏")).toEqual([]) // a bot gets no reaction
    expect(w.store.gateLog().map((r) => r.outcome)).toEqual(["drop", "drop", "drop"])
  })

  it("goodbye sent mid-turn by agentx_channel_reply (channel.reply)", async () => {
    const w = world({
      channel: "discord",
      reply: async (t) => {
        if (!/goodbye/i.test(t)) return "Welcome."
        await channelReply.handler({ channel: "discord", chatId: GROUP, text: "Goodbye!", agentId: "recruiter" } as any)
        return ""
      },
    })
    const bot = { ...C, isBot: true }
    await w.say(bot, "Hello")
    await w.say(bot, "Thank you, goodbye!")
    expect(w.phase()).toBe("ended")
    await w.say(bot, "Goodbye, thank you!")
    expect(w.turns).toHaveLength(2)
    expect(w.sent.map((m) => m.text)).toEqual(["Welcome.", "Goodbye!"])
  })
})

describe("(b) WhatsApp group, C has no isBot", () => {
  it("inbound account 'default', goodbye by channel.reply with no account: same key, same result", async () => {
    const w = world({
      reply: async (t) => {
        if (!/thank you/i.test(t)) return "Welcome."
        await channelReply.handler({ channel: "whatsapp", chatId: GROUP, text: "Goodbye!", agentId: "recruiter" } as any)
        return ""
      },
    })
    await w.say(C, "Hello")
    await w.say(C, "Thank you, goodbye!")
    expect(w.phase()).toBe("ended")
    await w.say(C, "Thank you, goodbye!")
    await w.say(C, "شكرا، مع السلامة")
    expect(w.turns).toHaveLength(2)
    expect(w.sent.map((m) => m.text)).toEqual(["*Recruiter*\n\nWelcome.", "Goodbye!"])
    // C looks like a person on WhatsApp: a reaction, no text, no run (Q2).
    expect(w.reacts.filter((r) => r.emoji === "🙏")).toHaveLength(2)
  })

  it("the plain WhatsApp reply (never streamed) is the goodbye that counts", async () => {
    const w = world({ reply: (t) => (/thank you/i.test(t) ? "Goodbye!" : "Welcome.") })
    await w.say(C, "Hello")
    await w.say(C, "Thank you, goodbye!")
    expect(w.phase()).toBe("ended")
    await w.say(C, "Merci, au revoir !")
    expect(w.turns).toHaveLength(2)
    expect(w.sent).toHaveLength(2)
  })

  it("onPerson: reply lets a person's thanks through; a real message reopens the talk", async () => {
    const w = world({ reply: (t) => (/thank you/i.test(t) ? "Goodbye!" : "Sure.") })
    await w.say(P, "Hello")
    await w.say(P, "Thank you, goodbye!")
    expect(w.phase()).toBe("ended")
    await w.say(P, "One more question: when is the start date?")
    expect(w.phase()).toBe("during")
    expect(w.store.get(situationKey("whatsapp", "default", GROUP))?.endGeneration).toBe(1)
    w.cfg = { ...w.cfg, courtesy: { ...w.cfg.courtesy, onPerson: "reply" } }
    await w.say(P, "Thanks!") // during → ending, passes
    await w.say(P, "Thanks again!") // ended (the reply counted), but onPerson: reply
    expect(w.turns).toHaveLength(5)
  })
})

describe("(c) the goodbye turn in flight", () => {
  it("a courtesy message during the goodbye turn is dropped; a notice in `ending` does not end the talk", async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const w = world({ channel: "discord", reply: async (t) => { if (/bye/i.test(t)) await held; return /bye/i.test(t) ? "Goodbye!" : "Welcome." } })
    const bot = { ...C, isBot: true }
    await w.say(bot, "Hello")
    const turn = w.say(bot, "Thanks, bye!")
    for (let i = 0; i < 20 && w.turns.length < 2; i++) await tick()
    expect(w.phase()).toBe("ending")
    expect(w.store.get(situationKey("discord", "default", GROUP))?.slot).toBe("taken")

    await w.say(bot, "Thank you!")
    expect(w.store.gateLog()[0]?.reason).toBe("ending, goodbye in flight")

    // Router notices (wait line, mesh failure) are not the goodbye.
    const msg = { id: "x", channel: "discord", accountId: "default", sender: bot, group: { id: GROUP, name: "I" }, text: "", timestamp: new Date() }
    ;(w.router as any).notifyMeshFailure(w.adapter, msg, GROUP, "recruiter", "boom")
    await w.router.sendOutbound({ channel: "discord", chatId: GROUP, text: "Your request is queued." })
    await tick()
    expect(w.phase()).toBe("ending")

    release()
    await turn
    expect(w.phase()).toBe("ended")
    expect(w.turns).toHaveLength(2)
  })

  it("a goodbye turn that sends nothing frees the slot again", async () => {
    const w = world({ channel: "discord", reply: (t) => (/bye/i.test(t) ? "" : "Welcome.") })
    const bot = { ...C, isBot: true }
    await w.say(bot, "Hello")
    await w.say(bot, "Thanks, bye!")
    const row = w.store.get(situationKey("discord", "default", GROUP))!
    expect([row.phase, row.slot]).toEqual(["ending", "free"])
  })
})

describe("(d) runs that wait on the chat take their message first", () => {
  async function endTalk(w: World) {
    const key = situationKey("whatsapp", "default", GROUP)
    w.store.create(key, "ended", "test setup", "closed")
  }

  it("a person.wait for the candidate takes the candidate's thanks; C's thanks is judged by the gate", async () => {
    const w = world({ workflows: true })
    w.wfStore!.save(workflowSchema.parse({
      id: "wait-candidate", title: "Wait for the candidate",
      nodes: [
        { id: "start", type: "trigger.manual", config: {} },
        { id: "wait", type: "person.wait", config: { channel: "whatsapp", chatId: GROUP, from: P.id, timeout: "1d" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "start", to: "wait" }, { from: "wait", to: "done" }],
    }))
    const { run } = await w.dispatcher!.startRun({ workflowId: "wait-candidate" })
    for (let i = 0; i < 50 && w.runs!.get(run!.id)?.pausedAt?.kind !== "replyWait"; i++) await new Promise((r) => setTimeout(r, 10))
    await endTalk(w)

    await w.say(C, "Thank you, goodbye!")
    expect(w.store.gateLog()).toHaveLength(1)
    expect(w.runs!.get(run!.id)?.pausedAt?.kind).toBe("replyWait") // not taken by the run
    expect(w.turns).toHaveLength(0)

    await w.say(P, "Thank you, goodbye!")
    expect(w.store.gateLog()).toHaveLength(1) // claimed: the run wins
    for (let i = 0; i < 50 && w.runs!.get(run!.id)?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 10))
    expect(w.runs!.get(run!.id)?.status).toBe("completed")
    expect(w.turns).toHaveLength(0)
  })

  it("a run paused on a checkpoint on the chat gets the message", async () => {
    const w = world({ workflows: true })
    w.wfStore!.save(workflowSchema.parse({
      id: "chat-flow", title: "Chat flow",
      nodes: [
        { id: "t", type: "trigger.channel", config: { source: "whatsapp-message", filter: { chat: GROUP } } },
        { id: "cp", type: "checkpoint", config: { name: "next" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "t", to: "cp" }, { from: "cp", to: "done" }],
    }))
    await w.say(C, "Hello")
    const runId = w.runs!.getActiveByEntity({ backend: "whatsapp", id: `whatsapp:${GROUP}` })!
    for (let i = 0; i < 50 && w.runs!.get(runId)?.pausedAt?.kind !== "checkpoint"; i++) await new Promise((r) => setTimeout(r, 10))
    w.store.move(situationKey("whatsapp", "default", GROUP), { phase: w.store.get(situationKey("whatsapp", "default", GROUP))!.phase, since: w.store.get(situationKey("whatsapp", "default", GROUP))!.phaseChangedAt }, "ended", { why: "test" })

    await w.say(C, "Thanks, goodbye!")
    expect(w.store.gateLog()).toHaveLength(0)
    for (let i = 0; i < 50 && w.runs!.get(runId)?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 10))
    expect(w.runs!.get(runId)?.status).toBe("completed")
  })
})

describe("(g) a workflow person.message goodbye marks the slot", () => {
  it("sent at once (approved at start) through deliver", async () => {
    const w = world()
    w.store.create(situationKey("whatsapp", "default", GROUP), "ending", "test setup")
    const r = await deliver({ channels: { whatsapp: w.adapter as any } }, { channel: "whatsapp", chatId: GROUP, text: "Goodbye!", countsAsReply: true })
    expect("messageId" in r).toBe(true)
    expect(w.phase()).toBe("ended")
  })

  it("sent after the owner's yes: the flag survives the pause (S12)", async () => {
    const w = world({ workflows: true })
    w.wfStore!.save(workflowSchema.parse({
      id: "say-bye", title: "Say goodbye",
      nodes: [
        { id: "start", type: "trigger.manual", config: {} },
        { id: "bye", type: "person.message", config: { channel: "whatsapp", chatId: GROUP, text: "Goodbye from the team." } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "start", to: "bye" }, { from: "bye", to: "done" }],
    }))
    w.store.create(situationKey("whatsapp", "default", GROUP), "ending", "test setup")
    const { run } = await w.dispatcher!.startRun({ workflowId: "say-bye", meta: { followUp: true } as any })
    for (let i = 0; i < 50 && w.runs!.get(run!.id)?.pausedAt?.kind !== "ownerDecision"; i++) await new Promise((r) => setTimeout(r, 10))
    const p = w.runs!.get(run!.id)!.pausedAt as any
    expect(p.message.countsAsReply).toBe(true)
    expect(w.phase()).toBe("ending")
    await w.dispatcher!.resumeFromCard({ id: p.cardId, status: "decided", verdict: "yes", origin: { kind: "workflow", runId: run!.id } })
    expect(w.sent.map((m) => m.text)).toEqual(["Goodbye from the team."])
    expect(w.phase()).toBe("ended")
  })

  it("a reminder to a person does not count", async () => {
    const w = world()
    w.store.create(situationKey("whatsapp", "default", GROUP), "ending", "test setup")
    await deliver({ channels: { whatsapp: w.adapter as any } }, { channel: "whatsapp", chatId: GROUP, text: "Reminder: please answer." })
    expect(w.phase()).toBe("ending")
  })
})

describe("(h) a send for an end that was reopened sends nothing", () => {
  it("the generation check refuses it just before the adapter", async () => {
    const w = world({ reply: () => "Sure." })
    const key = situationKey("whatsapp", "default", GROUP)
    w.store.create(key, "ended", "test setup", "closed")
    const tag = { id: w.store.get(key)!.id, endGeneration: 0 }
    await w.say(P, "Actually, one more question: can we move the call to Monday?") // reopens
    expect(w.store.get(key)!.endGeneration).toBe(1)
    const sentBefore = w.sent.length
    const r = await deliver({ channels: { whatsapp: w.adapter as any } }, { channel: "whatsapp", chatId: GROUP, text: "Thanks for your time, the interview is over.", countsAsReply: true, situation: tag })
    expect("error" in r && r.error).toMatch(/reopened/)
    expect(w.sent).toHaveLength(sentBefore)
    // The same tag with the current generation goes out.
    const ok = await deliver({ channels: { whatsapp: w.adapter as any } }, { channel: "whatsapp", chatId: GROUP, text: "ok", situation: { ...tag, endGeneration: 1 } })
    expect("messageId" in ok).toBe(true)
  })
})

describe("(i) R1 and M1: the claim rule, extracted", () => {
  const save = (w: World, id: string, opts: { passthrough?: boolean; priority?: number } = {}) => w.wfStore!.save(workflowSchema.parse({
    id, title: id, priority: opts.priority ?? 0,
    nodes: [
      { id: "t", type: "trigger.channel", config: { source: "whatsapp-message", filter: { chat: GROUP }, ...(opts.passthrough ? { passthrough: true } : {}) } },
      { id: "cp", type: "checkpoint", config: { name: "next" } },
      { id: "done", type: "end", config: {} },
    ],
    edges: [{ from: "t", to: "cp" }, { from: "cp", to: "done" }],
  }))
  const entity = { backend: "whatsapp", id: `whatsapp:${GROUP}` }
  const key = situationKey("whatsapp", "default", GROUP)
  const pausedRun = async (w: World, wf: string) => {
    const run = w.runs!.create({ workflowId: wf, initialPending: [], entityRef: entity, initialContext: {} })
    w.runs!.recordExecution({ runId: run.id, entry: { at: new Date().toISOString(), nodeId: "cp", inputKeys: [], status: "paused", idempotencyKey: `k-${run.id}` }, nextPending: ["done"], status: "paused", pausedAt: { kind: "checkpoint", nodeId: "cp", checkpointName: "next", resumeMatch: {} } as any })
    return run.id
  }

  it("a passthrough-only claim is no claim: the courtesy message is dropped", async () => {
    const w = world({ workflows: true })
    save(w, "observer", { passthrough: true })
    const runId = await pausedRun(w, "observer")
    w.store.create(key, "ended", "test setup")
    await w.say(C, "Thanks, goodbye!")
    expect(w.store.gateLog()).toHaveLength(1)
    expect(w.runs!.get(runId)?.status).toBe("paused")
    expect(w.turns).toHaveLength(0)
  })

  it("a run homed on a peer is a claim: forwarded, not dropped", async () => {
    const w = world({ workflows: true })
    save(w, "remote-flow")
    // Point the entity at a run whose home is another node.
    const run = w.runs!.create({ workflowId: "remote-flow", initialPending: [], entityRef: entity, initialContext: {} })
    const idx = (w.runs as any).indexPath(entity) as string
    const { writeFileSync } = await import("node:fs")
    writeFileSync(idx, JSON.stringify({ runId: run.id, homeNode: "node-b", updatedAt: new Date().toISOString() }))
    w.store.create(key, "ended", "test setup")
    await w.say(C, "Thanks, goodbye!")
    expect(w.store.gateLog()).toHaveLength(0)
    expect(w.forwarded).toHaveLength(1)
    expect(w.turns).toHaveLength(0)
  })

  it("two matches, no fan-out: only the first decides", async () => {
    const w = world({ workflows: true })
    save(w, "a-first", { passthrough: true, priority: 10 })
    save(w, "b-second", { priority: 1 })
    await pausedRun(w, "b-second")
    w.store.create(key, "ended", "test setup")
    expect(w.dispatcher!.claimantFor({ id: "m", channel: "whatsapp", accountId: "default", sender: C, group: { id: GROUP, name: "I" }, text: "thanks", timestamp: new Date() })).toBeNull()
    await w.say(C, "Thanks, goodbye!")
    expect(w.store.gateLog()).toHaveLength(1)
  })

  it("M1: the claiming run ends between the gate and the hook: no new run, no mesh broadcast, dropped after the hook", async () => {
    const w = world({ workflows: true })
    save(w, "chat-flow")
    const runId = await pausedRun(w, "chat-flow")
    w.store.create(key, "ended", "test setup")
    // Runs before the workflow hook (priority 50): the run ends here.
    w.hooks.registerHandler("pre:channel-message" as any, "ender", async () => { await w.dispatcher!.cancelRun(runId, "test"); return {} }, 20)
    const before = w.runs!.list({ limit: 100 }).length
    await w.say(C, "Thanks, goodbye!")
    expect(w.runs!.list({ limit: 100 })).toHaveLength(before)
    expect(w.broadcasts).toHaveLength(0)
    expect(w.store.gateLog().map((r) => r.reason)).toEqual(["ended (closed), courtesy (after-hook)"])
    expect(w.turns).toHaveLength(0)
  })

  it("M1 in shadow mode: the run starts as today and a would-drop is logged after the hook", async () => {
    const w = world({ workflows: true, mode: "shadow" })
    save(w, "chat-flow")
    const runId = await pausedRun(w, "chat-flow")
    w.store.create(key, "ended", "test setup")
    w.hooks.registerHandler("pre:channel-message" as any, "ender", async () => { await w.dispatcher!.cancelRun(runId, "test"); return {} }, 20)
    const before = w.runs!.list({ limit: 100 }).length
    await w.say(C, "Thanks, goodbye!")
    expect(w.runs!.list({ limit: 100 }).length).toBe(before + 1)
    expect(w.store.gateLog().map((r) => [r.outcome, r.reason])).toEqual([["would-drop", "ended (closed), courtesy (after-hook)"]])
  })

  it("with no pre:channel-message hook registered, the after-hook step still drops it", async () => {
    const w = world({ hooks: false, claimant: () => ({ runId: "r1", kind: "running" }) })
    w.store.create(key, "ended", "test setup")
    await w.say(C, "Thanks, goodbye!")
    expect(w.store.gateLog().map((r) => r.reason)).toEqual(["ended (closed), courtesy (after-hook)"])
    expect(w.turns).toHaveLength(0)
  })
})

describe("shadow mode changes nothing", () => {
  it("logs every would-drop and lets the message through", async () => {
    const w = world({ channel: "discord", mode: "shadow", reply: (t) => (/goodbye/i.test(t) ? "Goodbye!" : "Hi.") })
    const bot = { ...C, isBot: true }
    await w.say(bot, "Hello")
    await w.say(bot, "Thank you, goodbye!")
    await w.say(bot, "Thank you, goodbye!")
    expect(w.turns).toHaveLength(3)
    expect(w.store.gateLog().map((r) => r.outcome)).toEqual(["would-drop"])
  })

  it("mode off: no record, no log", async () => {
    const w = world({ mode: "off" })
    await w.say(C, "Thank you, goodbye!")
    expect(w.phase()).toBeUndefined()
    expect(w.store.gateLog()).toHaveLength(0)
  })
})

describe("bot-to-bot hops pass the gate (S10)", () => {
  it("a hop whose text is a courtesy message after the end is skipped", async () => {
    const w = world({ channel: "discord" })
    ;(w.router as any).config.agents = { recruiter: { mentions: ["@recruiter"] }, scheduler: { name: "Scheduler", mentions: ["@scheduler"] } }
    w.store.create(situationKey("discord", "default", GROUP), "ended", "test setup")
    const orig = { id: "o1", channel: "discord", accountId: "default", sender: P, group: { id: GROUP, name: "I" }, text: "hi", timestamp: new Date() }
    await (w.router as any).handleBotToBotChain(w.adapter, orig, "recruiter", "Thanks @scheduler, goodbye!", "out-9", 0)
    expect(w.turns).toHaveLength(0)
    expect(w.store.gateLog()[0]?.reason).toBe("ended (closed), courtesy (hop)")
  })

  const agents = { recruiter: { mentions: ["@recruiter"] }, scheduler: { name: "Scheduler", mentions: ["@scheduler"] } }
  const orig = { id: "o1", channel: "discord", accountId: "default", sender: P, group: { id: GROUP, name: "I" }, text: "hi", timestamp: new Date() }

  it("hand-offs between our own agents never trip the backstop", async () => {
    const w = world({ channel: "discord", reply: () => "On it." })
    ;(w.router as any).config.agents = agents
    w.cfg = { ...w.cfg, backstop: { count: 3, windowMinutes: 10 } }
    for (let i = 0; i < 6; i++) {
      await (w.router as any).handleBotToBotChain(w.adapter, { ...orig, id: `o${i}` }, "recruiter", `@scheduler please book slot ${i} for the interview panel`, `out-${i}`, 0)
    }
    expect(w.turns).toHaveLength(6)
    expect(w.store.gateLog()).toHaveLength(0)
    expect(w.phase()).toBe("during")
  })

  // #1921: the gate judges the hop's text, not the agent it is for, so a
  // drop holds for every agent the reply mentions: one log row, no turn.
  const three = { ...agents, booker: { name: "Booker", mentions: ["@booker"] } }
  it("active: a dropped hop that mentions two agents starts no turn and logs one row", async () => {
    const w = world({ channel: "discord" })
    ;(w.router as any).config.agents = three
    w.store.create(situationKey("discord", "default", GROUP), "ended", "test setup")
    await (w.router as any).handleBotToBotChain(w.adapter, orig, "recruiter", "Thanks @scheduler and @booker, goodbye!", "out-7", 0)
    expect(w.turns).toHaveLength(0)
    expect(w.store.gateLog()).toHaveLength(1)
  })

  it("active: a hop the gate passes still reaches the first mentioned agent", async () => {
    const w = world({ channel: "discord", reply: () => "Booked." })
    ;(w.router as any).config.agents = three
    w.store.create(situationKey("discord", "default", GROUP), "ended", "test setup")
    await (w.router as any).handleBotToBotChain(w.adapter, orig, "recruiter", "@scheduler @booker please book the panel room for Tuesday", "out-8", 0)
    expect(w.turns).toHaveLength(1)
    expect(w.store.gateLog()).toHaveLength(0)
  })

  it("shadow: a would-drop hop still goes to the first mentioned agent, one row", async () => {
    const w = world({ channel: "discord", mode: "shadow", reply: () => "Bye." })
    ;(w.router as any).config.agents = three
    w.store.create(situationKey("discord", "default", GROUP), "ended", "test setup")
    await (w.router as any).handleBotToBotChain(w.adapter, orig, "recruiter", "Thanks @scheduler and @booker, goodbye!", "out-9", 0)
    expect(w.turns).toHaveLength(1)
    expect(w.store.gateLog().map((r) => r.outcome)).toEqual(["would-drop"])
  })

  it("a hop whose send returned no id still gets its own id", async () => {
    const w = world({ channel: "discord" })
    ;(w.router as any).config.agents = agents
    w.store.create(situationKey("discord", "default", GROUP), "ended", "test setup")
    for (let i = 0; i < 2; i++) await (w.router as any).handleBotToBotChain(w.adapter, orig, "recruiter", "Thanks @scheduler, goodbye!", undefined, 0)
    const rows = w.store.gateLog()
    expect(rows).toHaveLength(2)
    expect(rows[0].messageId).not.toBe(rows[1].messageId)
    expect(rows.every((r) => r.messageId.startsWith("hop:") && !r.messageId.includes("undefined"))).toBe(true)
  })
})

describe("review fixes (#1918)", () => {
  it("fails open: a store that throws lets the message through, in active mode too", async () => {
    const w = world({ channel: "discord", reply: () => "Hi." })
    w.store.create(situationKey("discord", "default", GROUP), "ended", "test setup")
    ;(w.store as any).get = () => { throw new Error("SQLITE_BUSY") }
    await w.say({ ...C, isBot: true }, "Thank you, goodbye!")
    expect(w.turns).toHaveLength(1)
  })

  it("fails open when the claim rule throws", async () => {
    const w = world({ channel: "discord", reply: () => "Hi.", claimant: () => { throw new Error("runs dir unreadable") } })
    w.store.create(situationKey("discord", "default", GROUP), "ended", "test setup")
    await w.say({ ...C, isBot: true }, "Thank you, goodbye!")
    expect(w.turns).toHaveLength(1)
  })

  it("Telegram private chats: ending a talk with bot A does not affect a thanks to bot B", async () => {
    const w = world({ channel: "telegram", reply: () => "Hi." })
    const dm = (accountId: string): Partial<IncomingMessage> => ({ group: undefined, accountId })
    expect(situationKey("telegram", "bot-a", "5550001")).not.toBe(situationKey("telegram", "bot-b", "5550001"))
    w.store.create(situationKey("telegram", "bot-a", "5550001"), "ended", "test setup", "closed")
    const person = { id: "5550001", name: "Pat" }
    await w.say(person, "Thanks, bye!", dm("bot-b"))
    expect(w.turns).toHaveLength(1)
    expect(w.store.gateLog()).toHaveLength(0)
    await w.say(person, "Thanks, bye!", dm("bot-a"))
    expect(w.turns).toHaveLength(1)
    expect(w.store.gateLog()).toHaveLength(1)
  })

  it("a Telegram group message reaching two bot accounts is decided and logged once", async () => {
    const w = world({ channel: "telegram" })
    const grp = { id: "-1001", name: "G" }
    w.store.create(situationKey("telegram", "bot-a", "-1001"), "ended", "test setup", "closed")
    for (const accountId of ["bot-a", "bot-b", "bot-c"]) await w.say(P, "Thank you, goodbye!", { id: "tg-7", group: grp, accountId })
    expect(w.store.gateLog()).toHaveLength(1)
    expect(w.reacts.filter((r) => r.emoji === "🙏")).toHaveLength(1)
    expect(w.turns).toHaveLength(0)
  })

  it("the same in shadow mode: one would-drop row", async () => {
    const w = world({ channel: "telegram", mode: "shadow" })
    const grp = { id: "-1001", name: "G" }
    w.store.create(situationKey("telegram", "bot-a", "-1001"), "ended", "test setup", "closed")
    for (const accountId of ["bot-a", "bot-b"]) await w.say(P, "Thank you, goodbye!", { id: "tg-8", group: grp, accountId })
    expect(w.store.gateLog().map((r) => r.outcome)).toEqual(["would-drop"])
  })

  it("a goodbye that asks a question does not end the talk; the answer reaches the agent", async () => {
    const w = world({ channel: "discord", reply: (t) => (/bye/i.test(t) ? "Goodbye! Shall I send you the contract?" : "Sure.") })
    const bot = { ...C, isBot: true }
    await w.say(bot, "Hello")
    await w.say(bot, "Thanks, bye!")
    expect(w.phase()).toBe("during")
    await w.say(bot, "Thank you!")
    expect(w.turns).toHaveLength(3)
  })
})

describe("keys and the backstop", () => {
  it("S15: one Telegram group message reaching two bot accounts gives one record", () => {
    const w = world({ channel: "telegram" })
    const m = (accountId: string) => ({ id: "7", channel: "telegram", accountId, sender: P, group: { id: "-1001", name: "G" }, text: "hello", timestamp: new Date() })
    for (const a of ["bot-a", "bot-b"]) w.gate.commit(w.gate.decide(m(a)))
    expect(situationKey("telegram", "bot-a", "-1001")).toBe(situationKey("telegram", "bot-b", "-1001"))
    expect(w.store.get(situationKey("telegram", "bot-a", "-1001"))?.phase).toBe("during")
  })

  it("WhatsApp: account missing or 'default', chat in any form, one key", () => {
    expect(situationKey("whatsapp", undefined, "120363000000000000")).toBe(situationKey("whatsapp", "default", GROUP))
  })

  it("past the backstop, messages from a bot are dropped even when they are not courtesy", async () => {
    const w = world({ channel: "discord" })
    w.cfg = { ...w.cfg, backstop: { count: 3, windowMinutes: 10 } }
    const bot = { ...C, isBot: true }
    for (let i = 0; i < 5; i++) await w.say(bot, `Here is update number ${i} for the report you asked about`)
    expect(w.turns).toHaveLength(3)
    expect(w.phase()).toBe("ended")
    expect(w.store.get(situationKey("discord", "default", GROUP))?.endReason).toBe("courtesy loop")
    // A person is never held by the backstop.
    await w.say(P, "Please send the final report now, with all the numbers")
    expect(w.turns).toHaveLength(4)
  })

  it("a replayed message is never dropped and counted once (S8)", async () => {
    const w = world({ channel: "discord" })
    w.store.create(situationKey("discord", "default", GROUP), "ended", "test setup")
    const msg: IncomingMessage = { id: "r1", channel: "discord", accountId: "default", sender: { ...C, isBot: true }, group: { id: GROUP, name: "I" }, text: "Thanks, bye!", timestamp: new Date(), resolvedAgent: "recruiter" }
    await (w.router as any).handleMessage(w.adapter, msg, { replay: true })
    expect(w.turns).toHaveLength(1)
  })
})

describe("situation release", () => {
  it("re-delivers a dropped message once and reopens the talk", async () => {
    const w = world({ reply: () => "Here is the answer." })
    const key = situationKey("whatsapp", "default", GROUP)
    w.store.create(key, "ended", "test setup")
    await w.say(C, "Thank you, goodbye!")
    const row = w.store.gateLog()[0]
    expect(row.outcome).toBe("drop")
    const r = w.gate.release(row.id)
    expect(r.ok).toBe(true)
    w.router.redeliver((r as any).message)
    for (let i = 0; i < 50 && w.turns.length === 0; i++) await tick()
    expect(w.turns).toHaveLength(1)
    expect(w.phase()).toBe("during")
    expect(w.gate.release(row.id)).toEqual({ ok: false, error: `row ${row.id} was already released` })
  })
})
