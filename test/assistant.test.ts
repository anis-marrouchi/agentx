import { describe, expect, it } from "vitest"
import { ASSISTANT_CSS, ASSISTANT_HTML, ASSISTANT_SCRIPT } from "../src/daemon/ui/assistant"
import { renderMonitorPage, MONITOR_SCRIPT } from "../src/daemon/ui/pages/monitor"
import { renderWorkflowsPage } from "../src/daemon/ui/pages/workflows"

describe("ask-an-agent drawer", () => {
  it("ships on every page, so the question is always one click from the work", () => {
    for (const html of [renderMonitorPage(), renderWorkflowsPage()]) {
      expect(html).toContain('id="ax-as-handle"')
      expect(html).toContain('id="ax-as"')
    }
  })

  it("parses, and touches no element it does not ship", () => {
    expect(() => new Function(ASSISTANT_SCRIPT)).not.toThrow()
    const missing = [...new Set([...ASSISTANT_SCRIPT.matchAll(/\$\('([a-zA-Z0-9_-]+)'\)/g)].map(m => m[1]))]
      .filter(id => !ASSISTANT_HTML.includes(`id="${id}"`))
    expect(missing).toEqual([])
  })

  it("sends what the page is showing, and treats it as data", () => {
    // The drawer asks the page for its own slice; pages that do not publish
    // one still send the path, so a question is never contextless.
    expect(ASSISTANT_SCRIPT).toContain("window.axPageContext")
    expect(ASSISTANT_SCRIPT).toContain("path:location.pathname")
    // The monitor publishes the filter in force and only what is on screen.
    expect(MONITOR_SCRIPT).toContain("window.axPageContext=()=>")
    expect(MONITOR_SCRIPT).toContain("client:clientFilter||'all'")
    expect(MONITOR_SCRIPT).toContain("slice(0,8)")
  })

  it("keeps the drawer usable by keyboard", () => {
    expect(ASSISTANT_SCRIPT).toContain("e.key==='Escape'")
    expect(ASSISTANT_SCRIPT).toContain("e.metaKey||e.ctrlKey")
    expect(ASSISTANT_HTML).toContain('aria-expanded="false"')
    expect(ASSISTANT_HTML).toContain('aria-hidden="true"')
  })
})

describe("action paging", () => {
  it("renders a page at a time instead of three hundred cards", () => {
    expect(MONITOR_SCRIPT).toContain("const PAGE=25")
    expect(MONITOR_SCRIPT).toContain("data-more=")
    // Changing the principal filter starts the paging over, or the button
    // would offer to reveal rows that are no longer in the set.
    expect(MONITOR_SCRIPT).toContain("shown={you:PAGE,agents:PAGE};renderPrincipals()")
  })

  it("puts a composer on the page, not just inside the drawer", () => {
    // Asking should cost no clicks: the drawer's own input is only reachable
    // once you have already opened it.
    expect(ASSISTANT_HTML).toContain('id="ax-as-bar"')
    expect(ASSISTANT_HTML).toContain('id="ax-as-bar-input"')
    // One composer at a time — the bar hides while the drawer is open.
    expect(ASSISTANT_CSS).toContain("body.ax-as-open .ax-as-bar{display:none}")
    // ...and the page keeps its last row clear of it.
    expect(ASSISTANT_CSS).toContain("body:not(.ax-as-open){padding-bottom:72px}")
  })

  it("sends from the bar through the same conversation as the drawer", () => {
    expect(ASSISTANT_SCRIPT).toContain("$('ax-as-bar').addEventListener('submit'")
    // It reuses send() rather than posting on its own, so a question asked
    // from the page continues the thread rather than starting a stray one.
    expect(ASSISTANT_SCRIPT).toContain("open(true);\nsend();")
  })

  it("still loads its pickers, and says so when it cannot", () => {
    // These once vanished in an edit and the picker sat on "Loading agents…"
    // forever, so a question silently did nothing.
    expect(ASSISTANT_SCRIPT).toContain("fetch('/api/agents')")
    expect(ASSISTANT_SCRIPT).toContain("no agents on this node")
    expect(ASSISTANT_SCRIPT).toContain("agents unavailable")
    expect(ASSISTANT_SCRIPT).toContain("function add(kind,text)")
  })
})
