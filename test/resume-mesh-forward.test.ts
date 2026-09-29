import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { recordTraceStart, takeInterruptedRuns, type InterruptedRun } from "../src/storage/traces"
import { DEFAULT_RESUME_SETTINGS, planResume } from "../src/agents/resume/policy"
import { parseOrigin, serializeOrigin, type MeshOrigin } from "../src/agents/resume/origin"
import { RESUMED_TEXT, ResumeCoordinator } from "../src/agents/resume/coordinator"
import { createMeshResumer, findReplyPeer, forwardedTaskAnswer, meshOriginFromTask, type MeshPeerRef } from "../src/agents/resume/mesh-resumer"
import { MessageRouter } from "../src/channels/router"

// #311 — a GitLab task clawd-server forwarded to the Mac, cut off by a
// restart on the Mac, is resumed there and answered through clawd-server.

let tmp: string
beforeEach(() => { closeDb(); tmp = mkdtempSync(path.join(tmpdir(), "agentx-resume-mesh-")) })
afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

const NOW = Date.parse("2026-09-29T12:00:00.000Z")
const forwardBody = {
  agent: "coder-agent",
  message: "@coder review this MR",
  context: { channel: "gitlab", chatId: "mtgl:mr:77", sender: "saber" },
  replyVia: { node: "clawd-server", messageId: "note-9", accountId: "noqta" },
}
const origin = meshOriginFromTask(forwardBody, "coder-agent")!

const server: MeshPeerRef = { peer: "server", peerUrl: "http://server", healthy: true, channels: ["gitlab", "whatsapp"], node: "clawd-server" }
const other: MeshPeerRef = { peer: "other", peerUrl: "http://other", healthy: true, channels: ["gitlab"], node: "other-box" }

function run(over: Partial<InterruptedRun> = {}): InterruptedRun {
  return {
    taskId: "t1", agentId: "coder-agent", channel: "gitlab", chatId: "mtgl:mr:77", workflowRunId: null,
    startedAt: NOW - 5 * 60_000, originalMessage: "@coder review this MR",
    resumeOrigin: serializeOrigin(origin), resumeAttempt: 0, toolCalls: [], ...over,
  }
}

function setup(runs: InterruptedRun[]) {
  const db = openDb({ path: path.join(tmp, "db.sqlite") })!
  for (const r of runs) recordTraceStart(db, { agentId: r.agentId }, r.taskId)
  takeInterruptedRuns(db, NOW)
  return db
}

describe("mesh origin", () => {
  it("is recorded for a forward that says where to reply, and survives the journal", () => {
    expect(origin).toEqual({
      kind: "mesh", node: "clawd-server", channel: "gitlab", chatId: "mtgl:mr:77",
      agentId: "coder-agent", replyTo: "note-9", accountId: "noqta", context: forwardBody.context,
    })
    expect(parseOrigin(serializeOrigin(origin))).toEqual(origin)
  })
  it("is not recorded for other /task callers", () => {
    expect(meshOriginFromTask({ ...forwardBody, replyVia: undefined }, "coder-agent")).toBeUndefined()
    expect(meshOriginFromTask({ ...forwardBody, context: { channel: "gitlab" } }, "coder-agent")).toBeUndefined()
  })
})

describe("planResume, forwarded runs", () => {
  const plan = (r: InterruptedRun) => planResume([r], DEFAULT_RESUME_SETTINGS, { now: NOW, boots: [NOW] })[0]

  it("resumes a forwarded gitlab run whose origin carries the forwarding peer", () => {
    expect(plan(run())).toMatchObject({ action: "resume", origin: { kind: "mesh", node: "clawd-server" } })
  })
  it("still reports a direct gitlab run", () => {
    expect(plan(run({ resumeOrigin: serializeOrigin({ kind: "direct" }) }))).toMatchObject({ action: "report" })
  })
})

describe("mesh resumer", () => {
  it("prefers the forwarding node, then any healthy peer hosting the channel", () => {
    expect(findReplyPeer(origin, [other, server])?.peer).toBe("server")
    expect(findReplyPeer(origin, [other, { ...server, healthy: false }])?.peer).toBe("other")
    expect(findReplyPeer(origin, [{ ...other, channels: ["telegram"] }])).toBeNull()
  })

  it("sends the answer and the notice to the forwarding peer, as the agent, threaded", async () => {
    const sent: Array<{ peer: string; body: Record<string, unknown> }> = []
    const execute = vi.fn(async () => ({ content: "LGTM with one nit" }))
    const resumer = createMeshResumer({
      peers: () => [other, server],
      send: async (p, body) => { sent.push({ peer: p.peer, body }) },
      execute,
      log: () => {},
    })
    const c = new ResumeCoordinator()
    c.register("mesh", resumer)
    const outcomes = await c.run({ db: setup([run()]), runs: [run()], settings: DEFAULT_RESUME_SETTINGS, now: NOW, boots: [NOW], log: () => {} })
    expect(outcomes[0].decision).toBe("resumed")
    await vi.waitFor(() => expect(sent).toHaveLength(2))

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ agentId: "coder-agent", origin, attempt: 1, resumedFrom: "t1" }))
    const common = { channel: "gitlab", chatId: "mtgl:mr:77", replyTo: "note-9", accountId: "noqta", agentId: "coder-agent" }
    expect(sent[0]).toEqual({ peer: "server", body: { ...common, text: RESUMED_TEXT } })
    expect(sent[1]).toEqual({ peer: "server", body: { ...common, text: "LGTM with one nit" } })
  })

  it("posts the cut-off notice to the forwarding peer when the run is only reported", async () => {
    const sent: string[] = []
    const c = new ResumeCoordinator()
    c.register("mesh", createMeshResumer({
      peers: () => [server], send: async (p, body) => { sent.push(`${p.peer}:${body.text}`) },
      execute: async () => ({ content: "" }), log: () => {},
    }))
    const old = run({ startedAt: NOW - 60 * 60_000 })
    const notify = vi.fn(async () => {})
    const outcomes = await c.run({ db: setup([old]), runs: [old], settings: DEFAULT_RESUME_SETTINGS, now: NOW, boots: [NOW], log: () => {}, notifyOperator: notify })
    expect(outcomes[0].decision).toBe("reported")
    expect(sent).toEqual([expect.stringMatching(/^server:AgentX restarted .*wasn't picked up again/)])
    expect(notify).not.toHaveBeenCalled()
  })

  it("falls back to the operator report when no peer can deliver", async () => {
    const execute = vi.fn(async () => ({ content: "never" }))
    const c = new ResumeCoordinator()
    c.register("mesh", createMeshResumer({
      peers: () => [{ ...server, healthy: false }], send: async () => {}, execute, log: () => {},
    }))
    const notify = vi.fn(async () => {})
    const outcomes = await c.run({ db: setup([run()]), runs: [run()], settings: DEFAULT_RESUME_SETTINGS, now: NOW, boots: [NOW], log: () => {}, notifyOperator: notify })
    expect(outcomes[0].decision).toBe("resume-failed")
    expect(execute).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no healthy mesh peer"))
  })
})

describe("the forwarding node while the receiver restarts", () => {
  const interrupted = { content: "", error: "AgentX restarted", errorKind: "interrupted" }

  it("answers a cut-off forward as accepted, and leaves everything else alone", () => {
    expect(forwardedTaskAnswer(interrupted, origin).error).toBe("__queued__:resuming:1")
    expect(forwardedTaskAnswer(interrupted, undefined)).toBe(interrupted)
    const failed = { content: "", error: "Claude Code timed out" }
    expect(forwardedTaskAnswer(failed, origin)).toBe(failed)
  })

  it("posts no ❌ and no \"Nothing is retrying\" notice", async () => {
    // What mesh.sendTask throws for the receiver's 500 { error } answer.
    const thrown = `Peer "mac" /task error: 500: ${forwardedTaskAnswer(interrupted, origin).error}`
    const adapter = { name: "gitlab", send: vi.fn(async () => "note-1"), react: vi.fn(), sendTyping: vi.fn() }
    const router = new MessageRouter({ getAgent: () => undefined } as any, { channels: {} } as any, undefined, () => {})
    router.setMesh({
      directory: () => [{ peer: "mac", peerUrl: "u", healthy: true, skills: [{ id: "coder-agent", name: "coder-agent" }], channels: [] }],
      findAgentPeer: (id: string) => (id === "coder-agent" ? { peer: "mac", healthy: true } : undefined),
      sendTask: vi.fn(async () => { throw new Error(thrown) }),
      onPeerChange: () => {},
    } as any)
    const msg = {
      id: "note-9", channel: "gitlab", accountId: "noqta", text: "@coder review this MR",
      sender: { id: "u1", name: "Sam Example", isBot: false }, group: { id: "mtgl:mr:77", name: "mtgl" },
    } as any
    await (router as any).processResolvedMessage(adapter, msg, "coder-agent", "mtgl:mr:77")

    expect(adapter.react.mock.calls.filter((c: any[]) => c.includes("❌"))).toHaveLength(0)
    expect(adapter.send).not.toHaveBeenCalled()
  })
})
