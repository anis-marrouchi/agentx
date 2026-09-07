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
    // The composer is a <form>, so Enter submits without a key handler.
    expect(ASSISTANT_HTML).toContain('<form class="ax-as-bar"')
    expect(ASSISTANT_HTML).toContain('type="submit"')
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

  it("still loads its pickers, and says so when it cannot", () => {
    // These once vanished in an edit and the picker sat on "Loading agents…"
    // forever, so a question silently did nothing.
    expect(ASSISTANT_SCRIPT).toContain("fetch('/api/agents')")
    expect(ASSISTANT_SCRIPT).toContain("no agents on this node")
    expect(ASSISTANT_SCRIPT).toContain("agents unavailable")
    expect(ASSISTANT_SCRIPT).toContain("function add(kind,text)")
  })

  it("puts one composer on the page, centred, and no second one in the drawer", () => {
    expect(ASSISTANT_HTML).toContain('id="ax-as-dock"')
    expect(ASSISTANT_HTML).toContain('id="ax-as-bar-input"')
    // The drawer is the transcript; two inputs for one conversation is a
    // question about which one you are typing into.
    expect(ASSISTANT_HTML).not.toContain('id="ax-as-input"')
    expect(ASSISTANT_CSS).toContain(".ax-as-dock{position:fixed;bottom:0;left:50%;transform:translateX(-50%)")
    // Centred in the space that is left, not the space the drawer covers.
    expect(ASSISTANT_CSS).toContain("body.ax-as-open .ax-as-dock{left:calc((100vw - var(--ax-as-w)) / 2)}")
  })

  it("slides away and leaves something to bring it back", () => {
    expect(ASSISTANT_HTML).toContain('id="ax-as-bar-toggle"')
    // Tucked by its own height minus the grip, or nothing is clickable.
    expect(ASSISTANT_CSS).toContain("translateY(calc(100% - 26px))")
    expect(ASSISTANT_SCRIPT).toContain("localStorage.setItem('ax-assistant-bar'")
  })

  it("opens on focus and on a running answer, but never over a deliberate close", () => {
    expect(ASSISTANT_SCRIPT).toContain("$('ax-as-bar-input').addEventListener('focus',()=>{if(!userHid())open(true);});")
    // '0' is set only by open(false) — a close the operator chose. Absent
    // means they have simply not opened it yet, and auto-open is welcome.
    expect(ASSISTANT_SCRIPT).toContain("localStorage.getItem('ax-assistant-open')==='0'")
    expect(ASSISTANT_SCRIPT).toContain("if(threadId&&!userHid()&&$('ax-as-log').querySelector('.ax-as__pending'))open(true);")
  })
})

describe("rendering what agents write", () => {
  it("renders markdown in the drawer, tables included", async () => {
    const { markdownToHtml } = await import("../src/utils/markdown-html")
    // The reply arrives as markdown; showing the asterisks is showing the
    // workings.
    const out = markdownToHtml("**Saber is active** — `last_activity_on` = today\n\n| who | when |\n|---|---|\n| saber | 17:20 |")
    expect(out).toContain("<strong>Saber is active</strong>")
    expect(out).toContain("<code>last_activity_on</code>")
    expect(out).toContain("<td>saber</td>")
    expect(ASSISTANT_SCRIPT).toContain("markdownToHtml(body)")
    // A wide table must scroll inside the bubble, not stretch the drawer.
    expect(ASSISTANT_CSS).toContain(".ax-as__md table{display:block;overflow-x:auto")
  })

  it("carries the whole request to a live task page", async () => {
    const reg = (await import("fs")).readFileSync("src/agents/registry.ts", "utf-8")
    const dmn = (await import("fs")).readFileSync("src/daemon/index.ts", "utf-8")
    // The page seeded its request card from a 200-char preview, so a live
    // task showed a request cut off mid-JSON.
    expect(reg).toContain("message: task.message || \"\",")
    expect(dmn).toContain("message: live.message, sender: live.sender")
  })
})
