import { describe, expect, it } from "vitest"
import { liveTreeModel, liveWorkCount, ltEsc, ltFold, ltRowHtml, ltTitle, type LtNode } from "../src/daemon/ui/pages/wall-tree"
import { ltAddWorkers, ltWorkerHtml } from "../src/daemon/ui/pages/wall-tree-workers"
import { mtCountWords, mtListed, mtModel, mtTreeHtml, mtWorkersHtml, type MtMesh } from "../src/daemon/ui/pages/wall-machines"
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
  under: (r: any) => mtWorkersHtml(r.workers, () => "#w", ltEsc, (ms: number) => String(ms), ltWorkerHtml),
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

  // Hakim C5 (2026-11-26): Builder on Studio hands off to Tester, whose
  // run goes on Workshop. Tester shows once, as its own run on Workshop;
  // under Builder's run it is one pointer line, no state, no run details.
  it("shows a hand-off run on another machine once, with a pointer under its parent (C5)", () => {
    const nodes: LtNode[] = [
      { id: "studio", name: "Studio", url: "http://studio", reachable: true, agents: [
        { id: "builder", name: "Builder", runningTasks: [run("b1", { workers: [
          { kind: "handoff", id: "h9", title: "Run the checkout e2e suite", status: "running", agentId: "tester", peer: "workshop" },
          { kind: "handoff", id: "h8", title: "Lint the old branch", status: "done", agentId: "linter", endedAt: ago(5_000) },
        ] })] },
      ] },
      { id: "workshop", name: "Workshop", url: "http://workshop", reachable: true, agents: [
        { id: "tester", name: "Tester", runningTasks: [run("t1", { messagePreview: "Run the checkout e2e suite", parent: { taskId: "b1", agentId: "builder", node: "studio" } })] },
      ] },
    ]
    const meshes = build(nodes)
    const b1 = meshes[0].machines[0].rows[0]
    expect(b1.workers!.map((w) => [w.agentId, mtListed(w)])).toEqual([["tester", true], ["linter", false]])
    const out = mtTreeHtml(meshes, () => "#t", {}, deps)
    // The task title and the agent's state show once: on Workshop.
    expect(out.match(/Run the checkout e2e suite<\/span>/g)).toHaveLength(1)
    const studio = out.slice(out.indexOf('data-lt-key="m:http://studio"'), out.indexOf('data-lt-key="m:http://workshop"'))
    const workshop = out.slice(out.indexOf('data-lt-key="m:http://workshop"'))
    expect(studio).toContain('class="lt__wk lt__ptr" href="#w"')
    expect(studio).toContain(">→ Tester on Workshop</a>")
    expect(studio).not.toMatch(/Tester<\/span>|lt__sub">Tester/)
    expect(workshop).toContain("Run the checkout e2e suite")
    // An ended hand-off is no row elsewhere: it keeps its full worker row.
    expect(studio).toContain("Lint the old branch")
  })

  it("shows no agent twice anywhere in the fold, hand-offs included (C5)", () => {
    // seif (Peer) runs d1's hand-off: its run row on Peer, a pointer on the Mac.
    const mac = html.slice(html.indexOf('data-lt-key="m:http://mac"'), html.indexOf('data-lt-key="m:http://clawd"'))
    expect(mac).toContain(">→ seif on Peer</a>")
    // Its task text is only the pointer's hover title, never a row.
    expect(mac).not.toContain(">Check the deploy<")
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
    // The same header as the agent groups: lucide chevron, title, count (orca-design C22).
    expect(nav).toMatch(/<details class="lt ha__fold mt" id="wall-machines"><summary class="ha__h"><span class="ha__chev" aria-hidden="true"><svg class="lucide lucide-chevron-right"[^]*?<\/span><span class="ha__ht">Machines<\/span><span class="ha__hn" id="wall-machines-n"/)
    expect(nav.indexOf('id="hub-agents"')).toBeLessThan(nav.indexOf('id="wall-machines"'))
    expect(nav.match(/id="hub-agents"/g)).toHaveLength(1)
    expect(nav).not.toContain("Machines and runs")
  })
})

// #2101-state: Hakim saw "0/2 checking…" over rows of runs going now.
describe("a slow machine with its last answer (#2101-state)", () => {
  const slow: LtNode[] = [{ ...NODES[0], checking: true, staleSince: ago(20_000) }, NODES[2]]
  const [mesh] = build(slow)

  it("counts as answering, and its runs add up to the Working count", () => {
    expect(mesh.online).toBe(2)
    expect(mesh.working).toBe(liveWorkCount(slow).agents)
    expect(mesh.machines[0]).toMatchObject({ state: "checking", working: 2, runs: 3 })
  })

  it("shows its number and as of, not checking…", () => {
    const html = mtTreeHtml([mesh], () => "#r", {}, deps)
    expect(html).not.toContain("checking…")
    expect(html).toContain('<span class="lt__badge is-live" title="2 working, 3 runs">2</span>')
    expect(html).toContain("as of ")
  })

  it("still says checking… when it has no answer yet", () => {
    const [m] = build([{ id: "http://mac", name: "MacBook-Local", url: "http://mac", reachable: false, checking: true, agents: [] }])
    expect(m.online).toBe(0)
    expect(mtTreeHtml([m], () => "#r", {}, deps)).toContain("checking…")
  })
})
