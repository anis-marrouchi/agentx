// Activity in the React simple shell (#2457): the runs read from every
// machine (and what is missing said), the Feed's outcome, source, filters
// and summary, the run's Task page link, the Timeline's lanes, the panes
// drawn for sample data, empty and error, and the menu wiring (Activity
// opens in the shell's centre, not the old Hub's #page=activity).
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import {
  EMPTY_FILTER, NO_PROJECT, activityHref, activityTimeline, feedChoices, feedMatch, feedSummary, laneOf, loadActivity,
  runFrom, runHref, runResult, runSource, runTook, type ActivityData, type ActivityRun,
} from "../src/hub/activity"
import { SHELL_MORE } from "../src/hub/shell"
import { parseHash } from "../src/hub/router"
import { shellPane } from "../src/hub/tasks"
import { ActivityBody, ActivityPane } from "../src/hub/pages/ShellActivity"
import { ActivityFeed } from "../src/hub/pages/ActivityFeed"
import { TooltipProvider } from "../src/hub/ui"

const now = Date.parse("2026-11-27T12:00:00Z")
const M = 60_000
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, el)))

const run = (over: Partial<ActivityRun>): ActivityRun => ({ id: "r", agentId: "coder", startedAt: now - 10 * M, status: "ok", ...over })
const runs: ActivityRun[] = [
  run({ id: "a", agentId: "coder", channel: "telegram", person: "dana", personName: "Dana", project: "agentx", durationMs: 90_000, costUsd: 0.42, preview: "Fix the build\nmore", node: "studio", nodeUrl: "http://studio" }),
  run({ id: "b", agentId: "builder", channel: "cron", status: "error", durationMs: 30_000, startedAt: now - 30 * M, node: "studio", nodeUrl: "http://studio" }),
  run({ id: "c", agentId: "coder", channel: "wall", status: "running", durationMs: undefined, startedAt: now - 2 * M, node: "laptop", nodeUrl: "http://laptop" }),
]
const data: ActivityData = { runs, marks: [{ runId: "a", kind: "decision", text: "Picked option B" }], errors: [] }

describe("reading the runs", () => {
  it("reads every machine that answers, newest first, and names the ones missing", async () => {
    const seen: string[] = []
    const get = async <T,>(path: string): Promise<T> => {
      seen.push(path)
      if (path === "/api/monitor?nodes=1") return { nodes: [{ name: "studio", url: "http://studio", ok: true }, { name: "laptop", url: "http://laptop", ok: true }, { name: "pi", url: "http://pi", ok: false }] } as T
      if (path.includes("laptop")) throw new Error("timeout")
      return { node: "studio", runs: [{ id: "old", agentId: "x", startedAt: 1, status: "ok" }, { id: "new", agentId: "x", startedAt: 2, status: "ok" }], marks: [{ runId: "new", kind: "warning", text: "w" }] } as T
    }
    const d = await loadActivity(24, get, now)
    expect(seen).toContain("/api/monitor/activity?node=" + encodeURIComponent("http://studio") + "&hours=24")
    expect(d.runs.map((r) => r.id)).toEqual(["new", "old"])
    expect(d.runs[0]).toMatchObject({ node: "studio", nodeUrl: "http://studio" })
    expect(d.marks).toHaveLength(1)
    expect(d.errors[0]).toBe("pi, laptop do not answer: its runs are missing.")
  })
})

describe("the Feed as data", () => {
  it("reads a trace's status as an outcome and its channel as a source", () => {
    expect(["ok", "error", "timeout", "canceled", "in-flight"].map(runResult)).toEqual(["done", "failed", "failed", "stopped", "running"])
    expect(runs.map(runSource)).toEqual(["messages", "jobs", "wall"])
    expect(runSource({ agentId: "workflow:pr", channel: "" })).toBe("workflows")
    expect(runFrom(runs[0])).toBe("from a message on telegram, by Dana")
    expect(runFrom(runs[1])).toBe("from a job")
  })
  it("says how long, or how long so far", () => {
    expect(runTook(runs[0])).toBe("1m 30s")
    expect(runTook(runs[2], now)).toBe("2m 0s so far")
  })
  it("filters by agent, project, source and outcome, and counts failed without the outcome", () => {
    expect(runs.filter((r) => feedMatch(r, { ...EMPTY_FILTER, agent: "coder" })).map((r) => r.id)).toEqual(["a", "c"])
    expect(runs.filter((r) => feedMatch(r, { ...EMPTY_FILTER, project: NO_PROJECT })).map((r) => r.id)).toEqual(["b", "c"])
    expect(runs.filter((r) => feedMatch(r, { ...EMPTY_FILTER, source: "jobs" })).map((r) => r.id)).toEqual(["b"])
    const f = { ...EMPTY_FILTER, result: "done" as const }
    expect(runs.filter((r) => feedMatch(r, f)).map((r) => r.id)).toEqual(["a"])
    expect(runs.filter((r) => feedMatch(r, f, "result"))).toHaveLength(3)
    expect(feedChoices(runs)).toEqual({ agents: ["builder", "coder"], projects: ["agentx", NO_PROJECT] })
  })
  it("sums the runs shown, with what is unpriced", () => {
    expect(feedSummary(runs, 3, "24 h")).toBe("3 runs, 1 failed in the last 24 h · 2m 0s of agent time · $0.420 (2 unpriced)")
  })
  it("opens a run on its Task page, as the old Hub does", () => {
    const q = parseHash(runHref(runs[0]))
    expect(Object.fromEntries(q)).toMatchObject({ page: "task", task: "a", agent: "coder", node: "http://studio", ch: "telegram", done: "1" })
    expect(parseHash(runHref(runs[2])).get("done")).toBeNull()
  })
})

describe("the Timeline as data", () => {
  it("hangs runs from the lane of the perspective", () => {
    expect(laneOf(runs[0], "agent")).toEqual({ key: "coder|telegram", label: "coder", sub: "telegram" })
    expect(laneOf(runs[1], "project").label).toBe("no project")
    expect(laneOf(runs[2], "node").label).toBe("laptop")
    expect(activityTimeline(data, "node").lanes.map((l) => l.label).sort()).toEqual(["laptop", "studio"])
  })
})

describe("the pane", () => {
  it("draws the Feed rows with outcome, source, cost and project", () => {
    const out = html(createElement(ActivityFeed, { data, period: "24 h" }))
    expect(out).toContain('data-run="a"')
    expect(out).toContain("Fix the build")
    expect(out).not.toContain("more</a>")
    expect(out).toContain("from a message on telegram, by Dana")
    expect(out).toContain("$0.420")
    expect(out).toContain('data-result="failed"')
    expect(out).toContain("3 runs, 1 failed in the last 24 h")
  })
  it("says when nothing ran", () => {
    expect(html(createElement(ActivityFeed, { data: { runs: [], marks: [], errors: [] }, period: "7 d" }))).toContain("Nothing ran in the last 7 d")
  })
  it("says what is missing, and an error with a way to try again", () => {
    expect(html(createElement(ActivityBody, { data: { ...data, errors: ["pi does not answer: its runs are missing."] }, view: "feed", perspective: "agent", period: "24 h" })))
      .toContain("pi does not answer")
    const err = html(createElement(ActivityBody, { view: "feed", perspective: "agent", period: "24 h", error: "HTTP 500" }))
    expect(err).toContain("Could not read the runs")
    expect(err).toContain("Try again")
  })
  it("draws the Timeline's lanes and runs", () => {
    const out = html(createElement(ActivityBody, { data, view: "timeline", perspective: "agent", period: "24 h" }))
    expect(out).toContain('data-activity="timeline"')
    expect(out).toContain('data-run="b"')
  })
  it("opens on the Feed, with Timeline and Map beside it", () => {
    const out = html(createElement(ActivityPane, {}))
    expect(out).toContain('data-shell="activity"')
    expect(out).toMatch(/aria-pressed="true" data-value="feed"/)
    expect(out).toContain('data-value="map"')
  })
})

describe("the menu", () => {
  it("opens Activity in the shell's centre", () => {
    expect(SHELL_MORE.activity?.href).toBe(activityHref())
    expect(shellPane(parseHash(activityHref())).pane).toBe("activity")
  })
})
