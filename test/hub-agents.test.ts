import { describe, expect, it } from "vitest"
import { haFace, haListHtml, haSwitchHits, haSwitchHtml, hubAgentRows, type HaNeed } from "../src/daemon/ui/pages/hub-agents"
import { hubMobilePageHtml } from "../src/daemon/ui/pages/hub-nav"
import { ltAge, ltEsc, ltPlain, ltTitle, type LtNode } from "../src/daemon/ui/pages/wall-tree"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { injectFns } from "../src/daemon/ui/inject"
import * as ha from "../src/daemon/ui/pages/hub-agents"

const NOW = Date.parse("2026-11-24T12:00:00Z")
const DAY = Date.parse("2026-11-24T00:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const title = (t: Parameters<typeof ltTitle>[0]) => ltTitle(t, null)

const nodes: LtNode[] = [
  { name: "Mac", url: "http://mac", reachable: true, agents: [
    { id: "coder", name: "coder", color: "#2979FF", runningTasks: [{ id: "t1", messagePreview: "Restyle the phone app", startedAt: ago(240_000), lastActivity: ago(60_000) }] },
    { id: "pm", name: "pm", lastActive: ago(3_600_000), lastSummary: { text: "Reviewed", at: ago(3_600_000), ok: true } },
    { id: "secretary", name: "secretary", lastSummary: { text: "Morning digest sent [agentx:x]", at: ago(3_600_000), ok: true } },
    { id: "sales", name: "sales", lastSummary: { text: "Old", at: ago(2 * 86_400_000), ok: true } },
  ] },
  { name: "cloud", url: "http://cloud", reachable: true, agents: [
    { id: "coder", name: "coder (copy)" },
    { id: "main", name: "main", runningTasks: [{ id: "t2", messagePreview: "Checking the client site", lastActivity: ago(540_000) }] },
  ] },
  { name: "down", url: "http://down", reachable: false, agents: [{ id: "ghost", name: "ghost", runningTasks: [{ id: "t3" }] }] },
]
const needs: HaNeed[] = [
  { key: "card:1", title: "Accept the design note?", agent: "pm", at: NOW - 720_000 },
  { key: "card:2", title: "Later one", agent: "sales", at: NOW - 60_000, snoozed: NOW + 3_600_000 },
  { key: "card:3", title: "Approve the release?", agent: "coder", at: NOW - 30_000 },
  { key: "card:4", title: "Approve it too?", agent: "coder", at: NOW - 20_000 },
]

describe("hubAgentRows", () => {
  const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain)
  const by = (id: string) => m.rows.find((r) => r.id === id)!

  it("groups every agent once: working, needs you, done today, idle", () => {
    expect(m.rows.map((r) => [r.id, r.state])).toEqual([
      ["coder", "working"], ["main", "working"], ["pm", "needs"], ["secretary", "done"], ["sales", "idle"],
    ])
    expect(m.counts).toEqual({ all: 4, working: 2, needs: 1, done: 1, idle: 1 })
  })
  it("keeps the first node's copy and leaves out nodes that do not answer", () => {
    expect(by("coder").node).toBe("Mac")
    expect(m.rows.some((r) => r.id === "ghost")).toBe(false)
  })
  it("says the run, the question or the last summary, and counts open questions", () => {
    expect(by("coder").line).toBe("Restyle the phone app")
    expect(by("coder").unread).toBe(2)
    expect(by("coder").taskId).toBe("t1")
    expect(by("pm").line).toBe("Accept the design note?")
    expect(by("secretary").line).toBe("Morning digest sent")
    expect(by("sales").unread).toBe(0) // put off: not counted
    expect(by("coder").ageMs).toBe(60_000)
    expect(by("coder").face).toBe("C")
  })
})

describe("haListHtml", () => {
  const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain)
  it("draws the chips, the groups and the current agent", () => {
    const h = haListHtml(m, "all", "pm", false, ltEsc, ltAge)
    expect(h).toContain('data-ha-filter="all" aria-pressed="true">All <b>4</b>')
    expect(h).toContain("Working <span>2</span>")
    expect(h).toContain("Needs you <span>1</span>")
    expect(h).toContain("Done today <span>1</span>")
    expect(h).toContain("Not working today <span>1</span>")
    expect(h).toContain('href="#page=chat&amp;agent=pm" data-ha-agent="pm" aria-current="true"')
    expect(h).toContain('style="--ha-c:#2979FF"')
    expect(h).toContain('<b class="ha__n" title="2 questions for you">2</b>')
  })
  it("filters to one group", () => {
    const h = haListHtml(m, "needs", "", false, ltEsc, ltAge)
    expect(h).toContain('data-ha-agent="pm"')
    expect(h).not.toContain('data-ha-agent="coder"')
    expect(h).not.toContain("Not working today")
  })
  it("escapes fleet text and drops a colour that is not a hex colour", () => {
    const bad = hubAgentRows([{ name: "<b>n</b>", reachable: true, agents: [{ id: "x\"y", name: "<img>", color: "red;background:url(x)", runningTasks: [{ id: "t", messagePreview: "<script>alert(1)</script>" }] }] }], [], NOW, DAY, title, ltPlain)
    const h = haListHtml(bad, "all", "", false, ltEsc, ltAge)
    expect(h).not.toContain("<script>")
    expect(h).not.toContain("<img>")
    expect(h).not.toContain("url(x)")
    expect(h).toContain("&lt;b&gt;n&lt;/b&gt;")
  })
  it("says so when there are no agents", () => {
    expect(haListHtml(hubAgentRows([], [], NOW, DAY, title, ltPlain), "all", "", false, ltEsc, ltAge)).toContain("No agents yet.")
  })
})

describe("the switcher", () => {
  const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain)
  const reqs = [{ id: "r1", title: "Restyle the phone app", sub: "coder" }, { id: "r2", title: "Client site" }]
  it("puts the agents that need you first when nothing is typed", () => {
    const h = haSwitchHits(m.rows, reqs, "")
    expect(h.agents[0].id).toBe("pm")
    expect(h.reqs.length).toBe(2)
  })
  it("matches names first, then lines, and requests by title", () => {
    const h = haSwitchHits(m.rows, reqs, "Restyle")
    expect(h.agents.map((r) => r.id)).toEqual(["coder"])
    expect(h.reqs.map((r) => r.id)).toEqual(["r1"])
    expect(haSwitchHits(m.rows, reqs, "s").agents.map((r) => r.id).slice(0, 2)).toEqual(["secretary", "sales"])
    expect(haSwitchHits(m.rows, reqs, "zzz").agents).toEqual([])
  })
  it("draws ⌘ numbers, the selection and the request links", () => {
    const html = haSwitchHtml(haSwitchHits(m.rows, reqs, ""), 1, ltEsc)
    expect(html).toContain("⌘1")
    expect(html).toContain('aria-selected="true" href="#page=chat&amp;agent=coder"')
    expect(html).toContain('href="#status=open&amp;post=r1"')
    expect(haSwitchHtml({ agents: [], reqs: [] }, 0, ltEsc)).toContain("No agent or request")
  })
  it("face letters", () => {
    expect(haFace("secretary")).toBe("S")
    expect(haFace("")).toBe("?")
    expect(haFace("é-agent")).toBe("É")
  })
})

describe("the Hub page's left column", () => {
  const page = renderWallPage({ owner: true })
  it("opens with the switcher and the agents, then the machines, then the pages", () => {
    const k = page.indexOf('id="hub-k"'), agents = page.indexOf('id="hub-agents"'), tree = page.indexOf('id="wall-tree"'), nav = page.indexOf('data-nav="wall"')
    expect(k).toBeGreaterThan(0)
    expect(k).toBeLessThan(agents)
    expect(agents).toBeLessThan(tree)
    expect(tree).toBeLessThan(nav)
  })
  it("ends with Desk, Jobs, Workflows, Mobile app and Settings", () => {
    const foot = page.slice(page.indexOf('id="hub-foot"'), page.indexOf('class="ax-wall__navfoot"'))
    for (const w of ['data-nav="needs" href="#status=open&amp;view=decide"', ">Desk<", ">Jobs<", ">Workflows<", 'href="#page=mobile"', 'data-nav="settings"']) expect(foot).toContain(w)
    expect(renderWallPage().includes('class="hf__item hf__set"')).toBe(false)
  })
  it("has the Mobile app page, with relative links only to this computer", () => {
    expect(page).toContain('id="wall-mobile"')
    const m = hubMobilePageHtml()
    expect(m).toContain("agentx app pair")
    expect(m).toContain('href="/app"')
  })
  it("ships the model so the browser can run it (bound under its own names)", () => {
    const code = injectFns({ haFace: ha.haFace, hubAgentRows: ha.hubAgentRows, haListHtml: ha.haListHtml, haRowHtml: ha.haRowHtml, haFold: ha.haFold, haSwitchHits: ha.haSwitchHits, haSwitchHtml: ha.haSwitchHtml })
    const fn = new Function("ltTitle", "ltPlain", "ltEsc", "ltAge", "nodes", "needs", "NOW", "DAY", code + "; return haListHtml(hubAgentRows(nodes, needs, NOW, DAY, function (t) { return ltTitle(t, null) }, ltPlain), 'all', '', false, ltEsc, ltAge)")
    expect(fn(ltTitle, ltPlain, ltEsc, ltAge, nodes, needs, NOW, DAY)).toContain('data-ha-agent="coder"')
  })
})
