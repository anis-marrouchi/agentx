import { describe, expect, it } from "vitest"
import { atFields, atList, atNextHtml, atPickerHtml } from "../src/daemon/ui/pages/wall-agent-templates"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { injectFns } from "../src/daemon/ui/inject"

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
const href = (sec: string) => "#page=settings&st=" + sec

// #2101 P10 (mock R6): Add an agent starts from a template.
describe("agent templates", () => {
  it("each fills id, name, triggers, a known engine and a purpose, and names its first action", () => {
    const engines = ["claude-code", "codex-cli", "opencode", "sdk", "orchestrator"]
    expect(atList().length).toBeGreaterThanOrEqual(4)
    for (const t of atList()) {
      expect(t.id).toMatch(/^[a-z0-9_-]+$/)
      expect(engines).toContain(t.engine)
      expect(t.purpose.length).toBeGreaterThan(20)
      expect(t.firstAction).toMatch(/\.$/)
      for (const c of t.connections) expect(["channels", "webhooks", "schedules"]).toContain(c.section)
    }
    expect(new Set(atList().map((t) => t.key)).size).toBe(atList().length)
  })

  it("draws Blank plus one pressed chip for the picked template", () => {
    const h = atPickerHtml("reviewer", esc)
    expect(h).toContain('data-tpl="" aria-pressed="false"><b>Blank</b>')
    expect(h).toContain('class="wat__t is-on" data-st-act="agent-tpl" data-tpl="reviewer" aria-pressed="true"><b>Code reviewer</b>')
    expect(h.match(/data-st-act="agent-tpl"/g)).toHaveLength(atList().length + 1)
  })

  it("says what comes after Add agent, with links to the Settings sections", () => {
    const t = atList().find((x) => x.key === "reporter")
    const h = atNextHtml(t, esc, href)
    expect(h).toContain("<b>First thing to ask:</b> Add a schedule")
    expect(h).toContain('<a href="#page=settings&amp;st=schedules">A schedule</a>')
    expect(atNextHtml(atList().find((x) => x.key === "research"), esc, href)).toContain("nothing; it works from the Hub chat")
    expect(atNextHtml(undefined, esc, href)).toBe("")
  })

  it("sets the form's fields, and Blank clears them", () => {
    expect(atFields(atList()[0])).toMatchObject({ "st-a-id": "support", "st-a-tier": "claude-code" })
    expect(atFields(undefined)).toEqual({ "st-a-id": "", "st-a-name": "", "st-a-triggers": "", "st-a-tier": "claude-code", "st-a-personality": "" })
  })

  it("runs in the browser as injected, without module scope", () => {
    const code = injectFns({ atList, atPickerHtml })
    const fn = new Function("esc", code + "; return atPickerHtml('support', esc)")
    expect(fn(esc)).toContain('data-tpl="support" aria-pressed="true"')
  })

  it("is wired into the owner's Settings form and click handler", () => {
    const page = renderWallPage({ owner: true })
    expect(page).toContain("atPickerHtml(S.st.tpl || '', esc)")
    expect(page).toContain("else if (a === 'agent-tpl')")
    expect(page).toContain(".wat__t.is-on")
  })
})
