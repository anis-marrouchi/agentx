import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, rmSync } from "fs"
import { resolve } from "path"
import {
  RunStore,
  WorkflowStore,
  WorkflowDispatcher,
  nextNodes,
  workflowSchema,
  type AgentExecuteRequest,
  type AgentExecuteResponse,
  type WorkflowRun,
} from "../src/workflows"
import { TimerService, type TimerRecord } from "../src/workflows/timers"
import { durationMs } from "../src/workflows/nodes/follow-up"
import type { OwnerCardInput } from "../src/workflows/nodes/types"

// Follow-up workflows (#788): owner steps, messages to people with
// approval, waiting for a reply, supervised agent steps with nudges, and
// one summary at the end.

const TEST_DIR = resolve(__dirname, "../.test-workflow-follow-up")

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface Harness {
  dispatcher: WorkflowDispatcher
  runs: RunStore
  store: WorkflowStore
  timers: TimerService
  sends: Array<{ channel: string; chatId: string; text: string }>
  told: string[]
  cards: Array<{ cardId: string; input: OwnerCardInput; runId: string; nodeId: string }>
  turns: AgentExecuteRequest[]
  ended: WorkflowRun[]
  blocked: Array<{ nodeId: string; reason: string }>
  /** Fire the run's pending timer as if it were due. */
  fire(runId: string): Promise<void>
}

function harness(reply: (req: AgentExecuteRequest) => string, settings = { stallMinutes: 30, maxNudges: 2, approval: "step" as "step" | "start" }): Harness {
  const store = new WorkflowStore({ baseDir: TEST_DIR })
  const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
  const timers = new TimerService({ baseDir: resolve(TEST_DIR, "_timer-base") })
  const h = {
    sends: [], told: [], cards: [], turns: [], ended: [], blocked: [],
  } as unknown as Harness
  const agents = {
    execute: async (req: AgentExecuteRequest): Promise<AgentExecuteResponse> => {
      h.turns.push(req)
      return { content: reply(req) }
    },
  }
  let n = 0
  const dispatcher = new WorkflowDispatcher({
    store, runs, nodeId: "node-a", timers, agents,
    channels: { telegram: { send: async (m: { channel: string; chatId: string; text: string }) => { h.sends.push(m); return `m${h.sends.length}` } } },
    owner: {
      notify: async (text) => { h.told.push(text) },
      ask: async (input, run, nodeId) => {
        const cardId = `card-${++n}`
        h.cards.push({ cardId, input, runId: run.id, nodeId })
        return { cardId }
      },
    },
    followUp: () => settings,
    onRunEnded: (run) => { h.ended.push(run) },
    onBlocked: (_run, _wf, nodeId, reason) => { h.blocked.push({ nodeId, reason }) },
  })
  Object.assign(h, { dispatcher, runs, store, timers })
  h.fire = async (runId: string) => {
    const t = timers.list().find((x) => x.runId === runId)
    if (!t) throw new Error(`no timer for ${runId}`)
    timers.cancel({ cancelKey: t.cancelKey })
    // The tick loop calls this once the timer is due: the clock reads its time.
    const realNow = Date.now
    Date.now = () => Date.parse(t.fireAt) + 1
    try {
      await (dispatcher as unknown as { resumeFromTimer(t: TimerRecord): Promise<void> }).resumeFromTimer(t)
    } finally {
      Date.now = realNow
    }
  }
  return h
}

/** The release case: build, verify, tell the client, tell the owner. */
function saveRelease(store: WorkflowStore, extra: Record<string, unknown> = {}) {
  store.save(workflowSchema.parse({
    id: "release-follow-up", version: 2, title: "Release and tell the client",
    nodes: [
      { id: "start", type: "trigger.manual", config: {} },
      { id: "deploy", type: "agent", config: { agentId: "builder", prompt: "Deploy {{start.release}}" } },
      { id: "verify", type: "agent", config: { agentId: "checker", prompt: "Check {{start.url}} serves {{start.release}}" } },
      { id: "tell_client", type: "person.message", config: { to: "the client", channel: "telegram", chatId: "client-1", text: "Release {{start.release}} is live." } },
      { id: "client_reply", type: "person.wait", config: { reminds: "tell_client", timeout: "2d", remindAfter: "4h", maxReminders: 1 } },
      { id: "tell_owner", type: "owner.notify", config: { text: "Client answered: {{client_reply.text}}" } },
      { id: "done", type: "end", config: {} },
    ],
    flow: undefined,
    edges: [
      { from: "start", to: "deploy" },
      { from: "deploy", to: "verify" },
      { from: "verify", to: "tell_client" },
      { from: "tell_client", to: "client_reply" },
      { from: "client_reply", to: "tell_owner" },
      { from: "tell_owner", to: "done" },
    ],
    ...extra,
  }))
}

beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

describe("follow-up ports", () => {
  it("an edge without a port leaves on the main port only", () => {
    const wf = workflowSchema.parse({
      id: "p", title: "p",
      nodes: [
        { id: "t", type: "trigger.manual" },
        { id: "ask", type: "owner.ask", config: { ask: "ok?" } },
        { id: "yes", type: "end" },
        { id: "no", type: "end" },
      ],
      edges: [{ from: "t", to: "ask" }, { from: "ask", to: "yes" }, { from: "ask", fromPort: "no", to: "no" }],
    })
    expect(nextNodes({ workflow: wf, fromNodeId: "ask", selectedPort: "yes" }).nextPending).toEqual(["yes"])
    expect(nextNodes({ workflow: wf, fromNodeId: "ask", selectedPort: "no" }).nextPending).toEqual(["no"])
    expect(nextNodes({ workflow: wf, fromNodeId: "ask", selectedPort: "expired" }).nextPending).toEqual([])
  })

  it("reads durations in minutes, short and ISO form", () => {
    expect(durationMs(30)).toBe(1_800_000)
    expect(durationMs("4h")).toBe(14_400_000)
    expect(durationMs("2d")).toBe(172_800_000)
    expect(durationMs("PT1H")).toBe(3_600_000)
    expect(durationMs("soon")).toBeNull()
  })
})

describe("a release followed from start to end", () => {
  it("runs each step on its own, sends the approved message once, waits for the reply, and sums up once", async () => {
    const h = harness(() => "Done.\nRESULT: done")
    saveRelease(h.store)
    const { run } = await h.dispatcher.startRun({
      workflowId: "release-follow-up",
      inputs: { release: "v2.4", url: "https://example.com" },
      meta: { title: "Ship v2.4", tags: ["client:example-co", "project:site"], startedBy: "lead" },
    })
    expect(run?.meta?.tags).toEqual(["client:example-co", "project:site"])

    // Both agent steps ran in order, each told how to say it is done.
    await until(() => h.cards.length === 1)
    expect(h.turns.map((t) => t.agentId)).toEqual(["builder", "checker"])
    expect(h.turns[0].message).toContain("RESULT: done")

    // The message waits for the owner: nothing was sent yet.
    expect(h.sends).toHaveLength(0)
    expect(h.cards[0].input.draft).toBe("Release v2.4 is live.")
    expect(h.runs.get(run!.id)?.pausedAt?.kind).toBe("ownerDecision")

    // The owner edits and approves: that text goes out, without another ask.
    await h.dispatcher.resumeFromCard({ id: "card-1", status: "decided", verdict: "yes", text: "Hello! Release v2.4 is live.", origin: { kind: "workflow", runId: run!.id, nodeId: "tell_client" } })
    await until(() => h.runs.get(run!.id)?.pausedAt?.kind === "replyWait")
    expect(h.sends).toEqual([{ channel: "telegram", chatId: "client-1", text: "Hello! Release v2.4 is live." }])
    expect(h.cards).toHaveLength(1)

    // A message in another chat is not the reply.
    expect(await h.dispatcher.resumeFromReply({ channel: "telegram", chatId: "someone-else", text: "hi" })).toBeNull()
    // The client's answer resumes the run, and the owner hears it.
    expect(await h.dispatcher.resumeFromReply({ channel: "telegram", chatId: "client-1", text: "Thanks, looks great" })).toBe(run!.id)
    await until(() => h.ended.length === 1)
    expect(h.told).toEqual(["Client answered: Thanks, looks great"])
    const final = h.runs.get(run!.id)!
    expect(final.status).toBe("completed")
    expect(h.ended[0].meta?.endNotifiedAt).toBeTruthy()
    // Once only.
    await h.dispatcher.resumeFromReply({ channel: "telegram", chatId: "client-1", text: "again" })
    expect(h.ended).toHaveLength(1)
  })

  it("with approval at start, asks once before the first step and never per message", async () => {
    const h = harness(() => "RESULT: done")
    saveRelease(h.store, { approval: "start" })
    const { run, awaitingApproval } = await h.dispatcher.startRun({ workflowId: "release-follow-up", inputs: { release: "v3" } })
    expect(awaitingApproval).toBe(true)
    expect(h.turns).toHaveLength(0)
    expect(h.cards).toHaveLength(1)
    expect(h.cards[0].input.context).toContain("tell_client to the client")

    await h.dispatcher.resumeFromCard({ id: "card-1", status: "decided", verdict: "yes", origin: { kind: "workflow", runId: run!.id, nodeId: "start" } })
    await until(() => h.runs.get(run!.id)?.pausedAt?.kind === "replyWait")
    expect(h.sends.map((s) => s.text)).toEqual(["Release v3 is live."])
    expect(h.cards).toHaveLength(1)
  })

  it("a no at start cancels the run and the owner gets the summary", async () => {
    const h = harness(() => "RESULT: done")
    saveRelease(h.store, { approval: "start" })
    const { run } = await h.dispatcher.startRun({ workflowId: "release-follow-up" })
    await h.dispatcher.resumeFromCard({ id: "card-1", status: "decided", verdict: "no", origin: { kind: "workflow", runId: run!.id, nodeId: "start" } })
    expect(h.runs.get(run!.id)?.status).toBe("canceled")
    expect(h.ended).toHaveLength(1)
    expect(h.turns).toHaveLength(0)
  })
})

describe("waiting for a person", () => {
  it("reminds the person with the approved text, then stops at the deadline when nothing handles the timeout", async () => {
    const h = harness(() => "RESULT: done")
    saveRelease(h.store, { approval: "start" })
    const { run } = await h.dispatcher.startRun({ workflowId: "release-follow-up", inputs: { release: "v9" }, meta: { approvedAtStart: true } })
    await until(() => h.runs.get(run!.id)?.pausedAt?.kind === "replyWait")

    // The reminder is due first: it repeats the message that was sent.
    const p = h.runs.get(run!.id)!.pausedAt as { nextRemindAt?: string; deadline: string }
    expect(Date.parse(p.nextRemindAt!)).toBeLessThan(Date.parse(p.deadline))
    await h.fire(run!.id)
    expect(h.sends.map((m) => m.text)).toEqual(["Release v9 is live.", "Reminder: Release v9 is live."])
    expect(h.runs.get(run!.id)!.history.at(-1)?.note).toBe("reminder 1/1 to person")

    // Then the deadline: no edge for `timeout`, so the run stops and says why.
    await h.fire(run!.id)
    await until(() => h.ended.length === 1)
    const final = h.runs.get(run!.id)!
    expect(final.status).toBe("failed")
    expect(final.history.at(-1)?.note).toBe("stopped: no reply before the deadline")
  })

  it("a timeout edge takes the run on instead", async () => {
    const h = harness(() => "RESULT: done")
    h.store.save(workflowSchema.parse({
      id: "chase", title: "Chase a document",
      nodes: [
        { id: "start", type: "trigger.manual" },
        { id: "wait", type: "person.wait", config: { channel: "telegram", chatId: "emp-1", timeout: 60 } },
        { id: "late", type: "owner.notify", config: { text: "No document from the employee." } },
        { id: "got", type: "owner.notify", config: { text: "Got: {{wait.text}}" } },
      ],
      edges: [{ from: "start", to: "wait" }, { from: "wait", to: "got" }, { from: "wait", fromPort: "timeout", to: "late" }],
    }))
    const { run } = await h.dispatcher.startRun({ workflowId: "chase" })
    await until(() => h.runs.get(run!.id)?.status === "paused")
    await h.fire(run!.id)
    await until(() => h.ended.length === 1)
    expect(h.told).toEqual(["No document from the employee."])
    expect(h.runs.get(run!.id)?.status).toBe("completed")
  })
})

describe("a supervised agent step", () => {
  function saveOneStep(store: WorkflowStore) {
    store.save(workflowSchema.parse({
      id: "one-step", title: "One step",
      nodes: [
        { id: "start", type: "trigger.manual" },
        { id: "deploy", type: "agent", config: { agentId: "builder", prompt: "Deploy" } },
        { id: "tell", type: "owner.notify", config: { text: "Deployed: {{deploy.evidence}}" } },
      ],
      edges: [{ from: "start", to: "deploy" }, { from: "deploy", to: "tell" }],
    }))
  }

  it("is nudged when it stalls, each nudge is logged, and it is blocked after the last one", async () => {
    const h = harness(() => "Started the deploy, it takes a while.")
    saveOneStep(h.store)
    const { run } = await h.dispatcher.startRun({ workflowId: "one-step" })
    await until(() => h.runs.get(run!.id)?.pausedAt?.kind === "agentStep")
    expect(h.timers.list().some((t) => t.runId === run!.id)).toBe(true)

    await h.fire(run!.id)
    await until(() => h.turns.length === 2)
    expect(h.turns[1].message).toContain("Reminder 1 of 2")
    await h.fire(run!.id)
    await until(() => h.turns.length === 3)
    expect(h.turns[2].message).toContain("last reminder")
    await h.fire(run!.id)

    const r = h.runs.get(run!.id)!
    expect(r.history.map((e) => e.note).filter(Boolean)).toEqual([
      "nudge 1/2 to builder",
      "nudge 2/2 to builder",
      "blocked: no progress after 2 reminder(s) to builder",
    ])
    expect(h.blocked).toEqual([{ nodeId: "deploy", reason: "no progress after 2 reminder(s) to builder" }])
    expect(r.meta?.blocked?.nodeId).toBe("deploy")
    // Blocked: no more timers, no more nudges.
    expect(h.timers.list().some((t) => t.runId === run!.id)).toBe(false)

    // The agent reports it done later: the run goes on and sums up.
    expect(await h.dispatcher.stepDone({ runId: run!.id, agentId: "builder", output: { evidence: "https://example.com/deploys/7" } })).toEqual({ ok: true })
    await until(() => h.ended.length === 1)
    expect(h.told).toEqual(["Deployed: https://example.com/deploys/7"])
    expect(h.runs.get(run!.id)?.meta?.blocked).toBeUndefined()
  })

  it("a nudge answered with RESULT: done moves the run on", async () => {
    let calls = 0
    const h = harness(() => (++calls === 1 ? "Working on it." : "All live.\nRESULT: done"))
    saveOneStep(h.store)
    const { run } = await h.dispatcher.startRun({ workflowId: "one-step" })
    await until(() => h.runs.get(run!.id)?.pausedAt?.kind === "agentStep")
    await h.fire(run!.id)
    await until(() => h.ended.length === 1)
    expect(h.runs.get(run!.id)?.status).toBe("completed")
  })

  it("RESULT: blocked tells the owner at once", async () => {
    const h = harness(() => "The server needs a password I do not have.\nRESULT: blocked")
    saveOneStep(h.store)
    const { run } = await h.dispatcher.startRun({ workflowId: "one-step" })
    await until(() => h.blocked.length === 1)
    expect(h.blocked[0].reason).toBe("The server needs a password I do not have.")
    expect(h.runs.get(run!.id)?.status).toBe("paused")
  })

  it("refuses step_done for another step or another agent", async () => {
    const h = harness(() => "Working.")
    saveOneStep(h.store)
    const { run } = await h.dispatcher.startRun({ workflowId: "one-step" })
    await until(() => h.runs.get(run!.id)?.pausedAt?.kind === "agentStep")
    expect((await h.dispatcher.stepDone({ runId: run!.id, nodeId: "tell" })).error).toMatch(/waits on step "deploy"/)
    expect((await h.dispatcher.stepDone({ runId: run!.id, agentId: "intruder" })).error).toMatch(/belongs to builder/)
  })

  it("is not supervised outside a follow-up run", async () => {
    const h = harness(() => "no token here")
    saveOneStep(h.store)
    const { run } = await h.dispatcher.startRun({ workflowId: "one-step", meta: { followUp: false } })
    await until(() => h.runs.get(run!.id)?.status !== "running" || h.told.length > 0)
    expect(h.turns[0].message).not.toContain("RESULT: done")
  })
})

describe("cancel", () => {
  it("cancels a waiting run and clears its timers", async () => {
    const h = harness(() => "Working.")
    saveRelease(h.store)
    const { run } = await h.dispatcher.startRun({ workflowId: "release-follow-up" })
    await until(() => h.runs.get(run!.id)?.pausedAt?.kind === "agentStep")
    expect(await h.dispatcher.cancelRun(run!.id)).toBe(true)
    expect(h.runs.get(run!.id)?.status).toBe("canceled")
    expect(h.timers.list()).toHaveLength(0)
    expect(h.ended).toHaveLength(1)
  })
})
