import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { haListHtml, hubAgentRows } from "../src/daemon/ui/pages/hub-agents"
import { liveTreeModel, liveWorkCount, ltEsc, ltNodeKey, ltPlain, ltTitle, type LtNode } from "../src/daemon/ui/pages/wall-tree"

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

  it("keeps listing the agents of a machine that is not up, never as working (C1)", () => {
    const hub = hubAgentRows(NODES, [], NOW, NOW - 3_600_000, (t) => ltTitle(t, null), ltPlain, work)
    const by = (id: string) => hub.rows.find((r) => r.id === id)
    expect(by("atlas")).toMatchObject({ node: "Clawd", state: "idle", runs: 0, taskId: "" })
    expect(by("omar")).toMatchObject({ node: "Slow", state: "idle", runs: 0, taskId: "" })
    expect(hub.rows.map((r) => r.id).sort()).toEqual(["atlas", "coder", "devops", "omar", "pm", "seif"])
  })

  it("lists an agent on a slow machine under the up machine that also has it", () => {
    const nodes: LtNode[] = [
      { id: "slow", name: "Slow", url: "http://slow", reachable: true, checking: true, agents: [{ id: "x", name: "X", runningTasks: [run("x1")] }] },
      { id: "up", name: "Up", url: "http://up", reachable: true, agents: [{ id: "x", name: "X", runningTasks: [run("x2")] }] },
    ]
    const hub = hubAgentRows(nodes, [], NOW, NOW - 3_600_000, (t) => ltTitle(t, null), ltPlain, liveWorkCount(nodes))
    expect(hub.rows).toHaveLength(1)
    expect(hub.rows[0]).toMatchObject({ node: "Up", state: "working", taskId: "x2" })
  })

  it("leaves out a machine that does not answer at all", () => {
    const nodes: LtNode[] = [{ id: "off", name: "Off", url: "http://off", reachable: false, agents: [{ id: "z", name: "Z" }] }]
    expect(hubAgentRows(nodes, [], NOW, NOW - 3_600_000, (t) => ltTitle(t, null), ltPlain, liveWorkCount(nodes)).rows).toEqual([])
  })

  it("shows an agent two machines list only under the first, so rows match the badge (C2)", () => {
    const tree = liveTreeModel(NODES, [], NOW)
    const peer = tree.find((m) => m.name === "Peer")!
    const ids = peer.projects.flatMap((p) => p.items.flatMap((i) => i.rows.map((r) => r.task && r.task.id)))
    expect(ids).toEqual(["s1"])
    expect(peer.working).toBe(1)
    expect([...peer.done, ...peer.idle].some((r) => r.agentId === "coder")).toBe(false)
    // Up machines: a checking one shows "checking…", no number, and keeps
    // its last good rows (#2292).
    for (const m of tree.filter((x) => x.state === "up")) {
      const working = new Set(m.projects.flatMap((p) => p.items.flatMap((i) => i.rows.map((r) => r.agentId))))
      expect(working.size).toBe(m.working)
    }
  })
})

// #2258: the other pages that count work read the same rule.
const src = (f: string) => readFileSync(new URL("../src/daemon/ui/pages/" + f, import.meta.url), "utf8")
/** One browser function out of a page script, by its name (two-space indent). */
function pick(file: string, name: string): string {
  const s = src(file)
  const at = s.indexOf("  function " + name + "(")
  expect(at, name + " in " + file).toBeGreaterThan(-1)
  return s.slice(at, s.indexOf("\n  }\n", at) + 4)
}

describe("every page counts work with liveWorkCount (#2258)", () => {
  const work = liveWorkCount(NODES)
  const S = { live: { nodes: NODES } }

  it("the nav's running count is the working agents, not their runs", () => {
    const f = new Function("S", "liveWorkCount", pick("wall.client.ts", "runningCount") + "; return runningCount()")
    expect(work.runs).toBeGreaterThan(work.agents) // one agent has two runs
    expect(f(S, liveWorkCount)).toBe(work.agents) // 3: not 4 (runs), not 7 (all runs on every machine)
  })

  it("the Agents page counts an agent's runs on its home machine only", () => {
    const f = new Function("S", "liveWorkCount", "ltNodeKey", "agentStats", "nameOf",
      pick("wall.client.ts", "allAgents") + "; return allAgents()")
    const list = f(S, liveWorkCount, ltNodeKey, () => [], (id: string) => id) as Array<{ id: string; running: number }>
    const runs = Object.fromEntries(list.map((a) => [a.id, a.running]))
    expect(runs).toMatchObject({ coder: 2, devops: 1, seif: 1, atlas: 0, omar: 0 })
    expect(list.filter((a) => a.running).length).toBe(work.agents)
  })

  it("the status bar's agents running is the Working count", () => {
    // The item starts hidden and shows once there is a reading (#2101 R26).
    const el = { innerHTML: "", parentNode: { hidden: true } }
    const f = new Function("S", "liveWorkCount", "$", "hsPaintConn", "hsPaintCli",
      pick("hub-status.client.ts", "hsPaintRunning") + "; hsPaintRunning()")
    f(S, liveWorkCount, () => el, () => {}, () => {})
    // "3 running" when narrow: the word "agents" is its own span (#2101 R5).
    expect(el.innerHTML.replace(/<[^>]+>/g, "")).toBe(work.agents + " agents running")
    expect(el.innerHTML).toContain('<span class="hs__long"> agents</span> running')
    expect(el.parentNode.hidden).toBe(false)
  })

  it("the Working list groups by machine, each agent once", () => {
    const m = hubAgentRows(NODES, [], NOW, NOW - 3_600_000, (t) => ltTitle(t, null), ltPlain, work)
    const html = haListHtml(m, "working", "", false, ltEsc, () => "now")
    const heads = [...html.matchAll(/<h4 class="ha__m">([^<]*) <span class="ax-af-count" data-n="\d+">(\d+)<\/span><\/h4>/g)].map((x) => [x[1], Number(x[2])])
    expect(heads).toEqual([["MacBook-Local", 2], ["Peer", 1]])
    expect(heads.reduce((n, h) => n + (h[1] as number), 0)).toBe(work.agents)
    expect((html.match(/data-ha-agent="coder"/g) || []).length).toBe(1)
  })

  it("two machines with one name keep their own headings", () => {
    const twins = [NODES[0], { ...NODES[3], name: "MacBook-Local" }]
    const m = hubAgentRows(twins, [], NOW, NOW - 3_600_000, (t) => ltTitle(t, null), ltPlain, liveWorkCount(twins))
    const html = haListHtml(m, "working", "", false, ltEsc, () => "now")
    const heads = [...html.matchAll(/<h4 class="ha__m">([^<]*) <span class="ax-af-count" data-n="\d+">(\d+)<\/span><\/h4>/g)].map((x) => [x[1], Number(x[2])])
    expect(heads).toEqual([["MacBook-Local", 2], ["MacBook-Local", 1]])
  })

  it("one machine working: no machine headings", () => {
    const one = NODES.slice(0, 1)
    const m = hubAgentRows(one, [], NOW, NOW - 3_600_000, (t) => ltTitle(t, null), ltPlain, liveWorkCount(one))
    expect(haListHtml(m, "all", "", false, ltEsc, () => "now")).not.toContain("ha__m")
  })
})
