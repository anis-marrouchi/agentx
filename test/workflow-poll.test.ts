import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PollTriggers, parsePollItems, pollEntityId } from "../src/workflows/poll"
import { WorkflowStore } from "../src/workflows/store"
import { RunStore } from "../src/workflows/run-store"
import { WorkflowDispatcher } from "../src/workflows/dispatcher"
import { runAction } from "../src/actions/runner"
import { actionSchema } from "../src/actions/types"
import { parseYamlWorkflow } from "../src/workflows/yaml"
import { pollConfigSchema } from "../src/workflows/poll"
import { conditionMatches } from "../src/workflows/engine"
import { lintWorkflow, workflowSchema } from "../src/workflows/types"
import { NODE_OUTPUTS } from "../src/workflows/nodes/schemas"
import { resolveHandler } from "../src/workflows/nodes/handlers"
import { PALETTE, nodeSummary } from "../src/web/workflow-editor/data"

function wf(id: string, config: Record<string, unknown>, state = "active") {
  return {
    id, version: 2, title: id, state,
    nodes: [
      { id: "trigger", type: "trigger.poll", config },
      { id: "done", type: "end", config: {} },
    ],
    edges: [{ from: "trigger", to: "done" }],
  }
}

const lines = (...items: unknown[]) => items.map((i) => JSON.stringify(i)).join("\n")

/** Real PollTriggers over a temp dir, with a fake store, dispatcher and
 *  poll command. `output` is what the command prints on the next poll. */
function boot(dir: string, workflows: any[]) {
  const cmd = { output: "", ok: true, throws: false, calls: 0 }
  const started: Array<{ entity: string; payload: Record<string, unknown> }> = []
  const logs: string[] = []
  const store = { baseDir: dir, list: () => workflows, get: (id: string) => workflows.find((w) => w.id === id) ?? null }
  const dispatcher = {
    dispatchWorkflow: vi.fn(async (a: any) => {
      started.push({ entity: a.entityRef.id, payload: a.event.payload })
      return { claimed: true, run: { id: `run-${started.length}` } }
    }),
  }
  const make = () => new PollTriggers({
    store: store as any,
    dispatcher: dispatcher as any,
    log: (m) => logs.push(m),
    runAction: async () => {
      cmd.calls++
      if (cmd.throws) throw new Error("boom")
      return { ok: cmd.ok, output: cmd.output, errors: cmd.ok ? undefined : "exit 2", status: cmd.ok ? 0 : 2, durationMs: 1 }
    },
  })
  return { polls: make(), make, cmd, started, logs, dispatcher, workflows }
}

describe("trigger.poll", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-poll-")) })
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

  it("is a known node type with outputs, a handler and an editor entry", () => {
    const parsed = workflowSchema.parse(wf("p", { actionId: "list" }))
    expect(lintWorkflow(parsed)).toEqual([])
    expect(NODE_OUTPUTS["trigger.poll"].fields.length).toBeGreaterThan(0)
    expect(resolveHandler("trigger.poll")).toBeDefined()
    expect(PALETTE.flatMap((s) => s.items).some((i) => i.type === "trigger.poll")).toBe(true)
    expect(nodeSummary("trigger.poll", { actionId: "list" })).toBe("new items from list")
  })

  it("parses one JSON object per line and skips the rest", () => {
    const r = parsePollItems(`{"id":"a"}\nnot json\n[1]\n{"other":1}\n\n{"id":7}\n{"id":""}`, "id")
    expect(r.items.map((i) => i.key)).toEqual(["a", "7"])
    expect(r.skipped).toBe(4)
  })

  it("first poll only records a baseline", async () => {
    const t = boot(dir, [wf("p", { actionId: "list", key: "msgId" })])
    t.cmd.output = lines({ msgId: "m1" }, { msgId: "m2" })
    expect(await t.polls.pollOnce("p")).toBe(0)
    expect(t.started).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, "_poll", "p.json"), "utf-8")).seen).toEqual(["m1", "m2"])
  })

  it("starts one run per new item, once, with the item as payload", async () => {
    const t = boot(dir, [wf("p", { actionId: "list", key: "msgId" })])
    t.cmd.output = lines({ msgId: "m1" })
    await t.polls.pollOnce("p")
    t.cmd.output = lines({ msgId: "m1" }, { msgId: "m2", text: "hi" }, { msgId: "m2", text: "dup" })
    expect(await t.polls.pollOnce("p")).toBe(1)
    expect(await t.polls.pollOnce("p")).toBe(0)
    expect(t.started).toEqual([{ entity: "p:m2", payload: { msgId: "m2", text: "hi" } }])
  })

  it("a poll with nothing new dispatches nothing and writes nothing", async () => {
    const t = boot(dir, [wf("p", { actionId: "list" })])
    t.cmd.output = lines({ id: "a" })
    await t.polls.pollOnce("p")
    // The state file is replaced by rename, so a rewrite changes its inode.
    const before = statSync(join(dir, "_poll", "p.json")).ino
    expect(await t.polls.pollOnce("p")).toBe(0)
    expect(t.dispatcher.dispatchWorkflow).not.toHaveBeenCalled()
    expect(statSync(join(dir, "_poll", "p.json")).ino).toBe(before)
  })

  it("applies every filter condition; filtered-out items are seen but start nothing", async () => {
    const filter = [
      { kind: "matches", params: { path: "text", regex: "^\\s*@hakim\\b" } },
      { kind: "equals", params: { path: "fromMe", value: false } },
    ]
    const t = boot(dir, [wf("p", { actionId: "list", filter })])
    await t.polls.pollOnce("p")
    t.cmd.output = lines(
      { id: "1", text: "@hakim status?", fromMe: false },
      { id: "2", text: "@hakim from me", fromMe: true },
      { id: "3", text: "hello", fromMe: false },
    )
    expect(await t.polls.pollOnce("p")).toBe(1)
    expect(t.started.map((s) => s.entity)).toEqual(["p:1"])
    // Loosening the filter later must not replay old items.
    t.workflows[0].nodes[0].config = { actionId: "list" }
    expect(await t.polls.pollOnce("p")).toBe(0)
  })

  it("survives a restart: seen keys come from disk", async () => {
    const t = boot(dir, [wf("p", { actionId: "list" })])
    await t.polls.pollOnce("p")
    t.cmd.output = lines({ id: "a" })
    await t.polls.pollOnce("p")
    const restarted = t.make()
    t.cmd.output = lines({ id: "a" }, { id: "b" })
    expect(await restarted.pollOnce("p")).toBe(1)
    expect(t.started.map((s) => s.entity)).toEqual(["p:a", "p:b"])
  })

  it("records the key before dispatch, so a crash mid-run cannot start it twice", async () => {
    const t = boot(dir, [wf("p", { actionId: "list" })])
    await t.polls.pollOnce("p")
    let onDiskAtDispatch: string[] = []
    t.dispatcher.dispatchWorkflow.mockImplementationOnce(async () => {
      onDiskAtDispatch = JSON.parse(readFileSync(join(dir, "_poll", "p.json"), "utf-8")).seen
      throw new Error("daemon died")
    })
    t.cmd.output = lines({ id: "a" })
    expect(await t.polls.pollOnce("p")).toBe(0)
    expect(onDiskAtDispatch).toContain("a")
    expect(await t.make().pollOnce("p")).toBe(0)
    expect(t.dispatcher.dispatchWorkflow).toHaveBeenCalledTimes(1)
  })

  it("a failing or throwing command is logged, starts nothing and keeps state", async () => {
    const t = boot(dir, [wf("p", { actionId: "list" })])
    t.cmd.ok = false
    t.cmd.output = lines({ id: "a" })
    expect(await t.polls.pollOnce("p")).toBe(0)
    expect(existsSync(join(dir, "_poll", "p.json"))).toBe(false)
    t.cmd.throws = true
    expect(await t.polls.pollOnce("p")).toBe(0)
    expect(t.logs.filter((l) => l.includes("p poll failed"))).toHaveLength(2)
    // Next tick works again: baseline, then new items.
    t.cmd.ok = true; t.cmd.throws = false
    await t.polls.pollOnce("p")
    t.cmd.output = lines({ id: "a" }, { id: "b" })
    expect(await t.polls.pollOnce("p")).toBe(1)
  })

  it("a standing failure is logged once, and again after a good poll", async () => {
    const t = boot(dir, [wf("p", { actionId: "list" })])
    const failed = () => t.logs.filter((l) => l.includes("p poll failed")).length
    t.cmd.ok = false
    await t.polls.pollOnce("p"); await t.polls.pollOnce("p"); await t.polls.pollOnce("p")
    expect(failed()).toBe(1)
    t.cmd.ok = true
    await t.polls.pollOnce("p")
    t.cmd.ok = false
    await t.polls.pollOnce("p")
    expect(failed()).toBe(2)
  })

  it("re-baselines when the key field or the action changes", async () => {
    const t = boot(dir, [wf("p", { actionId: "list", key: "id" })])
    t.cmd.output = lines({ id: "a", msgId: "x" })
    await t.polls.pollOnce("p")
    t.workflows[0].nodes[0].config = { actionId: "list", key: "msgId" }
    expect(await t.polls.pollOnce("p")).toBe(0)
    expect(t.started).toEqual([])
  })

  it("caps runs per poll and leaves the rest for the next one", async () => {
    const t = boot(dir, [wf("p", { actionId: "list", maxPerPoll: 2 })])
    await t.polls.pollOnce("p")
    t.cmd.output = lines({ id: "a" }, { id: "b" }, { id: "c" })
    expect(await t.polls.pollOnce("p")).toBe(2)
    expect(await t.polls.pollOnce("p")).toBe(1)
    expect(t.started.map((s) => s.entity)).toEqual(["p:a", "p:b", "p:c"])
  })

  it("polls only active workflows and follows saves, disables and config errors", async () => {
    vi.useFakeTimers()
    const t = boot(dir, [
      wf("on", { actionId: "list", everySeconds: 10 }),
      wf("off", { actionId: "list" }, "disabled"),
      wf("held", { actionId: "list" }, "quarantined"),
      wf("bad", { everySeconds: 10 }),
    ])
    expect(t.polls.sync()).toBe(1)
    expect(t.logs.some((l) => l.includes("bad trigger.poll config invalid"))).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.cmd.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.cmd.calls).toBe(2)

    // Saved: a new workflow appears, and "off" is enabled.
    t.workflows.push(wf("new", { actionId: "list", everySeconds: 10 }))
    t.workflows[1].state = "active"
    expect(t.polls.sync()).toBe(3)

    // Disabled: stops at the next sync, and a tick in between does not run it.
    t.workflows[0].state = "disabled"
    const calls = t.cmd.calls
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.cmd.calls).toBe(calls + 1) // only "new" (10 s); "off" polls every 60 s
    expect(t.polls.sync()).toBe(2)
    t.polls.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(t.cmd.calls).toBe(calls + 1)
  })

  it("keys the run index cannot hold apart get a hashed entity id", () => {
    expect(pollEntityId("p", "3EB0A1.b:c@d-e")).toBe("p:3EB0A1.b:c@d-e")
    const url = `https://example.com/${"x".repeat(230)}`
    const ids = ["a/b", "a b", "a_b", "#1", `${url}1`, `${url}2`].map((k) => pollEntityId("p", k))
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids.filter((i) => i !== "p:a_b")) expect(id).toMatch(/^p:#[0-9a-f]{32}$/)
  })

  it("end to end: keys that differ only in characters the run index drops each start a run", async () => {
    const store = new WorkflowStore({ baseDir: join(dir, "workflows") })
    store.save(workflowSchema.parse(wf("u", { actionId: "list", key: "url" })))
    const runs = new RunStore({ baseDir: join(dir, "workflows"), nodeId: "n" })
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "n", channels: {}, agents: { execute: async () => ({ content: "" }) } })
    let output = ""
    const polls = new PollTriggers({ store, dispatcher, log: () => {}, runAction: async () => ({ ok: true, output, status: 0, durationMs: 1 }) })
    await polls.pollOnce("u") // baseline
    const long = `https://example.com/${"x".repeat(230)}`
    output = lines({ url: "a/b" }, { url: "a b" }, { url: `${long}1` }, { url: `${long}2` })
    expect(await polls.pollOnce("u")).toBe(4)
    expect(runs.list({ workflowId: "u" })).toHaveLength(4)
  })

  it("end to end: a real shell action, real stores, one run record per new item and none otherwise", async () => {
    const feed = join(dir, "feed.jsonl")
    writeFileSync(feed, lines({ msgId: "old", text: "@hakim before install" }) + "\n")
    const store = new WorkflowStore({ baseDir: join(dir, "workflows") })
    store.save(workflowSchema.parse({
      id: "wa", version: 2, title: "wa",
      nodes: [
        { id: "trigger", type: "trigger.poll", config: { actionId: "feed", key: "msgId", filter: [{ kind: "matches", params: { path: "text", regex: "^@hakim\\b" } }] } },
        { id: "ask", type: "agent", config: { agentId: "pm", prompt: "{{trigger.msgId}}: {{trigger.text}}" } },
        { id: "done", type: "end", config: { status: "completed" } },
      ],
      edges: [{ from: "trigger", to: "ask" }, { from: "ask", to: "done" }],
    }))
    const runs = new RunStore({ baseDir: join(dir, "workflows"), nodeId: "n" })
    const prompts: string[] = []
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "n", channels: {},
      agents: { execute: async (r) => { prompts.push(r.message); return { content: "RESULT: ok" } } },
    })
    const action = actionSchema.parse({ id: "feed", title: "feed", kind: "shell", command: `cat '${feed}'` })
    const polls = new PollTriggers({ store, dispatcher, log: () => {}, runAction: () => runAction(action) })
    const runFiles = () => readdirSync(join(dir, "workflows", "_runs")).length

    await polls.pollOnce("wa") // baseline
    await polls.pollOnce("wa") // nothing new
    expect(runFiles()).toBe(0)

    writeFileSync(feed, lines({ msgId: "old", text: "@hakim before install" }, { msgId: "m1", text: "hello" }, { msgId: "m2", text: "@hakim status?" }) + "\n")
    expect(await polls.pollOnce("wa")).toBe(1)
    await polls.pollOnce("wa")
    await new Promise((r) => setTimeout(r, 50))
    expect(runFiles()).toBe(1)
    expect(prompts).toEqual(["m2: @hakim status?"])
    expect(runs.list({ workflowId: "wa" })[0].status).toBe("completed")
  })
})

describe("examples: wacli mention (#360)", () => {
  const text = readFileSync(join(process.cwd(), "examples/workflows/wacli-mention.yaml"), "utf-8")
  const parsed = workflowSchema.parse(parseYamlWorkflow(text, { filePath: "wacli-mention.yaml" }))
  const cfg = pollConfigSchema.parse(parsed.nodes.find((n) => n.type === "trigger.poll")!.config)

  it("the workflow validates, lints clean and polls the example action", () => {
    expect(lintWorkflow(parsed)).toEqual([])
    const action = actionSchema.parse(JSON.parse(readFileSync(join(process.cwd(), "examples/actions/wacli-new-messages.json"), "utf-8")))
    expect(cfg.actionId).toBe(action.id)
    expect(cfg.key).toBe("msgId")
  })

  it("the action fails when wacli fails, so the first poll records no empty baseline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-poll-wacli-"))
    try {
      // A wacli that fails, and a jq that would succeed on empty input.
      writeFileSync(join(dir, "wacli"), "#!/bin/sh\necho 'store locked' >&2\nexit 3\n")
      writeFileSync(join(dir, "jq"), "#!/bin/sh\ncat >/dev/null\n")
      chmodSync(join(dir, "wacli"), 0o755); chmodSync(join(dir, "jq"), 0o755)
      const raw = JSON.parse(readFileSync(join(process.cwd(), "examples/actions/wacli-new-messages.json"), "utf-8"))
      const action = actionSchema.parse({ ...raw, command: raw.command.replace("<CHAT_JID>", "chat@g.us"), env: { PATH: `${dir}:/usr/bin:/bin` } })
      expect((await runAction(action)).ok).toBe(false)

      const logs: string[] = []
      const workflows = [{ ...parsed, state: "active" }]
      const dispatchWorkflow = vi.fn()
      const polls = new PollTriggers({
        store: { baseDir: dir, list: () => workflows, get: () => workflows[0] } as any,
        dispatcher: { dispatchWorkflow } as any,
        log: (m) => logs.push(m), runAction: () => runAction(action),
      })
      expect(await polls.pollOnce(parsed.id)).toBe(0)
      expect(logs.some((l) => l.includes("poll failed"))).toBe(true)
      expect(existsSync(join(dir, "_poll"))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("its filter keeps only messages from the other side that start with the mention", () => {
    const pass = (item: Record<string, unknown>) => cfg.filter.every((c) => conditionMatches(c, item))
    expect(pass({ text: "@Hakim status?", fromMe: false })).toBe(true)
    expect(pass({ text: " @hakim status?", fromMe: false })).toBe(true)
    expect(pass({ text: "@hakim status?", fromMe: true })).toBe(false)
    expect(pass({ text: "ask @hakim later", fromMe: false })).toBe(false)
  })
})
