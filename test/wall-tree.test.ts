import { describe, expect, it } from "vitest"
import * as tree from "../src/daemon/ui/pages/wall-tree"
import { injectFns } from "../src/daemon/ui/inject"
import { liveTreeHtml, liveTreeModel, ltAge, ltIssueRef, ltModel, ltProvider, ltRequestId, ltTitle, type LtNode, type LtPost } from "../src/daemon/ui/pages/wall-tree"
import { renderWallPage } from "../src/daemon/ui/pages/wall"

// #2101 PR 1c: the Hub's left column opens with a live tree of the fleet:
// machine (count) → project → work item → agent row, with a spinner while
// an agent works and a green dot once it is done. A silent machine says
// "not checked" (C3 of the v4 review), never "nothing running".

const NOW = Date.parse("2026-11-23T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
/** The tree keys a machine by its URL (stable while its id comes in). */
const MAC = "http://127.0.0.1:18800"

const POSTS: LtPost[] = [
  { id: "req-A", headline: "Live sidebar for the Hub", project: "agentx", home: "https://github.com/anis-marrouchi/agentx/issues/2101", owner: "dev-session" },
  { id: "req-B", headline: "Weekly short", project: null, repo: null, owner: "agentx-channel", group: { channel: "app", chatId: "app:x1" } },
]

const NODES: LtNode[] = [
  { id: "mac", name: "MacBook-Local", url: "http://127.0.0.1:18800", reachable: true, agents: [
    { id: "dev-session", name: "Dev Session", model: "claude-opus-5-5", color: "#3366ff", runningTasks: [
      { id: "t1", channel: "requests", chatId: "req-A", sender: "operator", startedAt: ago(90_000), messagePreview: "[agentx:plan-step id=req-A step=1]\nYou own step 1" },
    ] },
    { id: "pm-agent", name: "Hakim", model: "claude-opus-5-5", runningTasks: [
      { id: "t2", channel: "a2a", chatId: "a2a:coo:pm-agent:dlg-1", sender: "agent:coo-agent", startedAt: ago(20_000), messagePreview: "[Job state] Before you end this run, state the job's state" },
      { id: "t3", channel: "a2a", chatId: "a2a:x:pm-agent:dlg-2", sender: "agent:x", startedAt: ago(5 * 60_000), messagePreview: "[agentx:request-reopened id=req-A] You closed it as done" },
    ] },
    { id: "agentx-channel", name: "AgentX Channel", model: "gpt-6-astra", runningTasks: [
      { id: "t4", channel: "app", chatId: "app:x1", startedAt: ago(3 * 3_600_000), lastActivity: ago(10_000), messagePreview: "make the short" },
    ] },
    { id: "nadia", name: "Nadia", model: "claude-sonnet-4-6", lastActive: ago(12 * 60_000), lastSummary: { text: "Posted the Counting video.\nMore lines", at: ago(12 * 60_000), ok: true }, runningTasks: [] },
    { id: "old", name: "Old", lastActive: ago(5 * 3_600_000), runningTasks: [] },
  ] },
  { id: "clawd", name: "Clawd Server", url: "http://clawd", reachable: false, error: "unreachable", agents: [] },
  { id: "slow", name: "Slow Box", url: "http://slow", reachable: false, checking: true, error: "timed out", agents: [] },
]

describe("live tree helpers", () => {
  it("says ages short", () => {
    expect(ltAge(5_000)).toBe("now")
    expect(ltAge(4 * 60_000)).toBe("4m")
    expect(ltAge(3 * 3_600_000)).toBe("3h")
    expect(ltAge(2 * 86_400_000)).toBe("2d")
  })
  it("shortens Claude model names and keeps others", () => {
    expect(ltModel("claude-opus-5-5")).toBe("opus-5.5")
    expect(ltModel("claude-sonnet-4-6")).toBe("sonnet-4.6")
    expect(ltModel("gpt-6-astra")).toBe("gpt-6-astra")
    expect(ltProvider("claude-opus-5-5")).toBe("anthropic")
    expect(ltProvider("gpt-6-astra")).toBe("openai")
    expect(ltProvider("gemini-3-pro")).toBe("google")
    expect(ltProvider("")).toBe("other")
  })
  it("finds the request a run works for", () => {
    expect(ltRequestId({ id: "x", channel: "requests", chatId: "req-Z" })).toBe("req-Z")
    expect(ltRequestId({ id: "x", channel: "a2a", messagePreview: "[agentx:plan-step id=prm-abc-12 step=2]" })).toBe("prm-abc-12")
    expect(ltRequestId({ id: "x", channel: "a2a", messagePreview: "no marker" })).toBe("")
  })
  it("finds an issue ref", () => {
    expect(ltIssueRef("check (noqta/noqta#803, SOP-50)")).toBe("noqta/noqta#803")
    expect(ltIssueRef("Open the PR for agentx#2081")).toBe("agentx#2081")
    expect(ltIssueRef("nothing here")).toBe("")
    expect(ltIssueRef("https://github.com/anis-marrouchi/agentx/pull/2111")).toBe("anis-marrouchi/agentx#2111")
    expect(ltIssueRef("https://gitlab.noqta.tn/noqta/cx/-/merge_requests/58")).toBe("noqta/cx!58")
  })
  it("titles a run without the daemon's markers", () => {
    expect(ltTitle({ id: "x", messagePreview: "[Job state] Before you end", sender: "agent:pm-agent" }, null)).toBe("Job for pm-agent")
    expect(ltTitle({ id: "x", messagePreview: "[agentx:plan-step id=r step=1]\nYou own step 1 of 2 in the plan for the owner's request r: \"Open PR 1c live sidebar" }, null)).toBe("Open PR 1c live sidebar")
    expect(ltTitle({ id: "x", messagePreview: "[channel-daily] Morning channel check" }, null)).toBe("Morning channel check")
    expect(ltTitle({ id: "x", channel: "cron", chatId: "cron:ds-2101-pr1c-check-1123", messagePreview: "[Job state] Before you end", sender: "agent" }, null)).toBe("ds-2101-pr1c-check-1123")
    expect(ltTitle({ id: "x", channel: "cron", chatId: "", messagePreview: "[Job state] Before you end", sender: "agent" }, null)).toBe("A job check")
    expect(ltTitle({ id: "x", messagePreview: "ignored" }, { id: "p", headline: "From the post\nsecond line" })).toBe("From the post")
  })
})

describe("liveTreeModel", () => {
  const tree = liveTreeModel(NODES, POSTS, NOW)
  const mac = tree[0]

  it("counts the runs per machine", () => {
    expect(mac.state).toBe("up")
    // Three agents at work, pm-agent with two runs: the badge counts agents, as Working does (#2260).
    expect(mac.working).toBe(3)
    expect(mac.runs).toBe(4)
  })
  it("groups runs by project and work item, from the posts", () => {
    const agentx = mac.projects.find((p) => p.label === "agentx")!
    expect(agentx.items).toHaveLength(1)
    const item = agentx.items[0]
    expect(item.label).toBe("anis-marrouchi/agentx#2101")
    // Both the plan step and the reopened-request run land on req-A's item.
    expect(item.rows.map((r) => r.agentId).sort()).toEqual(["dev-session", "pm-agent"])
    expect(item.rows.find((r) => r.agentId === "dev-session")!.title).toBe("Live sidebar for the Hub")
  })
  it("puts runs with no project last, under their channel", () => {
    expect(mac.projects[mac.projects.length - 1].label).toBe("No project")
    const none = mac.projects[mac.projects.length - 1]
    expect(none.items.map((i) => i.label)).toContain("Agent to agent")
    // The app chat matches its post by chat and takes its title.
    const app = none.items.find((i) => i.key === "post:req-B")!
    expect(app.rows[0].title).toBe("Weekly short")
    expect(app.rows[0].model).toBe("gpt-6-astra")
    expect(app.rows[0].ageMs).toBe(10_000) // last activity, not the start
  })
  it("lists agents done in the last hour with a green dot, not older ones", () => {
    expect(mac.done.map((r) => r.agentId)).toEqual(["nadia"])
    expect(mac.done[0].state).toBe("done")
    expect(mac.done[0].title).toBe("Posted the Counting video.")
    // The older one is not gone: it is idle.
    expect(mac.idle.map((r) => r.agentId)).toEqual(["old"])
  })
  it("marks a silent machine not checked and a slow one checking (C3)", () => {
    expect(tree[1].state).toBe("silent")
    expect(tree[1].working).toBe(0)
    expect(tree[2].state).toBe("checking")
  })
})

describe("liveTreeHtml", () => {
  const tree = liveTreeModel(NODES, POSTS, NOW)
  const html = liveTreeHtml(tree, (r) => (r.task ? "#page=task&task=" + r.task.id : "#page=activity&a-agent=" + r.agentId), { ["d:" + MAC]: true })

  it("draws a spinner per working row and a green dot per done or idle row", () => {
    expect(html.match(/class="lt__spin"/g)).toHaveLength(4)
    expect(html.match(/class="lt__dot"/g)).toHaveLength(2)
    expect(html).toContain('aria-label="done"')
    expect(html).toContain('aria-label="idle"')
  })
  it("shows the count badge, the model and the age", () => {
    expect(html).toContain('<span class="lt__badge is-live" title="3 agents working now, 4 runs">3</span>')
    expect(html).toContain("opus-5.5 · <time>1m</time>")
    expect(html).toContain('href="#page=task&amp;task=t1"')
  })
  it("says not checked for the silent machine, never nothing running", () => {
    const clawd = html.slice(html.indexOf("Clawd Server"), html.indexOf("Slow Box"))
    expect(clawd).toContain("not checked")
    expect(clawd).not.toContain("Nothing running")
  })
  it("starts done lists folded so working rows on every machine show, and keeps the reader's choice", () => {
    const fresh = liveTreeHtml(tree, () => "#x", {})
    expect(fresh).toContain(`data-lt-key="d:${MAC}">`)
    expect(liveTreeHtml(tree, () => "#x", { ["d:" + MAC]: false })).toContain(`data-lt-key="d:${MAC}" open>`)
  })
  it("keeps a folded group folded", () => {
    expect(html).toContain(`data-lt-key="d:${MAC}">`)
    expect(html).toContain(`data-lt-key="m:${MAC}" open>`)
  })
  it("escapes fleet text", () => {
    const bad = liveTreeHtml(liveTreeModel([{ name: "<b>x</b>", reachable: true, agents: [{ id: "a", name: "<img>", runningTasks: [{ id: "t", messagePreview: "<script>alert(1)</script>" }] }] }], [], NOW), () => "", {})
    expect(bad).not.toContain("<script>")
    expect(bad).not.toContain("<img>")
    expect(bad).toContain("&lt;b&gt;x&lt;/b&gt;")
  })
})

describe("the Hub page", () => {
  it("opens its nav with the agent list, not the tree, before the pages (#2101 R26)", () => {
    const page = renderWallPage()
    const agents = page.indexOf('id="hub-agents"'), first = page.indexOf('data-nav="wall"')
    expect(page).not.toContain('id="wall-tree"')
    expect(agents).toBeGreaterThan(0)
    expect(agents).toBeLessThan(first)
    expect(page).toContain("@keyframes lt-spin")
    expect(page).toContain("prefers-reduced-motion")
  })
})

describe("done rows", () => {
  it("skips summaries that are data and caps the list at 6 with a more link", () => {
    const agents = Array.from({ length: 8 }, (_, i) => ({ id: "a" + i, name: "A" + i, lastActive: ago((i + 1) * 60_000), lastSummary: { text: i === 0 ? "<json>[1]" : "Did " + i, at: "", ok: true }, runningTasks: [] }))
    const m = liveTreeModel([{ id: "n", name: "N", reachable: true, agents }], [], NOW)
    expect(m[0].done[0].title).toBe("Finished a run")
    const html = liveTreeHtml(m, () => "#a", {})
    expect(html.match(/class="lt__dot"/g)).toHaveLength(6)
    expect(html).toContain("+2 more</a>")
  })
})

describe("idle rows (Hakim post-merge review of #2138)", () => {
  // Anis's scope: "a green dot when it is done or idle ... the whole fleet
  // can be seen without opening a chat". Every agent of a machine that
  // answers gets a row; the idle ones fold under "N idle".
  const idleNode: LtNode = { id: "box", name: "Box", url: "http://box", reachable: true, agents: [
    { id: "w", name: "Worker", model: "claude-opus-5-5", runningTasks: [{ id: "tw", channel: "a2a", startedAt: ago(30_000), messagePreview: "busy" }] },
    { id: "d", name: "Doner", lastActive: ago(5 * 60_000), lastSummary: { text: "Shipped it", at: "", ok: true }, runningTasks: [] },
    { id: "i1", name: "Zed", lastActive: ago(2 * 86_400_000), runningTasks: [] },
    { id: "i2", name: "Amy", runningTasks: [] },
    { id: "i3", name: "Bob", model: "gpt-6-astra", lastActive: ago(3 * 3_600_000) },
  ] }

  it("lists every agent that is neither working nor done as idle, newest move first", () => {
    const [m] = liveTreeModel([idleNode], [], NOW)
    expect(m.idle.map((r) => r.agentId)).toEqual(["i3", "i1", "i2"])
    expect(m.idle.every((r) => r.state === "idle" && r.task === null)).toBe(true)
    expect(m.idle[2].ageMs).toBe(-1)
    // Every agent of the machine has exactly one row.
    const all = [...m.projects.flatMap((p) => p.items.flatMap((i) => i.rows)), ...m.done, ...m.idle].map((r) => r.agentId).sort()
    expect(all).toEqual(["d", "i1", "i2", "i3", "w"])
  })

  it("folds idle rows under N idle by default, after working and done, and keeps the reader's choice", () => {
    const [m] = liveTreeModel([idleNode], [], NOW)
    const html = liveTreeHtml([m], (r) => "#page=activity&a-agent=" + r.agentId, {})
    expect(html).toContain('data-lt-key="i:http://box"><summary><span class="lt__proj">3 idle</span>')
    expect(html.match(/aria-label="idle"/g)).toHaveLength(3)
    const working = html.indexOf('aria-label="working"'), done = html.indexOf('aria-label="done"'), idle = html.indexOf('aria-label="idle"')
    expect(working).toBeGreaterThan(0)
    expect(done).toBeGreaterThan(working)
    expect(idle).toBeGreaterThan(done)
    expect(html).toContain('href="#page=activity&amp;a-agent=i2"')
    // An agent that never moved shows no age.
    expect(html).toContain('title="Amy, idle"')
    expect(html.split('title="Amy, idle"')[1].split("</a>")[0]).not.toContain("<time>")
    expect(liveTreeHtml([m], () => "#x", { "i:http://box": false })).toContain('data-lt-key="i:http://box" open>')
  })

  it("shows a quiet machine's agents instead of only Nothing running", () => {
    const quiet = liveTreeModel([{ id: "q", name: "Quiet", url: "http://q", reachable: true, agents: [
      { id: "a", name: "A", runningTasks: [] }, { id: "b", name: "B", lastActive: ago(9 * 3_600_000), runningTasks: [] },
    ] }], [], NOW)
    const html = liveTreeHtml(quiet, () => "#x", {})
    expect(html).toContain("Nothing running.")
    expect(html).toContain('<span class="lt__proj">2 idle</span>')
    expect(html.match(/class="lt__dot"/g)).toHaveLength(2)
    expect(liveTreeHtml(liveTreeModel([{ name: "Empty", url: "http://e", reachable: true, agents: [] }], [], NOW), () => "#x", {})).toContain("No agents.")
  })

  it("keeps a machine's fold key when its id comes in after the URL", () => {
    const asking = liveTreeModel([{ id: "http://box", name: "http://box", url: "http://box", reachable: false, checking: true, agents: [] }], [], NOW)
    const answered = liveTreeModel([idleNode], [], NOW)
    expect(asking[0].key).toBe(answered[0].key)
    expect(liveTreeHtml(answered, () => "#x", { "m:http://box": true })).toContain('data-lt-key="m:http://box">')
  })
})

describe("a machine still being asked keeps its rows (#2292)", () => {
  const since = ago(9_000)
  const slow: LtNode = {
    id: "mac", name: "MacBook-Local", url: "http://mac", reachable: true, checking: true, staleSince: since, error: "timed out",
    agents: [
      { id: "coder", name: "Coder", model: "claude-opus-5-5", runningTasks: [{ id: "tk1", channel: "a2a", chatId: "c1", startedAt: ago(60_000), lastActivity: ago(30_000), message: "Fix it" } as never] },
      { id: "nadia", name: "Nadia", lastActive: ago(600_000) },
      { id: "both", name: "Both", lastActive: ago(9_000_000) },
    ],
  }
  const up: LtNode = { id: "clawd", name: "Clawd", url: "http://clawd", reachable: true, agents: [{ id: "both", name: "Both", runningTasks: [{ id: "tk2", startedAt: ago(1000) } as never] }] }
  const silent: LtNode = { id: "gone", name: "Gone Box", url: "http://gone", reachable: false, error: "timed out", agents: [] }
  const model = liveTreeModel([up, slow, silent], [], NOW)
  const html = liveTreeHtml(model, () => "#x", {})
  const macHtml = html.slice(html.indexOf("MacBook-Local"), html.indexOf("Gone Box"))

  it("draws a checking machine's last good rows, with its number and an as-of time (#2101-state)", () => {
    expect(model[1].state).toBe("checking")
    expect(model[1].asOf).toBe(since)
    expect(macHtml).not.toContain("checking…")
    expect(macHtml).toContain('title="1 agent working now">1</span>')
    expect(macHtml).toContain("as of " + since.slice(11, 16) + "Z")
    expect(macHtml).toContain('aria-label="working"')
    expect(macHtml).toContain('title="Coder, working: ')
    expect(macHtml).toContain('aria-label="done"')
    expect(macHtml).not.toContain("Slow to answer")
  })
  it("shows an agent an up machine lists on that machine only", () => {
    expect(model[1].idle.map((r) => r.agentId)).not.toContain("both")
    expect(html.match(/title="Both, /g)).toHaveLength(1)
  })
  it("shows no rows for a silent machine, or a checking one with no good data", () => {
    const gone = html.slice(html.indexOf("Gone Box"))
    expect(gone).toContain("not checked")
    expect(gone).not.toContain("lt__row")
    const empty = liveTreeHtml(liveTreeModel([{ id: "http://e", name: "E", url: "http://e", reachable: false, checking: true, agents: [] }], [], NOW), () => "#x", {})
    expect(empty).toContain("Slow to answer; asking again.")
    expect(empty).not.toContain("as of")
  })
  it("counts a checking machine's last good runs too, so Working does not flicker (#2260, #2101-state)", () => {
    const work = tree.liveWorkCount([up, slow, silent])
    expect(work.agents).toBe(2) // Both on Clawd, Coder on the slow Mac
    expect(work.byNode["http://mac"]).toEqual({ agents: 1, runs: 1 })
    expect(model[0].working).toBe(1)
    expect(model[1].working).toBe(1)
  })
})

describe("shipped to the browser", () => {
  it("runs from its own source alone, with no import left in it (injectFns)", () => {
    const fns = Object.fromEntries(Object.entries(tree).filter(([, v]) => typeof v === "function")) as Record<string, Function>
    const run = new Function("nodes", "posts", "now", injectFns(fns) + "return liveTreeHtml(liveTreeModel(nodes, posts, now), function () { return '#x' }, {});")
    const html = run(NODES, POSTS, NOW) as string
    expect(html.match(/class="lt__spin"/g)).toHaveLength(4)
    expect(html).toContain("not checked")
  })
})
