import { describe, expect, it } from "vitest"
import { renderWorkflowEditorPage } from "../src/daemon/ui/pages/workflow-editor"
import { renderWorkflowsPage } from "../src/daemon/ui/pages/workflows"
import { PALETTE } from "../src/web/workflow-editor/data"
import { NODE_HANDLERS } from "../src/workflows/nodes/handlers"

// Types the engine runs but that live outside NODE_HANDLERS — the dispatcher
// pauses on these rather than executing a handler.
const DISPATCHER_TYPES = new Set(["userTask", "subProcess"])

describe("workflow editor", () => {
  it("offers only node types the engine can actually run", () => {
    // The editor was removed for a while and the engine moved on. A palette
    // item the engine cannot run produces a workflow that fails at dispatch,
    // which is worse than not offering it.
    const runnable = new Set([...Object.keys(NODE_HANDLERS), ...DISPATCHER_TYPES])
    const unknown = [...new Set(PALETTE.flatMap(s => s.items.map(i => i.type)))]
      .filter(t => !runnable.has(t))
    expect(unknown).toEqual([])
  })

  it("offers every node type the engine can run", () => {
    // The other direction: a node kind with no palette entry is unreachable
    // from the canvas, which is how trigger.hook — the way n8n starts a
    // workflow — was invisible for a whole release.
    const offered = new Set(PALETTE.flatMap(s => s.items.map(i => i.type)))
    const missing = Object.keys(NODE_HANDLERS).filter(t => !offered.has(t))
    expect(missing).toEqual([])
  })

  it("gives every palette item a unique id", () => {
    const ids = PALETTE.flatMap(s => s.items.map(i => i.id))
    expect(ids.length).toBe(new Set(ids).size)
  })

  it("names steps by what they do, not by their node type", () => {
    const labels = PALETTE.flatMap(s => s.items.map(i => i.label))
    for (const jargon of ["Cron", "Manual", "Decision table", "Parallel gateway", "HTTP Request"]) {
      expect(labels).not.toContain(jargon)
    }
    expect(labels).toContain("n8n hands work over")
    expect(labels).toContain("A time of day")
  })

  it("is reachable from the workflows page and mounts its bundle", () => {
    expect(renderWorkflowsPage()).toContain("/workflows/editor?new=1")
    const html = renderWorkflowEditorPage()
    expect(html).toContain('id="wfe-root"')
    expect(html).toContain("/assets/workflow-editor")
  })

  it("wears the dashboard's tokens instead of its own palette", async () => {
    const css = (await import("fs")).readFileSync("src/web/workflow-editor/redesign.css", "utf-8")
    // The bridge has to beat :root[data-theme="dark"] from the original theme.
    expect(css).toContain(':root, :root[data-theme][data-theme]')
    expect(css).toContain("--surface:    var(--ax-surface)")
    expect(css).toContain("--ink:        var(--ax-text)")
  })
})
