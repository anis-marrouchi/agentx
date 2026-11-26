// Automations and Waiting on you in the React simple shell (#2226 S5): the
// rows read from the live snapshot and the owner's list, the panes drawn
// for sample data, empty, error and loading, an opened item, and the menu
// wiring (both items open in the shell's centre, not the old Hub).
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { resolveHubLayout } from "../src/hub/layout"
import { SHELL_MAIN } from "../src/hub/shell"
import { parseHash } from "../src/hub/router"
import { shellPane } from "../src/hub/tasks"
import {
  AUTOMATIONS_URL, SCHEDULES_PAGE, automationGroups, automationStatus, automationTotals, automationsPending, nodeState, runTone, runWord, shortUntil,
  type LiveReply,
} from "../src/hub/automations"
import {
  NEEDS_YOU_PAGE, WAITING_URL, waitingHref, waitingKind, waitingList, waitingSoon, waitingTaskId,
  type WaitingItem, type WaitingReply,
} from "../src/hub/waiting"
import { AutomationRow, AutomationsBody, RunStrip } from "../src/hub/pages/ShellAutomations"
import { WaitingBody, WaitingDetail, WaitingRows } from "../src/hub/pages/ShellWaiting"
import { SimpleShell, type SimpleShellProps } from "../src/hub/pages/ShellPage"
import { TooltipProvider } from "../src/hub/ui"
import { ICON_NAMES } from "../src/hub/ui/icons"

const now = Date.parse("2026-11-26T12:00:00Z")
const H = 3_600_000
const iso = (t: number) => new Date(t).toISOString()
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, el)))

const live: LiveReply = {
  nodes: [
    {
      name: "studio", reachable: true,
      crons: [
        { id: "nightly-build", enabled: true, schedule: "0 2 * * *", timezone: "Africa/Tunis", agent: "builder", nextRun: iso(now + 3 * H), consecutiveErrors: 0, value: { why: "Catch a broken main before morning", metric: "builds" }, home: "https://github.com/acme/app/issues/12" },
        { id: "inbox-sweep", enabled: true, schedule: "*/30 * * * *", agent: "support", nextRun: iso(now + 0.2 * H), consecutiveErrors: 2 },
        { id: "old-report", enabled: false, schedule: "0 9 * * 1", agent: "writer", consecutiveErrors: 0 },
      ],
      cronRuns: [
        { jobId: "inbox-sweep", startedAt: iso(now - 0.5 * H), status: "failed", errorSummary: "IMAP login refused\nmore" },
      ],
      routines: [
        { id: "cron:nightly-build", source: "cron", kind: "schedule", name: "nightly-build", trigger: { schedule: "0 2 * * *" }, agent: "builder", enabled: true, state: "enabled", nextRunAt: iso(now + 3 * H), lastRun: { at: iso(now - 10 * H), status: "success", summary: "Green" }, consecutiveFailures: 0, flags: [], recent: [{ at: iso(now - 10 * H), status: "success" }, { at: iso(now - 34 * H), status: "failed" }] },
        { id: "cron:old-report", source: "cron", kind: "schedule", name: "old-report", trigger: { schedule: "0 9 * * 1" }, agent: "writer", enabled: false, state: "disabled", nextRunAt: null, lastRun: null, consecutiveFailures: 0, flags: [{ reason: "disabled-long", detail: "off 20 days" }] },
        { id: "workflow:pr-review", source: "workflow", kind: "event", name: "Review each PR", trigger: { event: "on:pr.opened" }, agent: "reviewer", enabled: true, state: "active", nextRunAt: null, lastRun: { at: iso(now - 2 * H), status: "success" }, consecutiveFailures: 0, flags: [], recent: [{ at: iso(now - 2 * H), status: "success" }] },
      ],
    },
    { name: "laptop", reachable: false, error: "unreachable" },
  ],
}

describe("automations as data", () => {
  it("reads the old Schedules page's source", () => {
    expect(AUTOMATIONS_URL).toBe("/api/live?quick=1")
    expect(SCHEDULES_PAGE).toBe("#status=open&view=jobs")
  })
  it("one group per machine, jobs first then workflows", () => {
    const g = automationGroups(live)
    expect(g.map((x) => [x.node, x.state, x.rows.map((r) => r.id)])).toEqual([
      ["studio", "ok", ["cron:nightly-build", "cron:inbox-sweep", "cron:old-report", "workflow:pr-review"]],
      ["laptop", "down", []],
    ])
  })
  it("a job: its routine's last run and strip, its project and what it is for", () => {
    const a = automationGroups(live)[0].rows[0]
    expect(a.last).toEqual({ status: "success", at: now - 10 * H, summary: "Green" })
    expect(a.recent).toEqual(["failed", "success"]) // oldest first
    expect(a.project).toEqual({ label: "acme/app#12", href: "https://github.com/acme/app/issues/12" })
    expect(a.why).toBe("Catch a broken main before morning")
    expect(a.nextRunAt).toBe(now + 3 * H)
    expect(a.starts).toBe("schedule")
  })
  it("a job with no routine row: its last run from the run history", () => {
    const a = automationGroups(live)[0].rows[1]
    expect(a.last?.status).toBe("failed")
    expect(a.last?.summary).toContain("IMAP login refused")
    expect(automationStatus(a)).toEqual({ label: "Last run failed", tone: "err" })
  })
  it("an off job has no next run and says why it looks stale", () => {
    const a = automationGroups(live)[0].rows[2]
    expect(a.nextRunAt).toBeNull()
    expect(a.flags).toEqual(["off 20 days"])
    expect(automationStatus(a).label).toBe("Off")
  })
  it("a workflow an event starts", () => {
    const a = automationGroups(live)[0].rows[3]
    expect(a).toMatchObject({ source: "workflow", name: "Review each PR", starts: "event", when: "on:pr.opened", agent: "reviewer" })
    expect(automationStatus(a)).toEqual({ label: "On", tone: "ok" })
  })
  it("three failures in a row look stale even without a flag", () => {
    const g = automationGroups({ nodes: [{ name: "n", crons: [{ id: "x", enabled: true, schedule: "* * * * *", agent: "a", consecutiveErrors: 3 }] }] })
    expect(g[0].rows[0].flags).toEqual(["failed 3 times in a row"])
    expect(automationStatus(g[0].rows[0]).label).toBe("Looks stale")
  })
  it("totals, machine states, pending", () => {
    expect(automationTotals(automationGroups(live))).toEqual({ total: 4, on: 3, failed: 1, stale: 0 })
    expect(nodeState({ name: "a", checking: true })).toBe("checking")
    expect(nodeState({ name: "a", stale: true, reachable: false })).toBe("stale")
    expect(automationsPending({ nodes: [{ name: "a", checking: true }] })).toBe(true)
    expect(automationsPending(live)).toBe(false)
    expect(automationGroups(null)).toEqual([])
  })
  it("run words and tones as the old page says them", () => {
    expect(runWord("success")).toBe("Worked")
    expect(runWord("timeout")).toBe("Timed out")
    expect(runTone("missed")).toBe("err")
    expect(runTone("held")).toBe("idle")
    expect(shortUntil(now + 3 * H, now)).toBe("in 3h")
  })
})

describe("the Automations pane", () => {
  const groups = automationGroups(live)
  it("sample data: totals, each machine, a row per automation", () => {
    const out = html(createElement(AutomationsBody, { groups, now }))
    expect(out).toContain('data-automations="totals"')
    expect(out).toContain('data-node="studio"')
    expect(out).toContain('data-node="laptop"')
    for (const r of groups[0].rows) expect(out).toContain(`data-automation="${r.id}"`)
    expect(out).toContain("This machine does not answer")
    expect(out).toContain("in 3h")
    expect(out).toContain("on event")
    expect(out).toContain("IMAP login refused")
    expect(out).toMatch(/text-err-ink">IMAP login refused<\/span>/) // the row says the first line of a failure
    expect(out).toContain('href="#status=open&amp;view=jobs"')
  })
  it("read only: no button that changes a job", () => {
    const out = html(createElement(AutomationsBody, { groups, now }))
    expect(out).not.toMatch(/<button/)
  })
  it("a row folds open for its schedule, project and last run", () => {
    const out = html(createElement(AutomationRow, { a: groups[0].rows[0], now }))
    expect(out).toContain("<details")
    expect(out).toContain("0 2 * * *")
    expect(out).toContain("Africa/Tunis")
    expect(out).toContain('href="https://github.com/acme/app/issues/12"')
    expect(out).toContain('rel="noopener noreferrer"')
  })
  it("the strip: seven squares, blanks first", () => {
    const out = html(createElement(RunStrip, { recent: ["failed", "success"] }))
    expect(out.match(/rounded-\[2px\]/g)?.length).toBe(7)
    expect(out).toContain('aria-label="Last seven runs: failed, success"')
  })
  it("empty: says so, with a way to ask an agent", () => {
    const out = html(createElement(AutomationsBody, { groups: [{ node: "studio", state: "ok", rows: [] }] }))
    expect(out).toContain("Nothing runs on its own yet")
    expect(out).toContain('href="#page=home"')
  })
  it("error: the reason and Try again", () => {
    const out = html(createElement(AutomationsBody, { error: "HTTP 502" }))
    expect(out).toContain("Could not read the automations")
    expect(out).toContain('role="alert"')
    expect(out).toContain("Try again")
  })
  it("loading: placeholders, no list yet", () => {
    const out = html(createElement(AutomationsBody, {}))
    expect(out).toContain("animate-pulse")
    expect(out).not.toContain('data-automations="list"')
  })
})

const items: WaitingItem[] = [
  { key: "card:c2", kind: "card", title: "Merge the release PR?", ask: "PR #2330 is green. Merge it now?", agent: "builder", nodeName: "studio", yes: "It is merged and released.", no: "It stays open.", expires: iso(now + 5 * H), ifSilent: "kept open", askedAt: iso(now - 2 * H), recommend: "Yes" },
  { key: "request:q3", kind: "request", title: "Pick the plan for the docs move", need: "a plan to pick", said: "Move the docs to VitePress 2", agent: "writer", askedAt: iso(now - 26 * H) },
  { key: "schedule:weekly", kind: "schedule", title: "Start the weekly backup check", choices: ["Every Monday", "Every day"], askedAt: iso(now - 1 * H) },
]

describe("waiting on you as data", () => {
  it("reads the owner's one list from the approvals reply", () => {
    expect(WAITING_URL).toBe("/api/admin/approvals")
    const l = waitingList({ desk: { count: 3, later: 2, items, errors: ["Requests could not be read: x"] } })
    expect(l.items.map((i) => i.key)).toEqual(["request:q3", "card:c2", "schedule:weekly"]) // longest waiting first
    expect(l.later).toBe(2)
    expect(l.errors).toEqual(["Requests could not be read: x"])
  })
  it("no desk, or rows without a key: an empty list, no error", () => {
    expect(waitingList(null)).toEqual({ items: [], later: 0, errors: [] })
    expect(waitingList({ desk: { items: [{ key: "", kind: "card", title: "x" }] } } as WaitingReply).items).toEqual([])
  })
  it("kinds in words, links, a request's task, soon", () => {
    expect(waitingKind("card")).toBe("Decision")
    expect(waitingKind("ci")).toBe("CI")
    expect(waitingKind("other")).toBe("Other")
    expect(waitingHref("card:c2")).toBe("#page=home&pane=waiting&open=card%3Ac2")
    expect(waitingTaskId(items[1])).toBe("q3")
    expect(waitingTaskId(items[0])).toBeNull()
    expect(waitingSoon(items[0], now)).toBe(true)
    expect(waitingSoon(items[1], now)).toBe(false)
  })
  it("an item opened from the hash", () => {
    expect(shellPane(parseHash(waitingHref("card:c2")))).toEqual({ pane: "waiting", open: "card:c2", project: null })
    expect(shellPane(parseHash("#page=home&pane=automations"))).toEqual({ pane: "automations", open: null, project: null })
    expect(shellPane(parseHash("#page=home&pane=nope"))).toEqual({ pane: "chat", open: null, project: null })
  })
})

describe("the Waiting on you pane", () => {
  it("sample data: a row per item that opens it in the shell", () => {
    const out = html(createElement(WaitingRows, { items, now }))
    for (const i of items) expect(out).toContain(`data-waiting-item="${i.key}"`)
    expect(out).toContain('href="#page=home&amp;pane=waiting&amp;open=card%3Ac2"')
    expect(out).toContain("Decision")
    expect(out).toContain("Answer today")
    expect(out).toContain("@builder")
  })
  it("an opened decision: the question, what yes and no do, the deadline, Answer", () => {
    const out = html(createElement(WaitingDetail, { item: items[0], now }))
    expect(out).toContain('data-waiting="open"')
    expect(out).toContain("PR #2330 is green. Merge it now?")
    expect(out).toContain("It is merged and released.")
    expect(out).toContain("If you say nothing: kept open")
    expect(out).toContain(`href="${NEEDS_YOU_PAGE.replace(/&/g, "&amp;")}"`)
    expect(out).not.toContain('data-waiting="task"')
  })
  it("an opened request opens its task in Tasks; choices are listed", () => {
    expect(html(createElement(WaitingDetail, { item: items[1], now }))).toContain('href="#page=home&amp;pane=tasks&amp;open=q3"')
    expect(html(createElement(WaitingDetail, { item: items[2], now }))).toContain('data-waiting="choices"')
  })
  it("empty: says so; what was put off is counted", () => {
    const out = html(createElement(WaitingBody, { list: { items: [], later: 2, errors: [] } }))
    expect(out).toContain("Nothing waits for you")
    expect(out).toContain("2 put off for later")
  })
  it("a source that could not be read is said above the list", () => {
    const out = html(createElement(WaitingBody, { list: { items, later: 0, errors: ["Requests could not be read: locked"] }, now }))
    expect(out).toContain('role="alert"')
    expect(out).toContain("locked")
    expect(out).toContain('data-waiting="list"')
  })
  it("error: the reason and Try again", () => {
    const out = html(createElement(WaitingBody, { error: "unauthorized" }))
    expect(out).toContain("Could not read what waits on you")
    expect(out).toContain("Try again")
  })
  it("loading: placeholders, no list yet", () => {
    const out = html(createElement(WaitingBody, {}))
    expect(out).toContain("animate-pulse")
    expect(out).not.toContain('data-waiting="list"')
  })
})

describe("the menu opens both in the shell", () => {
  const draw = (p: Partial<SimpleShellProps> = {}) => html(createElement(SimpleShell, {
    view: resolveHubLayout(), owner: true, agents: [{ id: "ada", name: "Ada" }], agent: "ada", ...p,
  }))
  it("Automations and Waiting on you link to their panes, not the old Hub", () => {
    expect(SHELL_MAIN.find((i) => i.id === "automations")?.href).toBe("#page=home&pane=automations")
    expect(SHELL_MAIN.find((i) => i.id === "needs")?.href).toBe("#page=home&pane=waiting")
    expect(ICON_NAMES).toContain("chevron-right")
  })
  it("Automations open: the centre is Automations, its item is marked", () => {
    const out = draw({ pane: "automations" })
    expect(out).toContain('data-shell="automations"')
    expect(out).not.toContain('data-shell="chat"')
    expect(out).toMatch(/aria-current="page"[^>]*>[\s\S]*?Automations</)
    expect(out.match(/aria-current="page"/g)?.length).toBe(1)
    expect(out).not.toContain('data-shell="tasks-switch"')
  })
  it("Waiting on you open: the centre is Waiting on you, its item is marked", () => {
    const out = draw({ pane: "waiting" })
    expect(out).toContain('data-shell="waiting"')
    expect(out).toMatch(/aria-current="page"[^>]*>[\s\S]*?Waiting on you</)
    expect(out.match(/aria-current="page"/g)?.length).toBe(1)
  })
})
