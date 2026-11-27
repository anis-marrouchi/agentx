import { describe, expect, it } from "vitest"
import { hubCliHtml, hubCliSavedText, hubCliText, hubCliWaitText, hubConnState, hubEngineName, HUB_STATUS_CSS, HUB_STATUS_HTML } from "../src/daemon/ui/pages/hub-status"
import { HUB_STATUS_SCRIPT } from "../src/daemon/ui/pages/hub-status.client"
import { renderWallPage } from "../src/daemon/ui/pages/wall"

describe("Hub bottom status", () => {

  it("follows orca-design in the bar (Hub review batch 6)", () => {
    // P1: healthy says nothing; only a problem gets the (token) dot.
    expect(HUB_STATUS_CSS).toContain('.hs__conn[data-state="ok"] { display: none; }')
    expect(HUB_STATUS_CSS).toContain('.hs__conn[data-state="err"] .hs__dot, .hs__conn[data-state="off"] .hs__dot { display: block; }')
    // C10: no raw colours, tokens only.
    expect(HUB_STATUS_CSS.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    // C14: tooltips, not title; the theme button keeps its spoken name.
    expect(HUB_STATUS_HTML).not.toContain("title=")
    expect(HUB_STATUS_HTML).toContain('data-tip="Light / dark" aria-label="Switch light or dark"')
    // C21: Reset layout sits in the bar.
    expect(HUB_STATUS_HTML).toContain("data-panel-reset")
    // C16: Esc closes the Accounts popover too and gives the focus back.
    expect(HUB_STATUS_SCRIPT).toContain("if (pop && !pop.hidden) { pop.hidden = true; $('hs-acct').setAttribute('aria-expanded', 'false'); $('hs-acct').focus(); }")
    expect(HUB_STATUS_SCRIPT).not.toContain(".title =")
  })

  it("names the connection from the last live read (#2101 R25)", () => {
    expect(hubConnState({ live: true, error: false, online: true })).toEqual({ state: "ok", text: "Connected" })
    expect(hubConnState({ live: true, error: true, online: true })).toEqual({ state: "err", text: "Reconnecting…" })
    expect(hubConnState({ live: false, error: false, online: true })).toEqual({ state: "wait", text: "Connecting…" })
    expect(hubConnState({ live: true, error: false, online: false }).text).toBe("Offline")
  })

  it("the CLI drop-down: the agent in view, one choice per engine, and the restart it needs (#2101 R25)", () => {
    const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
    const list = [{ id: "coder", name: "Coder", tier: "claude-code", node: "Mac" }, { id: "ops", name: "Ops", tier: "codex-cli", node: "clawd" }]
    expect(hubCliText(list[1])).toBe("Codex CLI · Ops")
    expect(hubCliText(null)).toBe("CLI · pick an agent")
    expect(hubEngineName("")).toBe("Claude Code")
    expect(hubEngineName("future-cli")).toBe("future-cli")
    const none = hubCliHtml(list, "", { kind: "", text: "" }, esc)
    expect(none).toContain('<option value="">Pick an agent</option>')
    expect(none).not.toContain("data-hsc-save")
    const html = hubCliHtml(list, "ops", { kind: "ok", text: "Saved." }, esc)
    expect(html).toContain('<option value="ops" selected>Ops · clawd</option>')
    expect(html).toContain('value="codex-cli" checked')
    expect(html).toContain('value="claude-code">')
    expect(html).toContain("data-hsc-save")
    // No restart: the next run takes the new engine (#2101 B1).
    expect(html).not.toContain("restart")
    expect(html).toContain("next run uses")
    expect(html).toContain('class="hsa__note is-ok" role="status">Saved.')
    // Each engine choice carries its own logo when the page passes the map (#2272).
    const logos = hubCliHtml(list, "ops", { kind: "", text: "" }, esc, (k) => '<i data-e="' + k + '"></i>')
    expect(logos).toContain('value="codex-cli" checked><i data-e="codex-cli"></i><span>Codex CLI</span>')
    expect(html).not.toContain("data-e=")
  })

  it("a busy agent: the Switch note says when it lands and the drop-down shows it waiting (#2101 B2)", () => {
    const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
    const idle = { id: "cx", name: "CX", tier: "claude-code", running: 0 }
    expect(hubCliSavedText(idle, "codex-cli")).toBe("Saved. CX's next run uses Codex CLI.")
    const busy = { id: "cx", name: "CX", tier: "claude-code", running: 2 }
    expect(hubCliSavedText(busy, "codex-cli")).toBe("Saved. CX switches to Codex CLI when its 2 running jobs end. New runs wait and start on Codex CLI.")
    expect(hubCliSavedText({ ...busy, running: 1 }, "codex-cli")).toContain("when its 1 running job ends")
    const waiting = { ...busy, pendingTier: "codex-cli" }
    expect(hubCliWaitText(busy)).toBe("")
    expect(hubCliWaitText(waiting)).toBe("Waiting to switch: Claude Code → Codex CLI when its 2 running jobs end. Pick Claude Code again to cancel the wait.")
    expect(hubCliText(waiting)).toBe("Claude Code → Codex CLI (waiting) · CX")
    const html = hubCliHtml([waiting], "cx", { kind: "", text: "" }, esc)
    expect(html).toContain("data-hsc-wait")
    expect(html).toContain('value="codex-cli" checked')
    expect(hubCliHtml([busy], "cx", { kind: "", text: "" }, esc)).not.toContain("data-hsc-wait")
  })

  it("has icons, the light/dark switch and the CLI drop-down; the side menu has no theme button (#2101 R23, R25)", () => {
    const html = renderWallPage({ owner: true })
    const bar = html.slice(html.indexOf('id="hub-status"'), html.indexOf("</footer>"))
    expect(bar).toContain("data-wall-theme")
    expect(bar).toContain('id="hs-cli"')
    expect(bar).toContain('id="hs-conn"')
    expect((bar.match(/<svg /g) || []).length).toBeGreaterThanOrEqual(6)
    const nav = html.slice(html.indexOf('class="ax-wall__nav"'), html.indexOf("</nav>"))
    // On a computer only the bar has it: the menu's Light / dark is for the phone, which hides the bar.
    expect(nav.match(/data-wall-theme/g)).toHaveLength(1)
    expect(nav).toContain('class="hf__item hf__theme" data-wall-theme>')
    expect(html).toContain('id="hs-cli-pop"')
  })

  it("keeps the bar on one line down to the 900 px icon nav (#2101)", () => {
    const narrow = HUB_STATUS_CSS.slice(HUB_STATUS_CSS.indexOf("@media (max-width: 1180px)"))
    expect(narrow).toContain(".hs__btn[data-wall-theme] > span { display: none; }")
    expect(HUB_STATUS_CSS).not.toContain(".hs__usage:not(.hs__i)")
    // Accounts is its one word there, never cut mid-word (#2101 C2).
    expect(narrow).toContain(".hs__acct-s { display: none; }")
    // The plan usage moved to per-engine items (hub-status-usage.ts, #2101 R28).
    expect(HUB_STATUS_CSS).not.toContain("hs__usage")
  })

  it("adds the status strip without replacing the phone navigation", () => {
    // No "not known" and no "Version —" placeholder (Anis 11-25, #2278 C2):
    // the version item stays hidden until the build reading fills it.
    expect(HUB_STATUS_HTML).not.toContain("not known")
    expect(HUB_STATUS_HTML).not.toContain("Version —")
    expect(HUB_STATUS_HTML).toContain('id="hs-version-i" hidden')
    // Machine and Running agents too: hidden until a reading fills them.
    expect(HUB_STATUS_HTML).not.toContain("Machine —")
    expect(HUB_STATUS_HTML).not.toContain("Running agents —")
    expect(HUB_STATUS_HTML).toMatch(/id="hs-running-i"[^>]* hidden>/)
    expect(HUB_STATUS_HTML).toMatch(/id="hs-node"[^>]* hidden>/)
    expect(HUB_STATUS_CSS).toContain(".hs [hidden] { display: none !important; }")
    const html = renderWallPage({ owner: true })
    expect(html).toContain('id="hub-status"')
    expect(html).toContain('id="wall-menu-btn"')
  })
})
