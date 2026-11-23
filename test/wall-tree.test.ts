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
    expect(ltTitle({ id: "x", messagePreview: "ignored" }, { id: "p", headline: "From the post\nsecond line" })).toBe("From the post")
  })
})

describe("liveTreeModel", () => {
  const tree = liveTreeModel(NODES, POSTS, NOW)
  const mac = tree[0]

  it("counts the runs per machine", () => {
    expect(mac.state).toBe("up")
    expect(mac.working).toBe(4)
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
  })
  it("marks a silent machine not checked and a slow one checking (C3)", () => {
    expect(tree[1].state).toBe("silent")
    expect(tree[1].working).toBe(0)
    expect(tree[2].state).toBe("checking")
  })
})

describe("liveTreeHtml", () => {
  const tree = liveTreeModel(NODES, POSTS, NOW)
  const html = liveTreeHtml(tree, (r) => (r.task ? "#page=task&task=" + r.task.id : "#page=activity&a-agent=" + r.agentId), { "d:mac": true })

  it("draws a spinner per working row and a green dot per done row", () => {
    expect(html.match(/class="lt__spin"/g)).toHaveLength(4)
    expect(html.match(/class="lt__dot"/g)).toHaveLength(1)
  })
  it("shows the count badge, the model and the age", () => {
    expect(html).toContain('<span class="lt__badge is-live" title="4 working now">4</span>')
    expect(html).toContain("opus-5.5 · <time>1m</time>")
    expect(html).toContain('href="#page=task&amp;task=t1"')
  })
  it("says not checked for the silent machine, never nothing running", () => {
    const clawd = html.slice(html.indexOf("Clawd Server"), html.indexOf("Slow Box"))
    expect(clawd).toContain("not checked")
    expect(clawd).not.toContain("Nothing running")
  })
  it("keeps a folded group folded", () => {
    expect(html).toMatch(/data-lt-key="d:mac">/)
    expect(html).toMatch(/data-lt-key="m:mac" open>/)
  })
  it("escapes fleet text", () => {
    const bad = liveTreeHtml(liveTreeModel([{ name: "<b>x</b>", reachable: true, agents: [{ id: "a", name: "<img>", runningTasks: [{ id: "t", messagePreview: "<script>alert(1)</script>" }] }] }], [], NOW), () => "", {})
    expect(bad).not.toContain("<script>")
    expect(bad).not.toContain("<img>")
    expect(bad).toContain("&lt;b&gt;x&lt;/b&gt;")
  })
})

describe("the Hub page", () => {
  it("opens its nav with the live tree, before the pages", () => {
    const page = renderWallPage()
    const tree = page.indexOf('id="wall-tree"'), first = page.indexOf('data-nav="wall"')
    expect(tree).toBeGreaterThan(0)
    expect(tree).toBeLessThan(first)
    expect(page).toContain("@keyframes lt-spin")
    expect(page).toContain("prefers-reduced-motion")
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
