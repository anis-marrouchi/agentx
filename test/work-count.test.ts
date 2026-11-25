import { describe, expect, it } from "vitest"
import { hubAgentRows } from "../src/daemon/ui/pages/hub-agents"
import { liveTreeModel, liveWorkCount, ltPlain, ltTitle, type LtNode } from "../src/daemon/ui/pages/wall-tree"

// #2260: the Hub's "At work now" tree and its "Working" list read the same
// live snapshot but counted with two rules (runs against agents; a machine
// that is slow or answered with an error counted in one and not the other).
// One rule now: liveWorkCount. These are the cases where they differed.

const NOW = Date.parse("2026-11-25T19:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const run = (id: string) => ({ id, startedAt: ago(60_000), messagePreview: "work " + id })

const NODES: LtNode[] = [
  { id: "mac", name: "MacBook-Local", url: "http://mac", reachable: true, agents: [
    // Two runs on one agent: one agent working.
    { id: "coder", name: "Coder", runningTasks: [run("c1"), run("c2")] },
    { id: "devops", name: "DevOps", runningTasks: [run("d1")] },
    { id: "pm", name: "Hakim", runningTasks: [] },
  ] },
  // Answered with an error: the tree says "not checked", so its agents do not count.
  { id: "clawd", name: "Clawd", url: "http://clawd", reachable: true, error: "HTTP 502", agents: [
    { id: "atlas", name: "atlas", runningTasks: [run("a1")] },
  ] },
  // Still being asked again: the tree says "checking…".
  { id: "slow", name: "Slow", url: "http://slow", reachable: true, checking: true, agents: [
    { id: "omar", name: "omar", runningTasks: [run("o1")] },
  ] },
  // The same agent listed by a second machine: it counts once, on the first.
  { id: "peer", name: "Peer", url: "http://peer", reachable: true, agents: [
    { id: "coder", name: "Coder (copy)", runningTasks: [run("c3")] },
    { id: "seif", name: "seif", runningTasks: [run("s1")] },
  ] },
]

describe("liveWorkCount (#2260)", () => {
  const work = liveWorkCount(NODES)

  it("counts agents with a run, once each, on machines that answer", () => {
    expect(work.agents).toBe(3) // coder + devops on the Mac, seif on Peer
    expect(work.runs).toBe(4) // c1, c2, d1, s1
    expect(work.byNode).toEqual({ "http://mac": { agents: 2, runs: 3 }, "http://peer": { agents: 1, runs: 1 } })
    expect(work.home.coder).toBe("http://mac")
  })

  it("gives the tree's badges and the Working list the same number", () => {
    const tree = liveTreeModel(NODES, [], NOW)
    const hub = hubAgentRows(NODES, [], NOW, NOW - 3_600_000, (t) => ltTitle(t, null), ltPlain, work)
    const treeTotal = tree.reduce((n, m) => n + m.working, 0)
    expect(hub.counts.working).toBe(work.agents)
    expect(treeTotal).toBe(work.agents)
    expect(hub.rows.filter((r) => r.state === "working").map((r) => r.id).sort()).toEqual(["coder", "devops", "seif"])
    expect(tree.map((m) => [m.name, m.state, m.working])).toEqual([
      ["MacBook-Local", "up", 2], ["Clawd", "silent", 0], ["Slow", "checking", 0], ["Peer", "up", 1],
    ])
  })

  it("leaves out the agents of a machine that is not up, in both", () => {
    const hub = hubAgentRows(NODES, [], NOW, NOW - 3_600_000, (t) => ltTitle(t, null), ltPlain, work)
    expect(hub.rows.some((r) => r.id === "atlas" || r.id === "omar")).toBe(false)
  })
})
