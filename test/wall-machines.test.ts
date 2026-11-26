import { describe, expect, it } from "vitest"
import { liveTreeModel, liveWorkCount, ltEsc, ltFold, ltRowHtml, ltTitle, type LtNode } from "../src/daemon/ui/pages/wall-tree"
import { ltAddWorkers, ltWorkersHtml } from "../src/daemon/ui/pages/wall-tree-workers"
import { mtCountWords, mtModel, mtTreeHtml, type MtMesh } from "../src/daemon/ui/pages/wall-machines"
import { renderWallPage } from "../src/daemon/ui/pages/wall"

// #2101 Machines tree, option A (Hakim PASS with C1–C4, 2026-11-26): the
// side menu's folded "Machines" = mesh › machine › one row per run. The
// agent list stays the one list of who; this is where the work runs.

const NOW = Date.parse("2026-11-26T15:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const run = (id: string, extra: Record<string, unknown> = {}) => ({ id, startedAt: ago(60_000), lastActivity: ago(30_000), messagePreview: "work " + id, ...extra })

const NODES: LtNode[] = [
  { id: "mac", name: "MacBook-Local", url: "http://mac", reachable: true, agents: [
    { id: "coder", name: "Coder", model: "claude-opus-5-5", runningTasks: [run("c1"), run("c2", { channel: "cron", chatId: "cron:nightly-sweep" })] },
    { id: "devops", name: "DevOps", runningTasks: [run("d1", { workers: [{ kind: "handoff", id: "h1", title: "Check the deploy", status: "running", agentId: "seif", peer: "peer" }] })] },
    { id: "pm", name: "Hakim", runningTasks: [], lastActive: ago(60_000) },
  ] },
  // Answered with an error: shown, "not checked", no rows.
  { id: "clawd", name: "Clawd", url: "http://clawd", reachable: true, error: "HTTP 502", agents: [
    { id: "atlas", name: "atlas", runningTasks: [run("a1")] },
  ] },
  // Nothing running: still shown (C1).
  { id: "quiet", name: "Quiet box", url: "http://quiet", reachable: true, agents: [
    { id: "idle1", name: "Idle One", runningTasks: [] },
  ] },
  // The same agent listed by a second machine: it shows on the first only.
  { id: "peer", name: "Peer", url: "http://peer", reachable: true, agents: [
    { id: "coder", name: "Coder (copy)", runningTasks: [run("c3")] },
    { id: "seif", name: "seif", runningTasks: [run("s1", { parent: { taskId: "d1", agentId: "devops", node: "mac" } })] },
  ] },
]

function build(nodes = NODES): MtMesh[] {
  return mtModel(ltAddWorkers(liveTreeModel(nodes, [], NOW), nodes, NOW, (t) => ltTitle(t, null)))
}

const deps = {
  esc: ltEsc, fold: ltFold, row: ltRowHtml,
  under: (r: any) => ltWorkersHtml(r.workers, () => "#w", ltEsc, (ms: number) => String(ms)),
}

describe("mtModel (#2101 Machines tree)", () => {
  const [mesh] = build()

  it("shows the mesh and every machine, even with nothing running (C1)", () => {
    expect(mesh.name).toBe("Your mesh")
    expect(mesh.machines.map((m) => m.name)).toEqual(["MacBook-Local", "Clawd", "Quiet box", "Peer"])
    expect(mesh.total).toBe(4)
    expect(mesh.online).toBe(3)
    const quiet = mesh.machines.find((m) => m.name === "Quiet box")!
    expect(quiet.rows).toEqual([])
    expect(mtModel([])[0].machines).toEqual([])
  })

  it("lists one row per run, and no idle, done, project or work-item level", () => {
    const mac = mesh.machines[0]
    expect(mac.rows.map((r) => r.task!.id).sort()).toEqual(["c1", "c2", "d1"])
    expect(mac.rows.every((r) => r.state === "working")).toBe(true)
    expect(Object.keys(mac).sort()).toEqual(["asOf", "error", "id", "key", "name", "rows", "runs", "state", "url", "working"])
  })

  it("shows no agent on two machines, and its counts add up to Working (C2)", () => {
    const where: Record<string, string> = {}
    for (const m of mesh.machines) for (const r of m.rows) {
      expect(where[r.agentId] === undefined || where[r.agentId] === m.key).toBe(true)
      where[r.agentId] = m.key
    }
    expect(where.coder).toBe("http://mac")
    const work = liveWorkCount(NODES)
    expect(mesh.machines.reduce((n, m) => n + m.working, 0)).toBe(work.agents)
    expect(mesh.working).toBe(work.agents)
    expect(mesh.runs).toBe(work.runs)
    // Each machine's rows are its runs.
    for (const m of mesh.machines) expect(m.rows.length).toBe(m.runs)
  })

  it("keeps the hand-offs a run started under it", () => {
    const d1 = mesh.machines[0].rows.find((r) => r.task!.id === "d1")!
    expect(d1.workers!.map((w) => w.agentId)).toEqual(["seif"])
  })
})

describe("mtTreeHtml", () => {
  const html = mtTreeHtml(build(), () => "#t", {}, deps)

  it("says loading before the first snapshot", () => {
    expect(mtTreeHtml([], () => "", {}, deps)).toContain("Loading the machines")
    expect(mtTreeHtml(mtModel([]), () => "", {}, deps)).toContain("Loading the machines")
  })

  it("draws mesh › machine › run with the glossary's words (C4)", () => {
    expect(html).toContain('data-lt-key="mesh:own"')
    expect(html).toMatch(/Your mesh<\/span><span class="lt__n" title="3 of 4 machines answer">3\/4<\/span>/)
    expect(html).toContain('title="3 working, 4 runs"')
    expect(html).toContain('title="2 working, 3 runs"')
    expect(html).toContain("Job: nightly-sweep")
    expect(html).toContain("Nothing running.")
    expect(html).toContain("Does not answer, so its runs are not shown.")
    expect(html).not.toMatch(/idle<\/span>|Done in the last hour|No project/)
    expect(html).toContain('class="lt__ws"')
  })

  it("keeps a reader's fold", () => {
    const closed = mtTreeHtml(build(), () => "#t", { "m:http://mac": true }, deps)
    expect(closed).toMatch(/<details class="lt__m" data-lt-key="m:http:\/\/mac"><summary>/)
    expect(closed).toMatch(/<details class="lt__m" data-lt-key="m:http:\/\/peer" open>/)
  })

  it("escapes machine names", () => {
    const evil = mtTreeHtml(build([{ id: "x", name: "<b>x</b>", url: "http://x", reachable: true, agents: [] }]), () => "", {}, deps)
    expect(evil).toContain("&lt;b&gt;x&lt;/b&gt;")
    expect(evil).not.toContain("<b>x</b>")
  })

  it("counts in words", () => {
    expect(mtCountWords(1, 1)).toBe("1 working")
    expect(mtCountWords(2, 3)).toBe("2 working, 3 runs")
  })
})

describe("the side menu", () => {
  const page = renderWallPage()
  const nav = page.slice(page.indexOf('class="ax-wall__nav"'), page.indexOf("</nav>"))

  it("has a folded Machines under the one agent list", () => {
    expect(nav).toMatch(/<details class="lt ha__fold mt" id="wall-machines"><summary class="ha__h">Machines <span id="wall-machines-n"/)
    expect(nav.indexOf('id="hub-agents"')).toBeLessThan(nav.indexOf('id="wall-machines"'))
    expect(nav.match(/id="hub-agents"/g)).toHaveLength(1)
    expect(nav).not.toContain("Machines and runs")
  })
})
