// The Workflows page in the React simple shell (#2457): the old Hub's
// #page=workflows (wall-workflows.client.ts) as a centre pane, its data
// side (src/hub/workflows.ts) and the menu wiring.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SHELL_MORE } from "../src/hub/shell"
import { parseHash } from "../src/hub/router"
import { shellPane } from "../src/hub/tasks"
import {
  NO_PROJECT, cronWords, lastInput, matches, projectsOf, runPayload, runFields, runSteps, sortRows, staleWords, stopLine,
  summaryLine, tabOf, wfStarts, wfState, type WfRun, type Workflow,
} from "../src/hub/workflows"
import { WorkflowsBody } from "../src/hub/pages/ShellWorkflows"
import { TooltipProvider } from "../src/hub/ui"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const NOW = Date.parse("2026-11-28T12:00:00Z")
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()

const triage: Workflow = {
  id: "triage", title: "Triage new issues", project: "site", state: "active",
  nodes: [
    { id: "t", type: "trigger.hook", config: { event: "on:gitlab-issue" } },
    { id: "read_ticket", type: "agent", config: { agentId: "coder" } },
    { id: "reply", type: "agent", config: { agentId: "pm", title: "Write the reply" } },
    { id: "end", type: "end" },
  ],
}
const digest: Workflow = { id: "digest", title: "Morning digest", state: "active", nodes: [{ id: "t", type: "trigger.cron", config: { spec: "30 7 * * 1-5" } }, { id: "send", type: "agent", config: { agentId: "pm" } }] }
const old: Workflow = { id: "old", title: "Old sweep", state: "disabled", nodes: [{ id: "t", type: "trigger.manual", config: { inputSchema: { properties: { repo: { type: "string", title: "Repo" }, dry: { type: "boolean", default: true } }, required: ["repo"] } } }] }

const runs: WfRun[] = [
  { id: "r1", workflowId: "triage", status: "failed", createdAt: iso(30), updatedAt: iso(20), history: [
    { nodeId: "t", status: "completed" }, { nodeId: "read_ticket", status: "completed", durationMs: 65_000 }, { nodeId: "reply", status: "timeout" },
  ] },
  { id: "r0", workflowId: "triage", status: "completed", createdAt: iso(300), updatedAt: iso(290) },
  { id: "r2", workflowId: "digest", status: "running", createdAt: iso(5), updatedAt: iso(1), history: [{ nodeId: "t", status: "completed" }] },
]

describe("workflows as data", () => {
  it("says what starts a workflow in words", () => {
    expect(wfStarts(triage)).toBe("When a GitLab issue changes")
    expect(wfStarts(digest)).toBe("Weekdays at 07:30")
    expect(wfStarts(old)).toBe("Started by hand")
    expect(cronWords("*/15 * * * *")).toBe("Every 15 min")
    expect(cronWords("0 9 * * 1")).toBe("Mondays at 09:00")
    expect(cronWords("0 9 1 * *")).toBe("On a schedule (0 9 1 * *)")
  })

  it("gives each workflow its state and tab, failing first", () => {
    const st = (wf: Workflow) => wfState(wf, runs.filter((r) => r.workflowId === wf.id))
    expect(st(triage)).toBe("failed")
    expect(st(digest)).toBe("running")
    expect(st(old)).toBe("off")
    expect([tabOf("failed"), tabOf("waiting"), tabOf("held"), tabOf("done")]).toEqual(["failed", "running", "off", ""])
    const rows = sortRows([old, digest, triage].map((wf) => ({ wf, state: st(wf) })))
    expect(rows.map((r) => r.wf.id)).toEqual(["triage", "digest", "old"])
  })

  it("says where a failed run stopped, and lists its steps", () => {
    expect(stopLine(triage, runs[0])).toBe('Stopped at "Write the reply": it ran out of time')
    const steps = runSteps(triage, runs[0])
    expect(steps.map((s) => [s.name, s.who, s.meta, s.state])).toEqual([
      ["Read ticket", "coder", "1 min 5 s", "done"],
      ["Write the reply", "pm", "it ran out of time", "failed"],
    ])
    expect(runSteps(digest, { ...runs[2], pending: ["send"] }).map((s) => s.state)).toEqual(["running"])
  })

  it("marks a workflow off and quiet for 30 days as stale, unless the read was cut short", () => {
    expect(staleWords(old, [], false, NOW)).toBe("never run")
    expect(staleWords(old, [], true, NOW)).toBeNull()
    expect(staleWords(old, [{ ...runs[0], workflowId: "old", updatedAt: iso(60 * 24 * 40) }], false, NOW)).toBe("no run for 40 days")
    expect(staleWords(triage, [], false, NOW)).toBeNull()
  })

  it("filters by words, project and No project", () => {
    const f = { tab: "" as const, q: "", project: "" }
    expect(matches(triage, { ...f, q: "coder" }, "failed")).toBe(true)
    expect(matches(triage, { ...f, q: "nothing" }, "failed")).toBe(false)
    expect(matches(digest, { ...f, project: NO_PROJECT }, "running")).toBe(true)
    expect(matches(triage, { ...f, project: NO_PROJECT }, "failed")).toBe(false)
    expect(matches(triage, { ...f, tab: "running" }, "failed")).toBe(false)
    expect(projectsOf([triage, digest])).toEqual(["site", NO_PROJECT])
  })

  it("sums the week", () => {
    expect(summaryLine([triage, digest, old], runs, NOW)).toBe("3 workflows, 2 on · 3 runs this week, 1 failed")
  })

  it("builds Run… from the trigger's inputs and checks what is needed", () => {
    const fields = runFields(old)
    expect(fields.map((x) => [x.key, x.kind, x.required, x.initial])).toEqual([["repo", "text", true, ""], ["dry", "boolean", false, true]])
    expect(runPayload(fields, {}, "{}")).toEqual({ error: "Fill in Repo." })
    expect(runPayload(fields, { repo: "site" }, "{}")).toEqual({ payload: { repo: "site", dry: true } })
    expect(runPayload(fields, {}, '{"repo":"x"}')).toEqual({ payload: { repo: "x", dry: true } })
    expect(runPayload(fields, { repo: "a" }, "[1]")).toEqual({ error: "The JSON is not valid: it must be an object, in { }." })
    expect(lastInput(triage, { ...runs[0], context: { t: { event: { payload: { iid: 7 } } } } })).toEqual({ iid: 7 })
  })
})

const body = (props: Partial<Parameters<typeof WorkflowsBody>[0]>) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(TooltipProvider, null, createElement(WorkflowsBody, { owner: true, open: null, onOpen: () => {}, ...props }))))

describe("the Workflows pane", () => {
  it("loads, then fails with Try again", () => {
    expect(body({})).toContain('aria-label="Loading the workflows"')
    const err = body({ error: "offline" })
    expect(err).toContain("Could not read the workflows")
    expect(err).toContain("Try again")
  })

  it("has an empty state with New workflow for the owner only", () => {
    expect(body({ defs: [], runs: [] })).toContain('href="#page=editor&amp;e-new=1"')
    expect(body({ defs: [], runs: [], owner: false })).not.toContain("e-new=1")
  })

  it("lists the rows, failing first, with tabs, counts, summary and switches", () => {
    const html = body({ defs: [old, digest, triage], runs })
    expect(html.indexOf('data-workflow="triage"')).toBeLessThan(html.indexOf('data-workflow="digest"'))
    expect(html.indexOf('data-workflow="digest"')).toBeLessThan(html.indexOf('data-workflow="old"'))
    expect(html).toContain('role="tablist"')
    expect(html).toContain('data-workflows="summary"')
    expect(html).toContain("Stopped at &quot;Write the reply&quot;")
    expect(html.match(/data-slot="switch"/g)).toHaveLength(3)
    expect(html.match(/data-workflows="run"/g)).toHaveLength(2)
    expect(html).toContain("never run · looks stale")
  })

  it("shows no switch or Run to a guest, and says why", () => {
    const html = body({ defs: [triage], runs, owner: false })
    expect(html).not.toContain('data-slot="switch"')
    expect(html).not.toContain('data-workflows="run"')
    expect(html).toContain("Only the owner can start, turn on or turn off a workflow.")
  })

  it("opens a row on its last run with the editor and all-runs links", () => {
    const html = body({ defs: [triage], runs, open: "triage" })
    expect(html).toContain('data-workflows="open"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('href="#page=editor&amp;e-wf=triage"')
    expect(html).toContain('href="/workflows#triage"')
    expect(html).toContain("All 2 runs")
  })

  it("says No workflow matches with Clear the filters", () => {
    const html = body({ defs: [triage], runs, initialFilter: { q: "zzz" } })
    expect(html).toContain("No workflow matches")
    expect(html).toContain("Clear the filters")
  })
})

describe("the menu", () => {
  it("opens Workflows in the shell's centre, with the open workflow in the hash", () => {
    const href = SHELL_MORE.workflows?.href ?? ""
    expect(href).toBe("#page=home&pane=workflows")
    expect(shellPane(parseHash(href)).pane).toBe("workflows")
    expect(shellPane(parseHash(href + "&open=triage")).open).toBe("triage")
  })
})
