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

describe("n8n inside the builder", () => {
  it("lets a palette item arrive preconfigured, so nobody copies a URL", async () => {
    const { PALETTE } = await import("../src/web/workflow-editor/data")
    // Static items carry no config; the n8n ones the palette fetches do, and
    // defaultConfigFor prefers it over its own guesswork.
    const src = (await import("fs")).readFileSync("src/web/workflow-editor/App.tsx", "utf-8")
    expect(src).toContain("if (item.config) return { ...item.config }")
    const pal = (await import("fs")).readFileSync("src/web/workflow-editor/Palette.tsx", "utf-8")
    expect(pal).toContain("/api/n8n/workflows")
    // Only workflows n8n actually exposes over a webhook can be handed work.
    expect(pal).toContain("filter((w) => w.webhookUrl)")
    expect(PALETTE.every(s => s.items.every(i => i.config === undefined))).toBe(true)
  })

  it("asks for things in words a non-engineer can answer", async () => {
    const insp = (await import("fs")).readFileSync("src/web/workflow-editor/Inspector.tsx", "utf-8")
    for (const jargon of ["Cron spec", "Result parser", "Passthrough", "Entity kind", "Input expressions"]) {
      expect(insp).not.toContain(`label="${jargon}"`)
    }
    expect(insp).toContain('label="When it runs"')
    expect(insp).toContain('label="What to ask for"')
  })

  it("describes a node by what it does, never by its id alone", async () => {
    const { nodeSummary } = await import("../src/web/workflow-editor/data")
    expect(nodeSummary("agent", { agentId: "atlas", prompt: "Review the MR" })).toBe("ask atlas — Review the MR")
    expect(nodeSummary("trigger.hook", { event: "on:n8n" })).toBe("when n8n calls")
    expect(nodeSummary("action.callHTTP", { url: "http://localhost:5678/webhook/deploy" }))
      .toBe("http://localhost:5678/webhook/deploy")
    // Nothing to say means no row at all, rather than an empty one.
    expect(nodeSummary("trigger.manual", {})).toBe("")
    expect(nodeSummary("end", {})).toBe("")
  })

  it("follows the dashboard theme instead of keeping its own", async () => {
    const app = (await import("fs")).readFileSync("src/web/workflow-editor/App.tsx", "utf-8")
    // Two stores writing one data-theme attribute meant opening the editor
    // could flip the whole product's theme under the user.
    expect(app).not.toContain("wfe.theme")
    expect(app).toContain('localStorage.setItem("ax-theme", theme)')
    expect(app).toContain('document.documentElement.getAttribute("data-theme")')
  })

  it("wears no colour the design system does not define", async () => {
    const css = (await import("fs")).readFileSync("src/web/workflow-editor/redesign.css", "utf-8")
    // Variable definitions may hold literals; rules must not, or they render
    // an off-system colour whenever the variable they name does not exist.
    const rules = css.replace(/:root[^{]*\{[^}]*\}/g, "")
    expect(rules.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })

  it("gives each build its own asset URL so a deploy invalidates the cache", async () => {
    const { assetUrl } = await import("../src/daemon/ui/asset-url")
    const url = assetUrl("workflow-editor.global.js")
    expect(url).toMatch(/^\/assets\/workflow-editor\.global\.js(\?v=[0-9a-f]+)?$/)
    expect(renderWorkflowEditorPage()).toContain(url)
  })
})

describe("n8n topic routing", () => {
  it("lets one address address one workflow", async () => {
    const src = (await import("fs")).readFileSync("src/workflows/triggers.ts", "utf-8")
    // Without a topic gate every workflow listening on on:n8n woke for every
    // call, so the topic in the URL was decoration.
    expect(src).toContain("filter.topic")
    expect(src).toContain("topic?: string[]")
    expect(src).toContain("cfg.filter.topic")
  })
})
