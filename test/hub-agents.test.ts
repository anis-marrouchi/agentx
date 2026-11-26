import { describe, expect, it } from "vitest"
import { haFace, haHitCount, haListHtml, haSwitchHits, haSwitchHtml, hubAgentRows, type HaNeed } from "../src/daemon/ui/pages/hub-agents"
import { HUB_NAV_CSS, hubMobilePageHtml } from "../src/daemon/ui/pages/hub-nav"
import { liveWorkCount, ltAge, ltEsc, ltPlain, ltTitle, type LtNode } from "../src/daemon/ui/pages/wall-tree"
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
  const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain, liveWorkCount(nodes))
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
  const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain, liveWorkCount(nodes))
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
    const h = haListHtml(m, "working", "", false, ltEsc, ltAge)
    expect(h).toContain('data-ha-agent="coder"')
    expect(h).not.toContain('data-ha-agent="pm"')
    expect(h).not.toContain("Not working today")
  })
  it("shows Needs you as a group only, not a chip; a saved needs filter shows all (#2101 R27)", () => {
    const h = haListHtml(m, "needs", "", false, ltEsc, ltAge)
    expect(h).not.toContain('data-ha-filter="needs"')
    expect(h).toContain('data-ha-filter="all" aria-pressed="true"')
    expect(h.match(/Needs you/g)).toHaveLength(1)
    expect(h).toContain('data-ha-agent="coder"')
  })
  it("sends a working agent's row to the link the browser gives, others to their chat (#2101 R26)", () => {
    const href = (r: { id: string; taskId: string }) => r.taskId ? "#page=task&task=" + r.taskId + "&agent=" + r.id : ha.haChatHref(r as never)
    const h = haListHtml(m, "all", "", false, ltEsc, ltAge, href)
    expect(h).toContain('href="#page=task&amp;task=t1&amp;agent=coder" data-ha-agent="coder"')
    expect(h).toContain('href="#page=chat&amp;agent=pm" data-ha-agent="pm"')
    const k = haSwitchHtml(haSwitchHits(m.rows, [], "main"), 0, ltEsc, href)
    expect(k).toContain('href="#page=task&amp;task=t2&amp;agent=main"')
  })
  it("escapes fleet text and drops a colour that is not a hex colour", () => {
    const badNodes: LtNode[] = [{ name: "<b>n</b>", reachable: true, agents: [{ id: "x\"y", name: "<img>", color: "red;background:url(x)", runningTasks: [{ id: "t", messagePreview: "<script>alert(1)</script>" }] }] }]
    const bad = hubAgentRows(badNodes, [], NOW, DAY, title, ltPlain, liveWorkCount(badNodes))
    const h = haListHtml(bad, "all", "", false, ltEsc, ltAge)
    expect(h).not.toContain("<script>")
    expect(h).not.toContain("<img>")
    expect(h).not.toContain("url(x)")
    expect(h).toContain("&lt;b&gt;n&lt;/b&gt;")
  })
  it("says so when there are no agents", () => {
    expect(haListHtml(hubAgentRows([], [], NOW, DAY, title, ltPlain, liveWorkCount([])), "all", "", false, ltEsc, ltAge)).toContain("No agents yet.")
  })
  // #2270: the chat only streams runs started from it, so a working row opens its run.
  it("opens a working agent's live run; other rows and a gone run open the chat", () => {
    const seen: string[] = []
    const runHref = (r: { id: string; taskId: string; nodeUrl: string }) => {
      seen.push(r.id)
      return r.taskId === "t1" ? "#page=task&task=t1&agent=" + r.id + "&node=" + encodeURIComponent(r.nodeUrl) : ""
    }
    const h = haListHtml(m, "all", "", false, ltEsc, ltAge, runHref)
    expect(h).toContain('href="#page=task&amp;task=t1&amp;agent=coder&amp;node=http%3A%2F%2Fmac" data-ha-agent="coder" data-ha-run')
    expect(h).toContain("Opens its live run")
    expect(h).toContain('href="#page=chat&amp;agent=main" data-ha-agent="main"')
    expect(h).toContain('href="#page=chat&amp;agent=pm" data-ha-agent="pm"')
    expect(seen.sort()).toEqual(["coder", "main"])
  })
  it("draws no sliding stripe under a working row (#2270)", () => {
    expect(haListHtml(m, "all", "", false, ltEsc, ltAge)).not.toContain("ha__bar")
  })
})

// Anis 2026-11-26: the side menu was too long. Needs you starts folded,
// Working shows 3 rows and Show all (N).
describe("a short side menu", () => {
  const many: LtNode[] = [{ name: "Mac", url: "http://mac", reachable: true, agents: [
    ...["a1", "a2", "a3", "a4", "a5"].map((id, i) => ({ id, name: id, runningTasks: [{ id: "t" + id, messagePreview: "Run " + id, lastActivity: ago((i + 1) * 10_000) }] })),
    { id: "q1", name: "q1" }, { id: "q2", name: "q2" },
  ] }]
  const asks: HaNeed[] = [{ key: "c1", title: "Yes?", agent: "q1", at: NOW - 1000 }, { key: "c2", title: "Go?", agent: "q2", at: NOW - 2000 }]
  const mm = hubAgentRows(many, asks, NOW, DAY, title, ltPlain, liveWorkCount(many))
  const rowsOf = (h: string) => (h.match(/data-ha-agent="([^"]+)"/g) || []).map((x) => x.slice(15, -1))
  it("folds Needs you on first load and keeps its count in the header", () => {
    const h = haListHtml(mm, "all", "", {}, ltEsc, ltAge)
    expect(h).toContain('<details class="ha__fold" data-ha-open="needs"><summary class="ha__h">Needs you <span>2</span></summary>')
    expect(haListHtml(mm, "all", "", { needs: true }, ltEsc, ltAge)).toContain('data-ha-open="needs" open>')
  })
  it("shows 3 working agents, then Show all (N), and all of them once opened", () => {
    const h = haListHtml(mm, "all", "", {}, ltEsc, ltAge)
    expect(rowsOf(h).filter((id) => id.startsWith("a"))).toEqual(["a1", "a2", "a3"])
    expect(h).toContain("Working <span>5</span>")
    expect(h).toContain('data-ha-more="working" aria-expanded="false">Show all (5)</button>')
    const all = haListHtml(mm, "all", "", { working: true }, ltEsc, ltAge)
    expect(rowsOf(all).filter((id) => id.startsWith("a"))).toEqual(["a1", "a2", "a3", "a4", "a5"])
    expect(all).toContain('aria-expanded="true">Show fewer</button>')
  })
  it("shows every working agent under the Working chip, and no button at 3 or fewer", () => {
    const h = haListHtml(mm, "working", "", {}, ltEsc, ltAge)
    expect(rowsOf(h)).toEqual(["a1", "a2", "a3", "a4", "a5"])
    expect(h).not.toContain("data-ha-more")
    expect(haListHtml(m3(), "all", "", {}, ltEsc, ltAge)).not.toContain("data-ha-more")
  })
  it("still takes the old idleOpen boolean", () => {
    expect(haListHtml(mm, "all", "", true, ltEsc, ltAge)).not.toContain('data-ha-open="needs" open')
  })
  function m3() {
    const three: LtNode[] = [{ ...many[0], agents: many[0].agents!.slice(0, 3) }]
    return hubAgentRows(three, [], NOW, DAY, title, ltPlain, liveWorkCount(three))
  }
})

describe("the switcher", () => {
  const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain, liveWorkCount(nodes))
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
    expect(haSwitchHtml({ agents: [], reqs: [] }, 0, ltEsc)).toContain("No agent, request or page")
  })
  it("lists the pages the side menu no longer shows, and finds them by name (#2101 R22)", () => {
    const pages = [{ key: "cost", label: "Cost", href: "#status=open&view=cost" }, { key: "dash-mesh", label: "Dashboard · Operations", href: "/mesh" }]
    expect(haSwitchHits(m.rows, reqs, "", pages).pages).toHaveLength(2)
    const h = haSwitchHits(m.rows, reqs, "cost", pages)
    expect(h.pages!.map((p) => p.key)).toEqual(["cost"])
    const html = haSwitchHtml(h, haHitCount(h) - 1, ltEsc)
    expect(html).toContain(">Pages<")
    expect(html).toContain('aria-selected="true" href="#status=open&amp;view=cost"')
    expect(haHitCount(h)).toBe(h.agents.length + h.reqs.length + 1)
  })
  it("face letters", () => {
    expect(haFace("secretary")).toBe("S")
    expect(haFace("")).toBe("?")
    expect(haFace("é-agent")).toBe("É")
  })
})

describe("the Hub page's left column", () => {
  const page = renderWallPage({ owner: true })
  it("opens with the switcher and the one agent list; the old page menu is not shown (#2101 R22)", () => {
    const k = page.indexOf('id="hub-k"'), agents = page.indexOf('id="hub-agents"')
    expect(k).toBeGreaterThan(0)
    expect(k).toBeLessThan(agents)
    const nav = page.slice(page.indexOf('class="ax-wall__nav"'), page.indexOf("</nav>"))
    const shown = nav.slice(0, nav.indexOf('id="wall-pagelinks"'))
    for (const gone of ['data-nav="wall"', 'data-nav="cost"', 'data-nav="org"', "ax-wall__newpost", "New post", "Light / dark", "ax-wall__navfoot"]) {
      expect(shown.replace(/<a class="ax-wall__item ax-wall__shortcut[^>]*>/g, "")).not.toContain(gone)
    }
    expect(nav).toMatch(/<div class="ax-wall__pagelinks" id="wall-pagelinks" hidden>/)
  })
  it("lists the agents once: no Machines and runs tree beside the list (#2101 R26)", () => {
    const nav = page.slice(page.indexOf('class="ax-wall__nav"'), page.indexOf("</nav>"))
    expect(nav).not.toContain('id="wall-tree"')
    expect(nav).not.toContain("Machines and runs")
    expect(nav.match(/id="hub-agents"/g)).toHaveLength(1)
  })
  it("shows each place once in the side menu on a computer (#2101 R27)", () => {
    const nav = page.slice(page.indexOf('class="ax-wall__nav"'), page.indexOf('id="wall-pagelinks"'))
    // The phone bar's shortcuts are hidden on a computer (wall-space.ts).
    const desktop = nav.replace(/<a class="ax-wall__item ax-wall__shortcut[^]*?<\/a>/g, "")
    expect(desktop.match(/view=decide/g)).toHaveLength(1)
    expect(desktop).not.toContain(">Needs you<")
  })
  it("scrolls the side menu as one, with the switcher and the foot row pinned (Anis 2026-11-26)", () => {
    const wide = HUB_NAV_CSS.slice(HUB_NAV_CSS.indexOf("@media (min-width: 1181px) {"))
    const block = wide.slice(0, wide.indexOf("\n}") + 2)
    // No scroll box of its own for the list: the wheel works anywhere on the menu.
    expect(block).toContain(".ax-wall__nav > .ha { flex: 1 0 auto; }")
    expect(HUB_NAV_CSS).not.toMatch(/\.ax-wall__nav > \.ha \{[^}]*overflow-y/)
    expect(block).toMatch(/\.ax-wall__nav > \.ha__k \{ position: sticky;/)
    expect(block).toMatch(/\.ax-wall__nav > \.hf \{ position: sticky; bottom: 0;/)
  })
  it("ends with Waiting on you (the Desk, #2226), Jobs, Workflows, Mobile app and Settings", () => {
    const foot = page.slice(page.indexOf('id="hub-foot"'), page.indexOf('id="wall-pagelinks"'))
    for (const w of ['data-nav="needs" href="#status=open&amp;view=decide"', ">Waiting on you<", ">Jobs<", ">Workflows<", 'href="#page=mobile"', 'data-nav="settings"']) expect(foot).toContain(w)
    expect(renderWallPage().includes('class="hf__item hf__set"')).toBe(false)
  })
  it("has the Mobile app setup page without an unpaired app preview link", () => {
    expect(page).toContain('id="wall-mobile"')
    const m = hubMobilePageHtml()
    expect(m).toContain("agentx app pair")
    // Anis 2026-11-25: the guide button opens the docs website page, not the raw .md on GitHub.
    expect(m).toContain('href="https://agentx-docs.pages.dev/dashboard/mobile-app"')
    expect(m).not.toContain(".md")
    expect(m).not.toContain("github.com")
    expect(m).not.toContain('href="/app"')
  })
  it("ships the model so the browser can run it (bound under its own names)", () => {
    const code = injectFns({ haFace: ha.haFace, hubAgentRows: ha.hubAgentRows, haChatHref: ha.haChatHref, haListHtml: ha.haListHtml, haRowHtml: ha.haRowHtml, haFold: ha.haFold, haSwitchHits: ha.haSwitchHits, haSwitchHtml: ha.haSwitchHtml, haChannelLabel: ha.haChannelLabel, haRunAt: ha.haRunAt, haRunsHtml: ha.haRunsHtml })
    const fn = new Function("ltTitle", "ltPlain", "ltEsc", "ltAge", "liveWorkCount", "nodes", "needs", "NOW", "DAY", code + "; return haListHtml(hubAgentRows(nodes, needs, NOW, DAY, function (t) { return ltTitle(t, null) }, ltPlain, liveWorkCount(nodes)), 'all', '', false, ltEsc, ltAge)")
    expect(fn(ltTitle, ltPlain, ltEsc, ltAge, liveWorkCount, nodes, needs, NOW, DAY)).toContain('data-ha-agent="coder"')
  })
})

// #2328: a voice turn beside an older job did not show. The row named one
// run, picked by lastActivity, which is the run's last output line, not a
// time: every run that had written something tied and the oldest won.
describe("an agent with more than one run (#2328)", () => {
  const two: LtNode[] = [{ name: "MacBook-Local", url: "http://mac", reachable: true, agents: [
    { id: "devops", name: "DevOps", runningTasks: [
      { id: "job", channel: "a2a", sender: "agent:coder-agent", messagePreview: "[Job state] Before you end this run", startedAt: ago(1_200_000), lastActivity: "→ Bash({\"command\":\"ls\"})" },
      { id: "call", channel: "voice", chatId: "voice:devops", messagePreview: "What is the deploy status?", startedAt: ago(20_000), lastActivity: "· Checking" },
      { id: "gl", channel: "gitlab", messagePreview: "Review MR !12", startedAt: ago(600_000), lastActivity: "← ok" },
    ] },
  ] }]
  const m = hubAgentRows(two, [], NOW, DAY, title, ltPlain, liveWorkCount(two))
  const row = m.rows[0]

  it("names the newest run, by its start, whatever its last line says", () => {
    expect(row.taskId).toBe("call")
    expect(row.line).toBe("Voice · What is the deploy status?")
    expect(row.ageMs).toBe(20_000)
    expect(row.runs).toBe(3)
  })
  it("keeps the other runs, newest first, with their channel", () => {
    expect(row.more).toEqual([
      { taskId: "gl", channel: "GitLab", line: "Review MR !12" },
      { taskId: "job", channel: "Agent to agent", line: "Job for coder-agent" },
    ])
  })
  it("still orders by lastActivity when it is a time", () => {
    expect(ha.haRunAt({ id: "x", lastActivity: ago(5_000), startedAt: ago(90_000) })).toBe(NOW - 5_000)
    expect(ha.haRunAt({ id: "x", lastActivity: "→ Read(a)", startedAt: ago(90_000) })).toBe(NOW - 90_000)
    expect(ha.haRunAt({ id: "x" })).toBe(0)
  })
  it("lists each other run under the row, each opening its own run", () => {
    const runHref = (r: { id: string; taskId: string }) => "#page=task&task=" + r.taskId + "&agent=" + r.id
    const h = haListHtml(m, "all", "", false, ltEsc, ltAge, runHref)
    expect(h).toContain('href="#page=task&amp;task=call&amp;agent=devops" data-ha-agent="devops" data-ha-run')
    expect(h).toContain('<a class="ha__run" href="#page=task&amp;task=gl&amp;agent=devops" data-ha-run')
    expect(h).toContain('<b class="ha__rch">Agent to agent</b> Job for coder-agent')
    expect(h.indexOf("task=call")).toBeLessThan(h.indexOf("task=gl"))
  })
  it("shows 3 other runs, then how many more; no list for one run", () => {
    const five = { ...row, more: [1, 2, 3, 4, 5].map((i) => ({ taskId: "r" + i, channel: "Voice", line: "turn " + i })) }
    const h = ha.haRunsHtml(five, ltEsc)
    expect((h.match(/class="ha__run"/g) || []).length).toBe(3)
    expect(h).toContain("+2 more runs")
    expect(ha.haRunsHtml({ ...row, more: [] }, ltEsc)).toBe("")
  })
  it("a single voice turn says Voice and lists nothing under it", () => {
    const one: LtNode[] = [{ name: "Mac", url: "http://mac", reachable: true, agents: [
      { id: "secretary", name: "secretary", runningTasks: [{ id: "v", channel: "voice", messagePreview: "Read me my day", startedAt: ago(3_000) }] },
    ] }]
    const r = hubAgentRows(one, [], NOW, DAY, title, ltPlain, liveWorkCount(one)).rows[0]
    expect(r.state).toBe("working")
    expect(r.line).toBe("Voice · Read me my day")
    expect(r.more).toBeUndefined()
  })
})
