import { describe, expect, it } from "vitest"
import * as tree from "../src/daemon/ui/pages/wall-tree"
import * as workers from "../src/daemon/ui/pages/wall-tree-workers"
import { injectFns } from "../src/daemon/ui/inject"
import { liveTreeModel, ltAge, ltEsc, ltTitle, type LtNode } from "../src/daemon/ui/pages/wall-tree"
import { ltAddWorkers, ltRunIndex, ltWorkerState, ltWorkersHtml, ltWorkersOf } from "../src/daemon/ui/pages/wall-tree-workers"

// #2145: under each agent run in the Hub's live tree, the workers it
// started (hand-offs, workflows, runs on other machines), each with its
// state and age, and a link to its chat.

const NOW = Date.parse("2026-11-23T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const title = (t: { messagePreview?: string; id: string }) => ltTitle(t, null)

const NODES: LtNode[] = [
  { id: "mac", name: "MacBook", url: "http://mac", reachable: true, agents: [
    { id: "front", name: "Front", runningTasks: [
      { id: "run-1", channel: "telegram", chatId: "c1", startedAt: ago(5 * 60_000), messagePreview: "help me ship", workers: [
        { kind: "handoff", id: "dlg-a", title: "Check the <build>", status: "working", startedAt: ago(60_000), agentId: "worker", taskId: "run-w" },
        { kind: "handoff", id: "dlg-b", title: "Ask Atlas", status: "working", startedAt: ago(30_000), agentId: "atlas", peer: "clawd" },
        { kind: "workflow", id: "wf-1", title: "Deploy", status: "completed", startedAt: ago(20 * 60_000), endedAt: ago(10 * 60_000), workflowId: "deploy" },
      ] },
    ] },
    { id: "worker", name: "Worker", runningTasks: [
      { id: "run-w", channel: "a2a", chatId: "a2a:x", startedAt: ago(60_000), messagePreview: "check the build" },
      // agent.call from run-1: carries its parent, no node (same machine).
      { id: "run-c", channel: "api", chatId: "api:1", startedAt: ago(10_000), messagePreview: "a quick call", parent: { taskId: "run-1", agentId: "front" } },
    ] },
  ] },
  { id: "clawd", name: "Clawd Server", url: "http://clawd", reachable: true, agents: [
    { id: "atlas", name: "Atlas", runningTasks: [
      // The peer's run of dlg-b: names its parent on "mac".
      { id: "run-p", channel: "a2a", chatId: "a2a:y", startedAt: ago(25_000), messagePreview: "ask atlas", parent: { taskId: "run-1", agentId: "front", node: "mac" } },
      // Same task id on the wrong machine: not run-1's worker.
      { id: "run-q", channel: "a2a", chatId: "a2a:z", startedAt: ago(5_000), messagePreview: "other", parent: { taskId: "run-1", agentId: "front", node: "elsewhere" } },
    ] },
  ] },
]

describe("ltWorkerState", () => {
  it("maps hand-off and workflow statuses to four words", () => {
    expect(["running", "completed", "done", "paused", "waiting", "timeout", "lost", "canceled", "error", ""].map(ltWorkerState))
      .toEqual(["working", "done", "done", "waiting", "waiting", "failed", "failed", "failed", "failed", "working"])
  })
})

describe("ltWorkersOf", () => {
  const index = ltRunIndex(NODES)
  const run1 = NODES[0].agents![0].runningTasks![0]
  const list = ltWorkersOf(run1, "mac", index, NOW, title)

  it("lists the hand-offs, workflows and runs that name it as parent, going first", () => {
    expect(list.map((w) => w.key)).toEqual(["run:mac|run-c", "handoff:dlg-b", "handoff:dlg-a", "workflow:wf-1"])
    expect(list.map((w) => w.state)).toEqual(["working", "working", "working", "done"])
  })
  it("links a local hand-off to its own run, and a peer hand-off to the peer's run", () => {
    const a = list.find((w) => w.key === "handoff:dlg-a")!
    expect(a).toMatchObject({ agentName: "Worker", where: "", nodeUrl: "http://mac" })
    expect(a.task!.id).toBe("run-w")
    const b = list.find((w) => w.key === "handoff:dlg-b")!
    expect(b).toMatchObject({ agentName: "Atlas", where: "Clawd Server", nodeUrl: "http://clawd" })
    expect(b.task!.id).toBe("run-p")
    // The peer's run is not listed a second time, nor the wrong machine's.
    expect(list.some((w) => w.key.includes("run-p") || w.key.includes("run-q"))).toBe(false)
  })
  it("ages a done worker from when it ended", () => {
    expect(list.find((w) => w.key === "workflow:wf-1")!.ageMs).toBe(10 * 60_000)
  })
})

describe("ltWorkersHtml", () => {
  it("draws each worker with state, time and a link, escaped", () => {
    const machines = ltAddWorkers(liveTreeModel(NODES, [], NOW), NODES, NOW, title)
    const row = machines[0].projects.flatMap((p) => p.items.flatMap((i) => i.rows)).find((r) => r.task?.id === "run-1")!
    const html = ltWorkersHtml(row.workers, (w) => "#open=" + w.key, ltEsc, ltAge)
    expect(html).toContain('aria-label="Workers it started"')
    expect(html).toContain("Check the &lt;build&gt;")
    expect(html).not.toContain("<build>")
    expect(html).toContain('href="#open=handoff:dlg-a"')
    expect(html).toContain("on Clawd Server")
    expect(html).toContain('<span class="ax-af-state" data-state="done">done</span>')
    expect(html).toContain("<time>10m</time>")
    expect(ltWorkersHtml([], () => "", ltEsc, ltAge)).toBe("")
  })
})

describe("shipped to the browser", () => {
  it("runs from its own source alone (injectFns)", () => {
    const pick = (m: object) => Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "function")) as Record<string, Function>
    const run = new Function("nodes", "now", injectFns({ ...pick(tree), ...pick(workers) }) +
      "var ms = ltAddWorkers(liveTreeModel(nodes, [], now), nodes, now, function (t) { return ltTitle(t, null); });" +
      "return liveTreeHtml(ms, function () { return '#x' }, {}, function (r) { return ltWorkersHtml(r.workers, function () { return '#w' }, ltEsc, ltAge); });")
    const html = run(NODES, NOW) as string
    expect(html.match(/class="lt__wk /g)!.length).toBeGreaterThanOrEqual(4)
  })
})
