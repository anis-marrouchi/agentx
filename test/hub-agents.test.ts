import { describe, expect, it } from "vitest"
import { haDownHtml, haFace, haHitCount, haListHtml, haRailHtml, haSwitchHits, haSwitchHtml, hubAgentRows, type HaNeed } from "../src/daemon/ui/pages/hub-agents"
import { HUB_NAV_CSS, HUB_NAV_ICON_NAMES, HUB_PAGE_ICON, hubMobilePageHtml } from "../src/daemon/ui/pages/hub-nav"
import { hubIconMap } from "../src/daemon/ui/pages/hub-lucide"
import { liveWorkCount, ltAge, ltEsc, ltPlain, ltTitle, type LtNode, type LtTask } from "../src/daemon/ui/pages/wall-tree"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { injectFns } from "../src/daemon/ui/inject"
import * as ha from "../src/daemon/ui/pages/hub-agents"

const NOW = Date.parse("2026-11-24T12:00:00Z")
const DAY = Date.parse("2026-11-24T00:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const title = (t: Parameters<typeof ltTitle>[0]) => ltTitle(t, null)
const ic = hubIconMap(HUB_NAV_ICON_NAMES)

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

  it("groups every agent once, in the one state order: needs you, working, done today, idle", () => {
    expect(m.rows.map((r) => [r.id, r.state])).toEqual([
      ["pm", "needs"], ["coder", "working"], ["main", "working"], ["secretary", "done"], ["sales", "idle"],
    ])
    expect(m.counts).toEqual({ all: 4, working: 2, needs: 1, failed: 0, done: 1, idle: 1 })
  })
  it("names the machines that do not answer, once", () => {
    expect(m.down).toEqual(["down"])
    expect(hubAgentRows(nodes.slice(0, 2), [], NOW, DAY, title, ltPlain, liveWorkCount(nodes)).down).toBeUndefined()
  })
  it("puts an agent whose last run today failed under Needs you, with the reason", () => {
    const ns: LtNode[] = [{ name: "Mac", url: "http://mac", reachable: true, agents: [
      { id: "graph", name: "Graph Agent", lastSummary: { text: "the answer was not valid JSON", at: ago(60_000), ok: false } },
    ] }]
    const fm = hubAgentRows(ns, [], NOW, DAY, title, ltPlain, liveWorkCount(ns))
    expect(fm.rows[0].state).toBe("failed")
    expect(fm.rows[0].line).toBe("Run failed: the answer was not valid JSON")
    expect(fm.counts.failed).toBe(1)
    const h = haListHtml(fm, "", { needs: true }, ltEsc, ltAge, { ic })
    expect(h).toContain('data-key="g:needs"')
    expect(h).toContain('<span class="ha__si is-failed" aria-hidden="true"><svg class="lucide lucide-circle-x"')
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

describe("the counts next to each agent (#2145)", () => {
  // 24 hourly slots, oldest first; the last one ends at NOW (12:00Z), so
  // slots 12..23 are today (00:00Z-12:00Z) and 11 ends exactly at midnight.
  const hourly = Array.from({ length: 24 }, (_, i) => (i === 11 ? 7 : i === 12 ? 2 : i === 23 ? 1 : i === 0 ? 9 : 0))

  it("sums the hours that are today, and nothing before midnight", () => {
    expect(ha.haRunsToday(hourly, NOW, DAY)).toBe(3)
    expect(ha.haRunsToday(hourly, NOW, NOW - 3600_000)).toBe(1)
    expect(ha.haRunsToday(undefined, NOW, DAY)).toBe(0)
    expect(ha.haRunsToday([1, "x", -2, null], NOW, 0)).toBe(1)
  })
  it("counts a slot that is partly today (a run can be up to 59 min before midnight)", () => {
    // Midnight at 11:30Z: the slot 11:00-12:00Z (index 23) counts whole.
    expect(ha.haRunsToday(hourly, NOW, NOW - 1800_000)).toBe(1)
  })
  it("gives each row its runs going and runs today, the Hub and the phone alike", () => {
    const ns: LtNode[] = [{ name: "Mac", url: "http://mac", reachable: true, agents: [
      { id: "lead", name: "lead", hourlyTasks: hourly, runningTasks: [{ id: "a", startedAt: ago(60_000) }, { id: "b", startedAt: ago(120_000) }] },
      { id: "quiet", name: "quiet" },
    ] }]
    const m = hubAgentRows(ns, [], NOW, DAY, title, ltPlain, liveWorkCount(ns))
    const lead = m.rows.find((r) => r.id === "lead")!
    // 3 finished today from the hourly slots + the 2 going, started today.
    expect([lead.runs, lead.today]).toEqual([2, 5])
    const h = ha.haRowHtml(lead, "", ltEsc, ltAge, { ic })
    expect(h).toContain('<span class="ha__stats" data-tip="2 running now, 5 runs today">')
    expect(h).toMatch(/<span data-stat="now"><svg [^]*?<\/svg>2<\/span><span data-stat="today"><svg [^]*?<\/svg>5<\/span><span class="ax-sr">2 running now, 5 runs today<\/span>/)
    // Next to the name, before the time.
    expect(h.indexOf("ha__stats")).toBeGreaterThan(h.indexOf("ha__name"))
    expect(h.indexOf("ha__stats")).toBeLessThan(h.indexOf("<time"))
    const quiet = m.rows.find((r) => r.id === "quiet")!
    expect([quiet.runs, quiet.today]).toEqual([0, 0])
    expect(ha.haRowHtml(quiet, "", ltEsc, ltAge)).not.toContain("ha__stats")
  })
  it("counts a run still going in runs today, by its start, not its last move", () => {
    // hourlyTasks holds finished runs only: a first run of the day is 1 today.
    const first: LtNode[] = [{ name: "Mac", url: "http://mac", reachable: true, agents: [
      { id: "new", name: "new", hourlyTasks: new Array(24).fill(0), runningTasks: [{ id: "a", startedAt: ago(60_000) }] },
      // Started before midnight, moved since: going, not today.
      { id: "late", name: "late", runningTasks: [{ id: "b", startedAt: new Date(DAY - 60_000).toISOString(), lastActivity: ago(1000) }] },
    ] }]
    const m = hubAgentRows(first, [], NOW, DAY, title, ltPlain, liveWorkCount(first))
    const row = (id: string) => m.rows.find((r) => r.id === id)!
    expect([row("new").runs, row("new").today]).toEqual([1, 1])
    expect([row("late").runs, row("late").today]).toEqual([1, 0])
    expect(ha.haRunStart({ id: "x" } as LtTask)).toBe(0)
  })
  it("says one run in the singular and leaves out a zero", () => {
    const row = { ...hubAgentRows(nodes, [], NOW, DAY, title, ltPlain, liveWorkCount(nodes)).rows[0], runs: 0, today: 1 }
    const h = ha.haRowHtml(row, "", ltEsc, ltAge)
    expect(h).toContain('data-tip="1 run today"')
    expect(h).not.toContain('data-stat="now"')
  })
  it("styles the counts quietly, with even-width digits", () => {
    expect(HUB_NAV_CSS).toMatch(/\.ha__stats \{[^}]*color: var\(--ax-muted\)[^}]*font-variant-numeric: tabular-nums/)
    // No machine tag on a row any more (the approved mock): the name keeps its room.
    expect(HUB_NAV_CSS).not.toContain(".ha__node")
  })
})

describe("haListHtml", () => {
  const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain, liveWorkCount(nodes))
  it("draws the groups with a chevron, title and count, and the current agent; no chips, no machine tag", () => {
    const h = haListHtml(m, "pm", { needs: true }, ltEsc, ltAge, { ic })
    expect(h).not.toContain("data-ha-filter")
    expect(h).not.toContain("ha__node")
    expect(h).toMatch(/<summary class="ha__h"><span class="ha__chev" aria-hidden="true"><svg class="lucide lucide-chevron-right"[^]*?<\/span><span class="ha__ht">Working<\/span><span class="ha__hn" data-n="2">2<\/span><\/summary>/)
    for (const [t, n] of [["Needs you", 1], ["Done today", 1], ["Not working today", 1]]) expect(h).toContain('<span class="ha__ht">' + t + '</span><span class="ha__hn" data-n="' + n + '">' + n + "</span>")
    expect(h).toContain('<div class="ha__row is-needs is-asks is-cur" data-key="a:pm" data-ha-agent="pm"><a class="ha__link" href="#page=chat&amp;agent=pm&amp;ask=card%3A1" aria-current="true">')
    expect(h).toContain('<b class="ax-af-count ha__n" data-tone="warn" data-n="2">2<span class="ax-sr"> questions for you</span></b>')
    // The groups in the one state order: Needs you, Working, Done today, Not working today.
    const at = (k: string) => h.indexOf('data-key="g:' + k + '"')
    expect(at("needs")).toBeLessThan(at("working"))
    expect(at("working")).toBeLessThan(at("done"))
    expect(at("done")).toBeLessThan(at("idle"))
  })
  it("draws each row as a neutral face and a lucide state icon, its age in a <time datetime>", () => {
    const h = haListHtml(m, "", false, ltEsc, ltAge, { ic })
    expect(h).not.toContain("--ha-c")
    expect(h).not.toContain("ha__dot")
    expect(h).toContain('<span class="ha__si is-working" aria-hidden="true"><svg class="lucide lucide-loader-circle"')
    expect(h).toContain('<span class="ha__si is-done" aria-hidden="true"><svg class="lucide lucide-circle-check"')
    expect(h).toContain('<time datetime="' + new Date(NOW - 60_000).toISOString() + '">1m</time>')
  })
  it("puts Stop and the row menu on a working row, only the menu on the others, when asked", () => {
    const h = haListHtml(m, "", { needs: true }, ltEsc, ltAge, { ic, acts: true })
    expect(h).toContain('data-ha-stop="coder" aria-label="Stop the run of coder"')
    expect(h).toContain('data-ha-menu="pm" aria-haspopup="menu" aria-expanded="false" aria-label="More for pm"')
    expect(h).not.toContain('data-ha-stop="pm"')
    expect(haListHtml(m, "", false, ltEsc, ltAge)).not.toContain("ha__acts")
  })
  it("keys every part, so a refresh patches rows in place", () => {
    const h = haListHtml(m, "", { needs: true }, ltEsc, ltAge, { ic })
    for (const k of ["g:needs", "g:working", "a:coder", "a:pm", "g:done", "g:idle"]) expect(h).toContain('data-key="' + k + '"')
  })
  it("sends a working agent's row to the link the browser gives, others to their chat (#2101 R26)", () => {
    const href = (r: { id: string; taskId: string }) => r.taskId ? "#page=task&task=" + r.taskId + "&agent=" + r.id : ha.haChatHref(r as never)
    const h = haListHtml(m, "", false, ltEsc, ltAge, { runHref: href })
    expect(h).toContain('href="#page=task&amp;task=t1&amp;agent=coder" data-ha-run')
    expect(h).toContain('href="#page=chat&amp;agent=pm&amp;ask=card%3A1"')
    const k = haSwitchHtml(haSwitchHits(m.rows, [], "main"), 0, ltEsc, href)
    expect(k).toContain('href="#page=task&amp;task=t2&amp;agent=main"')
  })
  it("escapes fleet text and never uses an agent's colour", () => {
    const badNodes: LtNode[] = [{ name: "<b>n</b>", reachable: true, agents: [{ id: "x\"y", name: "<img>", color: "red;background:url(x)", runningTasks: [{ id: "t", messagePreview: "<script>alert(1)</script>" }] }] }]
    const bad = hubAgentRows(badNodes, [], NOW, DAY, title, ltPlain, liveWorkCount(badNodes))
    const h = haListHtml(bad, "", false, ltEsc, ltAge, { acts: true })
    expect(h).not.toContain("<script>")
    expect(h).not.toContain("<img>")
    expect(h).not.toContain("url(x)")
    expect(h).toContain("&lt;img&gt;")
  })
  it("says so when there are no agents, with an action", () => {
    const h = haListHtml(hubAgentRows([], [], NOW, DAY, title, ltPlain, liveWorkCount([])), "", false, ltEsc, ltAge)
    expect(h).toContain("No agents yet.")
    expect(h).toContain('href="#page=agents"')
  })
  // #2270: the chat only streams runs started from it, so a working row opens its run.
  it("opens a working agent's live run; other rows and a gone run open the chat", () => {
    const seen: string[] = []
    const runHref = (r: { id: string; taskId: string; nodeUrl: string }) => {
      seen.push(r.id)
      return r.taskId === "t1" ? "#page=task&task=t1&agent=" + r.id + "&node=" + encodeURIComponent(r.nodeUrl) : ""
    }
    const h = haListHtml(m, "", false, ltEsc, ltAge, { runHref })
    expect(h).toContain('href="#page=task&amp;task=t1&amp;agent=coder&amp;node=http%3A%2F%2Fmac" data-ha-run')
    expect(h).toContain('href="#page=chat&amp;agent=main"')
    expect(h).toContain('href="#page=chat&amp;agent=pm&amp;ask=card%3A1"')
    expect([...new Set(seen)].sort()).toEqual(["coder", "main"])
  })
  it("draws no sliding stripe and no ping under a working row (#2270)", () => {
    const h = haListHtml(m, "", false, ltEsc, ltAge)
    expect(h).not.toContain("ha__bar")
    expect(HUB_NAV_CSS).not.toContain("ha-ping")
    expect(HUB_NAV_CSS).not.toContain("ha-shine")
  })
})

describe("the icon rail and the machines that do not answer (orca-design C26, C15)", () => {
  const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain, liveWorkCount(nodes))
  it("lists every agent as its face with its state icon, in the list's order, with a tooltip", () => {
    const h = haRailHtml(m, "coder", ltEsc, { ic })
    expect((h.match(/class="ha__ri /g) || []).length).toBe(m.rows.length)
    expect(h.indexOf('data-key="r:pm"')).toBeLessThan(h.indexOf('data-key="r:coder"'))
    expect(h).toContain('class="ha__ri is-working is-cur" data-key="r:coder"')
    expect(h).toContain('aria-label="coder, Working" data-tip="coder · Working: Restyle the phone app" data-tip-side="right"')
    expect(h).toContain('<span class="ha__si is-working ha__fsi" aria-hidden="true">')
    expect(h).toContain('<hr class="ha__rsep" data-key="rs:working">')
  })
  it("says once which machines do not answer, with where to look", () => {
    expect(haDownHtml(undefined, ltEsc)).toBe("")
    expect(haDownHtml(["Mac mini"], ltEsc, ic)).toContain("Mac mini is not answering, so its agents are not listed.")
    expect(haDownHtml(["a", "b", "c"], ltEsc)).toContain("a, b and c are not answering, so their agents are not listed.")
    expect(haDownHtml(["<x>"], ltEsc)).toContain("&lt;x&gt;")
    expect(haDownHtml(["a"], ltEsc)).toContain('href="#page=running"')
  })
  it("draws the rail at 641-1180 px, the Sheet at 640 px and below, and no bottom bar", () => {
    expect(HUB_NAV_CSS).toContain(".ax-wall.is-rail:not(.is-sheet) #hub-rail { display: flex;")
    expect(HUB_NAV_CSS).toMatch(/@media \(max-width: 640px\) \{\n  \.ax-wall:not\(\.is-sheet\) \.ax-wall__nav \{ display: none; \}/)
    expect(HUB_NAV_CSS).toContain("animation: hub-sheet-in 300ms")
    expect(HUB_NAV_CSS).toMatch(/prefers-reduced-motion: reduce\) \{ \.ax-wall\.is-sheet \.ax-wall__nav \{ animation: none; \} \}/)
    const page = renderWallPage({ owner: true })
    expect(page).toContain('id="wall-menu-btn" data-sheet-open aria-label="Open the menu"')
    expect(page).toContain('class="hub-scrim" data-sheet-close')
    expect(page).toContain('data-sheet-close aria-label="Close the menu"')
    expect(page).toContain('<div class="ha__rail" id="hub-rail" role="group" aria-label="Agents"></div>')
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
  it("opens Needs you on first load (the approved mock), keeps the count in the header and the reader's fold", () => {
    const h = haListHtml(mm, "", {}, ltEsc, ltAge)
    expect(h).toContain('<details class="ha__fold" data-key="g:needs" data-ha-open="needs" open><summary class="ha__h"><span class="ha__ht">Needs you</span><span class="ha__hn" data-n="2">2</span></summary>')
    expect(haListHtml(mm, "", { needs: false }, ltEsc, ltAge)).toContain('data-ha-open="needs"><summary')
  })
  it("shows 3 working agents, then Show all (N), and all of them once opened", () => {
    const h = haListHtml(mm, "", {}, ltEsc, ltAge)
    expect(rowsOf(h).filter((id) => id.startsWith("a"))).toEqual(["a1", "a2", "a3"])
    expect(h).toContain('<span class="ha__ht">Working</span><span class="ha__hn" data-n="5">5</span>')
    expect(h).toContain('data-ha-more="working" aria-expanded="false">Show all (5)</button>')
    const all = haListHtml(mm, "", { working: true }, ltEsc, ltAge)
    expect(rowsOf(all).filter((id) => id.startsWith("a"))).toEqual(["a1", "a2", "a3", "a4", "a5"])
    expect(all).toContain('aria-expanded="true">Show fewer</button>')
  })
  it("has no Show all at 3 rows or fewer", () => {
    expect(haListHtml(m3(), "", {}, ltEsc, ltAge)).not.toContain("data-ha-more")
  })
  // #2352 (orca-design C22): every group folds with its count; Needs you is capped too.
  it("folds every group: Working open, Done today folded, both kept", () => {
    const h = haListHtml(mm, "", {}, ltEsc, ltAge)
    expect(h).toContain('<details class="ha__fold" data-key="g:working" data-ha-open="work" open><summary class="ha__h">')
    expect(haListHtml(mm, "", { work: false }, ltEsc, ltAge)).toContain('data-ha-open="work"><summary')
    const m = hubAgentRows(nodes, needs, NOW, DAY, title, ltPlain, liveWorkCount(nodes))
    expect(haListHtml(m, "", {}, ltEsc, ltAge)).toContain('<details class="ha__fold" data-key="g:done" data-ha-open="done"><summary class="ha__h"><span class="ha__ht">Done today</span><span class="ha__hn" data-n="1">1</span>')
    expect(haListHtml(m, "", { done: true }, ltEsc, ltAge)).toContain('data-ha-open="done" open>')
  })
  it("shows the top 5 under Needs you, then Show all (N) (#2101 R3)", () => {
    const ids = ["n1", "n2", "n3", "n4", "n5", "n6", "n7"]
    const seven: LtNode[] = [{ name: "Mac", url: "http://mac", reachable: true, agents: ids.map((id) => ({ id, name: id })) }]
    const q: HaNeed[] = ids.map((id, i) => ({ key: "k" + id, title: "Ok?", agent: id, at: NOW - i * 1000 }))
    const m7 = hubAgentRows(seven, q, NOW, DAY, title, ltPlain, liveWorkCount(seven))
    const h = haListHtml(m7, "", { needs: true }, ltEsc, ltAge)
    expect(rowsOf(h)).toHaveLength(5)
    expect(h).toContain('data-ha-more="needs" aria-expanded="false">Show all (7)</button>')
    expect(rowsOf(haListHtml(m7, "", { needs: true, needsAll: true }, ltEsc, ltAge))).toHaveLength(7)
    // Five or fewer: no Show all.
    const m5 = hubAgentRows(seven, q.slice(0, 5), NOW, DAY, title, ltPlain, liveWorkCount(seven))
    expect(haListHtml(m5, "", { needs: true }, ltEsc, ltAge)).not.toContain('data-ha-more="needs"')
  })
  it("still takes the old idleOpen boolean", () => {
    expect(haListHtml(mm, "", true, ltEsc, ltAge)).toContain('data-ha-open="needs" open')
    expect(haListHtml(mm, "", false, ltEsc, ltAge)).toContain('data-ha-open="needs" open')
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
  it("face letters: the first letter of the first two words", () => {
    expect(haFace("secretary")).toBe("S")
    expect(haFace("")).toBe("?")
    expect(haFace("é-agent")).toBe("ÉA")
    expect(haFace("Dev Session")).toBe("DS")
    expect(haFace("graph-agent")).toBe("GA")
  })
  it("gives each page its own lucide icon, and each agent its state icon and a platform shortcut", () => {
    const pages = [{ key: "cost", label: "Cost", href: "#status=open&view=cost", icon: HUB_PAGE_ICON.cost }]
    const html = haSwitchHtml(haSwitchHits(m.rows, [], "", pages), 0, ltEsc, undefined, { ic, mod: "Alt+" })
    expect(html).toContain('<span class="hk__ico" aria-hidden="true"><svg class="lucide lucide-circle-dollar-sign"')
    expect(html).not.toContain("↗")
    expect(html).toContain('<kbd class="hk__kbd">Alt+1</kbd>')
    expect(html).toContain("lucide-circle-alert")
    expect(html).not.toContain("ha__node")
    for (const n of Object.values(HUB_PAGE_ICON)) expect(HUB_NAV_ICON_NAMES).toContain(n)
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
    for (const gone of ['data-nav="wall"', 'data-nav="cost"', 'data-nav="org"', "ax-wall__newpost", "New post", "ax-wall__navfoot"]) {
      expect(shown.replace(/<a class="ax-wall__item ax-wall__shortcut[^>]*>/g, "")).not.toContain(gone)
    }
    expect(nav).toMatch(/<div class="ax-wall__pagelinks" id="wall-pagelinks" hidden>/)
    // No filter chips, no machine tag, no bottom bar or More sheet (the approved mock).
    expect(page).not.toContain("data-ha-filter")
    expect(page).not.toContain('id="wall-more"')
    expect(page).not.toContain("ax-wall__shortcut")
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
    expect(HUB_NAV_CSS).toContain(".ax-wall__nav > .ha { flex: 1 0 auto; }")
    // The search keeps its height when the menu overflows (the phone Sheet too).
    expect(HUB_NAV_CSS).toContain(".ax-wall__nav > .ha__k, .ax-wall__nav > .ha__lbl { flex: none; }")
    expect(HUB_NAV_CSS).not.toMatch(/\.ax-wall__nav > \.ha \{[^}]*overflow-y/)
    expect(block).toMatch(/\.ax-wall__nav > \.ha__k \{ position: sticky;/)
    // Settings is pinned at the bottom.
    expect(HUB_NAV_CSS).toMatch(/\.hf--set \{[^}]*position: sticky; bottom: -12px;/)
  })
  it("mounts the ⌘K dialog on <body>, above every page, not in the sticky side menu (#2353)", () => {
    const nav = page.slice(page.indexOf('class="ax-wall__nav"'), page.indexOf("</nav>"))
    expect(nav).toContain('aria-controls="hub-k-dlg"')
    expect(nav).not.toContain('id="hub-k-dlg"')
    expect(page.match(/id="hub-k-dlg"/g)).toHaveLength(1)
    // After the whole .ax-wall wrapper and the status bar: a direct child of <body>.
    const tail = page.slice(page.indexOf('id="wall-wf-dialog"'), page.indexOf("</body>"))
    expect(tail).toMatch(/^id="wall-wf-dialog" hidden><\/div>\n<\/div>\n[^]*<div class="hk" id="hub-k-dlg"/)
    // Above the floating assistant (assistant.ts, z-index up to 62).
    const z = Number(/\.hk \{[^}]*z-index: (\d+)/.exec(HUB_NAV_CSS)?.[1])
    expect(z).toBeGreaterThan(62)
  })
  it("keeps the closed ⌘K dialog out of sight and out of the way of clicks (#2353)", () => {
    expect(page).toMatch(/<div class="hk" id="hub-k-dlg"[^>]* hidden>/)
    expect(HUB_NAV_CSS).toMatch(/\.hk\[hidden\] \{ display: none; \}/)
  })
  it("ends with Waiting on you (the Desk, #2226), Jobs, Workflows, Mobile app and Settings", () => {
    const foot = page.slice(page.indexOf('id="hub-foot"'), page.indexOf('id="wall-pagelinks"'))
    for (const w of ['data-nav="needs" href="#status=open&amp;view=decide"', ">Waiting on you<", ">Jobs<", ">Workflows<", 'href="#page=mobile"', 'data-nav="settings"']) expect(foot).toContain(w)
    const guest = renderWallPage()
    expect(guest.slice(guest.indexOf('id="hub-foot"'), guest.indexOf('id="wall-pagelinks"'))).not.toContain('data-nav="settings"')
    // The phone has no status bar, so Light / dark sits at the foot of the Sheet there.
    expect(foot).toContain('class="hf__item hf__theme" data-wall-theme>')
    expect(HUB_NAV_CSS).toContain(".hf__item.hf__theme { display: none; }")
    expect(HUB_NAV_CSS).toContain("  .hf__item.hf__theme { display: flex; }")
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
    const code = injectFns({ haFace: ha.haFace, hubAgentRows: ha.hubAgentRows, haChatHref: ha.haChatHref, haStateIcon: ha.haStateIcon, haStateWord: ha.haStateWord, haRowHref: ha.haRowHref, haGroups: ha.haGroups, haListHtml: ha.haListHtml, haRailHtml: ha.haRailHtml, haDownHtml: ha.haDownHtml, haRowHtml: ha.haRowHtml, haFold: ha.haFold, haSwitchHits: ha.haSwitchHits, haSwitchHtml: ha.haSwitchHtml, haChannelLabel: ha.haChannelLabel, haRunAt: ha.haRunAt, haRunStart: ha.haRunStart, haRunsHtml: ha.haRunsHtml, haRunsToday: ha.haRunsToday })
    const fn = new Function("ltTitle", "ltPlain", "ltEsc", "ltAge", "liveWorkCount", "nodes", "needs", "NOW", "DAY", code + "; return haListHtml(hubAgentRows(nodes, needs, NOW, DAY, function (t) { return ltTitle(t, null) }, ltPlain, liveWorkCount(nodes)), '', false, ltEsc, ltAge)")
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
    const h = haListHtml(m, "", false, ltEsc, ltAge, { runHref })
    expect(h).toContain('href="#page=task&amp;task=call&amp;agent=devops" data-ha-run')
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
