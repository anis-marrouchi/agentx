import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { acceptedBody, CallbackReplies, callerHintFrom, createDelegations, cycleRefusal, meshTaskMode, resolveCallerTurn, SyncWaits, type CallerHint } from "../src/daemon/delegation-wiring"
import { getEventBus } from "../src/events/bus"
import { persistentCallerEnv } from "../src/agents/claude-process-factory"
import { callerFields } from "../src/mcp/index"
import { daemonConfigSchema } from "../src/daemon/config"

const running = new Map<string, { agentId: string; channel: string; chatId: string; context: Record<string, unknown> }>([
  ["run-1", { agentId: "front", channel: "telegram", chatId: "chat-1", context: { channel: "telegram", chatId: "chat-1", sender: "Sam" } }],
  ["run-2", { agentId: "front", channel: "cron", chatId: "daily", context: { channel: "cron", chatId: "daily" } }],
  ["run-3", { agentId: "solo", channel: "app", chatId: "p1", context: { channel: "app", chatId: "p1" } }],
])
const fakeRegistry = {
  runningTaskOwner: (id: string) => {
    const r = running.get(id)
    return r ? { agentId: r.agentId, channel: r.channel, chatId: r.chatId } : null
  },
  findRunningTurn: (agentId: string, by: { taskId?: string; channel?: string; chatId?: string } = {}) => {
    const mine = [...running.entries()].filter(([, r]) => r.agentId === agentId)
    let hit: [string, any] | undefined
    if (by.taskId) hit = mine.find(([id]) => id === by.taskId)
    else if (by.channel && by.chatId) hit = mine.find(([, r]) => r.channel === by.channel && r.chatId === by.chatId)
    else if (mine.length === 1) hit = mine[0]
    return hit ? { taskId: hit[0], context: hit[1].context } : null
  },
}

const hint = (h: Partial<CallerHint>): CallerHint => ({ meshForwarded: false, local: true, ...h })

describe("resolveCallerTurn", () => {
  it("finds the turn named by its task id", () => {
    expect(resolveCallerTurn(hint({ callerTaskId: "run-1" }), fakeRegistry as any)).toMatchObject({ agentId: "front", taskId: "run-1" })
    expect(resolveCallerTurn(hint({ callerTaskId: "run-1", senderAgentId: "front" }), fakeRegistry as any)?.taskId).toBe("run-1")
  })

  it("refuses a task id that belongs to another agent or is not running", () => {
    expect(resolveCallerTurn(hint({ callerTaskId: "run-1", senderAgentId: "someone-else" }), fakeRegistry as any)).toBeNull()
    expect(resolveCallerTurn(hint({ callerTaskId: "gone" }), fakeRegistry as any)).toBeNull()
  })

  it("finds a warm process's turn by agent and chat", () => {
    expect(resolveCallerTurn(hint({ senderAgentId: "front", callerChannel: "cron", callerChatId: "daily" }), fakeRegistry as any)?.taskId).toBe("run-2")
  })

  it("never guesses a turn from the agent id alone", () => {
    // A same-host proxy also arrives over loopback: an agent with a single
    // running turn must not be matched to its request.
    expect(resolveCallerTurn(hint({ senderAgentId: "solo" }), fakeRegistry as any)).toBeNull()
    expect(resolveCallerTurn(hint({ senderAgentId: "front", callerChannel: "telegram" }), fakeRegistry as any)).toBeNull()
  })

  it("never names a turn for a mesh-forwarded or remote request", () => {
    expect(resolveCallerTurn(hint({ callerTaskId: "run-1", meshForwarded: true }), fakeRegistry as any)).toBeNull()
    expect(resolveCallerTurn(hint({ callerTaskId: "run-1", local: false }), fakeRegistry as any)).toBeNull()
    expect(resolveCallerTurn(hint({}), fakeRegistry as any)).toBeNull()
  })
})

describe("callerHintFrom", () => {
  const req = (addr: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: addr } }) as any

  it("reads body fields and the X-AgentX-Task header", () => {
    expect(callerHintFrom(req("127.0.0.1"), { senderAgentId: "front", callerChannel: "telegram", callerChatId: "chat-1" }))
      .toEqual({ senderAgentId: "front", callerTaskId: undefined, callerChannel: "telegram", callerChatId: "chat-1", meshForwarded: false, local: true })
    expect(callerHintFrom(req("::1", { "x-agentx-task": "run-1" }), {}).callerTaskId).toBe("run-1")
  })

  it("marks peer forwards and remote callers", () => {
    expect(callerHintFrom(req("127.0.0.1"), { parentEventId: "evt" }).meshForwarded).toBe(true)
    expect(callerHintFrom(req("192.0.2.10"), {}).local).toBe(false)
  })
})

describe("synchronous cycles", () => {
  const slots = (held: Record<string, string[]>, full = true) => ({
    slotHolders: (agent: string) => (held[agent] ? { full, runIds: held[agent] } : { full: false, runIds: [] }),
  })

  it("refuses an agent asking itself", () => {
    const waits = new SyncWaits()
    expect(cycleRefusal("front", { senderAgentId: "front", meshForwarded: false }, null, slots({}), waits)).toMatch(/itself/)
    expect(cycleRefusal("front", { meshForwarded: false }, { agentId: "front", taskId: "t", context: {} }, slots({}), waits)).toMatch(/itself/)
    // A peer's own agent of the same name is another agent.
    expect(cycleRefusal("front", { senderAgentId: "front", meshForwarded: true }, null, slots({}), waits)).toBeNull()
  })

  it("fails fast on A -> B -> A when A's only slot waits on B", () => {
    const waits = new SyncWaits()
    waits.begin("run-a", "run-b") // A's turn waits on B's run
    const b = { agentId: "worker", taskId: "run-b", context: {} }
    expect(cycleRefusal("front", { meshForwarded: false }, b, slots({ front: ["run-a"] }), waits)).toMatch(/waiting on this request/)
    // Longer chains too: A waits on B, B on C, C asks A.
    waits.begin("run-b", "run-c")
    expect(cycleRefusal("front", { meshForwarded: false }, { agentId: "helper", taskId: "run-c", context: {} }, slots({ front: ["run-a"] }), waits)).toMatch(/waiting/)
  })

  it("lets it wait when a slot is free or held by unrelated work", () => {
    const waits = new SyncWaits()
    waits.begin("run-a", "run-b")
    const b = { agentId: "worker", taskId: "run-b", context: {} }
    expect(cycleRefusal("front", { meshForwarded: false }, b, slots({ front: ["run-a"] }, false), waits)).toBeNull()
    expect(cycleRefusal("front", { meshForwarded: false }, b, slots({ front: ["run-a", "run-other"] }), waits)).toBeNull()
    waits.end("run-b")
    expect(cycleRefusal("front", { meshForwarded: false }, b, slots({ front: ["run-a"] }), waits)).toBeNull()
  })
})

describe("meshTaskMode", () => {
  it("keeps the legacy async delivery for a request that names its own chat", () => {
    const body = { peer: "vps", agent: "builder", message: "x", async: true, context: { channel: "telegram", chatId: "chat-1" } }
    expect(meshTaskMode(body, true)).toBe("legacy-async")
    expect(meshTaskMode({ ...body, async: undefined }, true)).toBe("sync")
  })

  it("calls back only for a request with no chat of its own", () => {
    expect(meshTaskMode({ peer: "vps", agent: "builder", message: "x" }, true)).toBe("callback")
    expect(meshTaskMode({ peer: "vps", agent: "builder", message: "x", context: { channel: "mcp" } }, true)).toBe("callback")
    // No named agent: the peer picks its first one, so no callback.
    expect(meshTaskMode({ peer: "vps", message: "x" }, true)).toBe("sync")
    // Not allowed: an async:true without a chat still reaches the legacy
    // branch, which refuses it for having no route back.
    expect(meshTaskMode({ peer: "vps", agent: "builder", message: "x", async: true }, false)).toBe("legacy-async")
  })
})

describe("CallbackReplies", () => {
  it("is bounded, caps the text and expires", () => {
    let now = 0
    const r = new CallbackReplies(2, 1000, () => now)
    r.put({ taskId: "a", channel: "app", chatId: "app:c1", agent: "x", text: "y".repeat(40_000), status: "done", plain: false })
    expect(r.get("a")!.text.length).toBe(32_000)
    r.put({ taskId: "b", channel: "app", chatId: "app:c1", agent: "x", text: "b", status: "done", plain: false })
    r.put({ taskId: "c", channel: "app", chatId: "app:c1", agent: "x", text: "c", status: "done", plain: false })
    expect(r.get("a")).toBeNull()
    now = 2000
    expect(r.get("c")).toBeNull()
  })
})

describe("acceptedBody", () => {
  it("tells the agent to report and end its turn", () => {
    const b = acceptedBody("dlg-1", "builder", "vps")
    expect(b).toMatchObject({ accepted: true, mode: "callback", taskId: "dlg-1", agent: "builder", peer: "vps" })
    expect(String(b.note)).toMatch(/end your turn/)
  })
})

describe("createDelegations wiring", () => {
  function wire(channels: string[], peerAnswer?: (ctx: any) => string) {
    const dir = mkdtempSync(join(tmpdir(), "agentx-dlgw-"))
    const config = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: { front: { name: "Front", workspace: dir } } })
    const executed: any[] = []
    const recorded: any[] = []
    const replies = new CallbackReplies()
    const sent: Array<{ msg: any; opts: any }> = []
    const peerCalls: any[] = []
    const registry = {
      execute: async (task: any) => {
        executed.push(task)
        task.onStart?.("run-x")
        return task.agentId === "front" ? { content: "Here is what came back." } : { content: "worker answer" }
      },
      cancelRunningTask: () => null,
      isChatBusy: () => false,
      getSessionStore: () => ({ addAgentMessage: (...a: any[]) => recorded.push(a) }),
    }
    const router = {
      getChannel: (n: string) => (channels.includes(n) ? { name: n } : undefined),
      sendOutbound: async (msg: any, opts: any) => { sent.push({ msg, opts }) },
    }
    const mesh = {
      sendTask: async (peer: string, text: string, agent: string, opts: any) => {
        peerCalls.push({ peer, text, agent, opts })
        return peerAnswer ? peerAnswer(opts.context) : "peer answer"
      },
    }
    const mgr = createDelegations({ config, registry: registry as any, router: router as any, mesh: () => mesh as any, log: () => {}, replies, baseDir: dir })
    return { mgr, executed, sent, peerCalls, replies, recorded, cleanup: () => { mgr.stop(); rmSync(dir, { recursive: true, force: true }) } }
  }
  const human = { agentId: "front", taskId: "run-1", context: { channel: "telegram", chatId: "chat-1", sender: "Sam" } }

  it("runs a local callee through the registry with a fresh session, then replies on the channel", async () => {
    const w = wire(["telegram"])
    try {
      const { taskId } = w.mgr.start({ caller: human, callee: "worker", message: "Check it", extras: { intentRef: { eventId: "e1", decidedBy: "mesh" } } })
      await new Promise((r) => setTimeout(r, 10))
      expect(w.executed[0]).toMatchObject({ agentId: "worker", freshSession: true, timeoutMinutes: 30, intentRef: { eventId: "e1" } })
      expect(w.executed[1]).toMatchObject({ agentId: "front", context: { channel: "telegram", chatId: "chat-1", delegation: { taskId } } })
      expect(w.sent).toEqual([{
        msg: { channel: "telegram", chatId: "chat-1", text: "Here is what came back.", agentId: "front", accountId: undefined },
        opts: { recordInSession: false },
      }])
    } finally { w.cleanup() }
  })

  it("sends a mesh-peer callee through mesh.sendTask with the root in the context", async () => {
    const w = wire(["telegram"], (ctx) => `seen root ${ctx.initiator.kind}`)
    try {
      w.mgr.start({ caller: human, callee: "builder", peer: "vps", message: "Fix CI" })
      await new Promise((r) => setTimeout(r, 10))
      expect(w.peerCalls[0]).toMatchObject({ peer: "vps", agent: "builder", text: "Fix CI", opts: { senderAgentId: "front", timeoutMs: 30 * 60_000 } })
      expect(w.executed[0].agentId).toBe("front")
      expect(w.executed[0].message).toContain("seen root human")
      expect(w.sent[0].msg.channel).toBe("telegram")
    } finally { w.cleanup() }
  })

  it("holds a phone-app reply for the dashboard and announces it on the bus", async () => {
    // No push, no adapter: the phone thread is the route.
    const w = wire([])
    const seen: any[] = []
    const off = getEventBus().subscribe?.((e: any) => { if (e.kind === "delegation") seen.push(e) })
    try {
      const phone = { agentId: "front", taskId: "run-9", context: { channel: "app", chatId: "app:cabc12345", sender: "operator" } }
      expect(w.mgr.shouldCallback(phone)).toBe(true)
      const { taskId } = w.mgr.start({ caller: phone, callee: "worker", message: "x" })
      await new Promise((r) => setTimeout(r, 10))
      // Nothing sent through a channel; no generic push.
      expect(w.sent).toEqual([])
      expect(w.replies.get(taskId)).toMatchObject({ taskId, channel: "app", chatId: "app:cabc12345", agent: "front", text: "Here is what came back.", status: "done", plain: false })
      const recent = getEventBus().recent({ kind: "delegation" }).filter((e) => e.ref === taskId)
      expect(recent).toHaveLength(1)
      expect(recent[0]).toMatchObject({ type: "reply", agentId: "front" })
      // The envelope carries a summary, never the whole reply.
      expect(recent[0].summary.length).toBeLessThanOrEqual(280)
      // The turn's own reply is already in the session.
      expect(w.recorded).toEqual([])
    } finally { if (typeof off === "function") off(); w.cleanup() }
  })

  it("sends voice and dashboard-chat replies as a push, when push is set up", async () => {
    const w = wire(["push"])
    try {
      const voice = { agentId: "front", taskId: "run-9", context: { channel: "voice", chatId: "voice:front" } }
      expect(w.mgr.shouldCallback(voice)).toBe(true)
      w.mgr.start({ caller: voice, callee: "worker", message: "x" })
      await new Promise((r) => setTimeout(r, 10))
      expect(w.sent[0]).toEqual({ msg: { channel: "push", chatId: "default", text: "Front: Here is what came back." }, opts: { recordInSession: false } })
      expect(w.mgr.shouldCallback({ agentId: "front", context: { channel: "dashboard", chatId: "assistant" } })).toBe(true)
    } finally { w.cleanup() }
  })

  it("stays synchronous for voice when push is not set up", () => {
    const w = wire(["telegram"])
    try {
      expect(w.mgr.shouldCallback({ agentId: "front", context: { channel: "voice", chatId: "voice:front" } })).toBe(false)
    } finally { w.cleanup() }
  })

  it("reads the delegation settings", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(cfg.mesh.delegation).toEqual({ asyncWhenHuman: true, timeoutMinutes: 30 })
  })
})

describe("caller identity for the tools an agent launches", () => {
  it("gives a warm process the agent and chat it serves, never a stale task id", () => {
    const env = persistentCallerEnv({ AGENTX_TASK_ID: "old" }, { agentId: "front", channel: "telegram", chatId: "chat-1" })
    expect(env).toEqual({ AGENTX_AGENT_ID: "front", AGENTX_CHANNEL: "telegram", AGENTX_CHAT_ID: "chat-1" })
  })

  it("passes the runtime's caller variables to the daemon", () => {
    expect(callerFields({ AGENTX_TASK_ID: "run-1", AGENTX_CHANNEL: "telegram", AGENTX_CHAT_ID: "chat-1" }))
      .toEqual({ callerTaskId: "run-1", callerChannel: "telegram", callerChatId: "chat-1" })
    expect(callerFields({})).toEqual({})
  })
})
