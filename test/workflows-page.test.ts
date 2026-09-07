import { describe, expect, it } from "vitest"
import { renderWorkflowsPage, WORKFLOWS_PAGE_SCRIPT } from "../src/daemon/ui/pages/workflows"
import { renderMonitorPage } from "../src/daemon/ui/pages/monitor"
import { injectFns } from "../src/daemon/ui/inject"
import { workflowHealth } from "../src/daemon/workflow-health"
import { renderTopbar } from "../src/daemon/topbar"

describe("workflows page", () => {
  it("ships workflow health with every helper it calls", () => {
    // new Function() cannot see the module, so a missing dependency throws
    // here exactly as it would in the browser.
    // TWO workflows, deliberately: Array.sort never calls its comparator on a
    // one-element list, so a single-item probe missed an unbound constant in
    // the sort and the page died on any fleet with more than one workflow.
    const out = new Function(injectFns({ workflowHealth }) + `return workflowHealth(
      [{id:"a"},{id:"b"}],
      [{workflowId:"a",status:"completed",at:Date.now()-9*86400000},
       {workflowId:"b",status:"completed",at:Date.now()-86400000}], Date.now()).map(h => h.state)`)()
    expect(out).toEqual(["dormant", "active"])
  })

  it("touches no element the page does not render", () => {
    const html = renderWorkflowsPage()
    const missing = [...new Set([...WORKFLOWS_PAGE_SCRIPT.matchAll(/getElementById\("([a-zA-Z0-9_-]+)"\)/g)].map(m => m[1]))]
      .filter(id => !html.includes(`id="${id}"`))
    expect(missing).toEqual([])
  })

  it("says what a workflow is doing in words, not status codes", () => {
    for (const phrase of ["stopped running", "running normally", "never run yet", "on a schedule"]) {
      expect(WORKFLOWS_PAGE_SCRIPT).toContain(phrase)
    }
    // The empty state should not send a newcomer to the filesystem.
    expect(renderWorkflowsPage()).not.toContain("agentx workflow validate")
  })

  it("exposes the n8n seam on the page instead of in a doc", () => {
    expect(renderWorkflowsPage()).toContain("Connected to n8n")
    expect(WORKFLOWS_PAGE_SCRIPT).toContain("/webhook/n8n/")
  })

  it("keeps workflow health off the briefing", () => {
    // Dormant automation is a workflows-page concern; the briefing is for
    // work that needs a person.
    const html = renderMonitorPage()
    expect(html).not.toContain('id="automation"')
    expect(html).not.toContain("stopped firing")
  })

  it("is reachable from the nav on every page that has one", () => {
    // A surface with no tab is a surface nobody opens. Workflow dormancy
    // reports nowhere else, so this link is load-bearing.
    for (const tab of ["live", "monitor", "workflows"] as const) {
      const bar = renderTopbar({ activeTab: tab, subtitle: "t" })
      expect(bar).toContain('href="/workflows"')
    }
    expect(renderTopbar({ activeTab: "workflows", subtitle: "t" }))
      .toMatch(/href="\/workflows" class="ax-topbar__tab is-active"/)
  })

  it("calls the thing one name", () => {
    const html = renderWorkflowsPage()
    expect(html).toContain("No workflows yet")
    expect(html).not.toContain("No automations yet")
  })

  it("ships browser code that actually parses", () => {
    // This page had no such check, so a bad edit shipped a SyntaxError and
    // the whole page — list, detail, n8n panel — rendered blank with only a
    // console error to show for it.
    expect(() => new Function(WORKFLOWS_PAGE_SCRIPT)).not.toThrow()
  })

  it("touches no element the page does not render", () => {
    const html = renderWorkflowsPage()
    const missing = [...new Set([...WORKFLOWS_PAGE_SCRIPT.matchAll(/\$\("#([a-zA-Z0-9_-]+)"\)/g)].map(m => m[1]))]
      .filter(id => !html.includes(`id="${id}"`))
    expect(missing).toEqual([])
  })

  it("has no generated-draft surface left", () => {
    const html = renderWorkflowsPage()
    expect(html).not.toContain("ax-wf__drafts")
    expect(WORKFLOWS_PAGE_SCRIPT).not.toContain("/api/workflows/drafts")
  })
})
