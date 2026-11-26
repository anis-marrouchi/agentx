import { describe, expect, it } from "vitest"
import { hubCliHtml, hubCliSavedText, hubCliText, hubCliWaitText, hubConnState, hubEngineName, hubUsageText, HUB_STATUS_CSS, HUB_STATUS_HTML } from "../src/daemon/ui/pages/hub-status"
import { renderWallPage } from "../src/daemon/ui/pages/wall"

describe("Hub bottom status", () => {
  const now = Date.UTC(2026, 10, 24, 14)

  it("shows only reported plan windows and their remaining reset time", () => {
    expect(hubUsageText([
      { window: "five_hour", utilization: 0.756, resetsAt: now + 31 * 60_000 },
      { window: "seven_day", utilization: 0.34, resetsAt: now + 7 * 60_000 },
    ], now)).toBe("5h 76% · resets in 31m · 7d 34% · resets in 7m")
  })

  it("leaves out a missing reading instead of saying not known (Anis 11-25)", () => {
    expect(hubUsageText([], now)).toBe("")
    expect(hubUsageText([{ window: "five_hour", utilization: 1.5 }], now)).toBe("5h 100%")
  })

  it("shows the percentage and time left when the reset is in the future", () => {
    expect(hubUsageText([
      { window: "five_hour", utilization: 0.92, resetsAt: now + 2 * 60 * 60_000 },
      { window: "seven_day", utilization: 0.1, resetsAt: now + 3 * 24 * 60 * 60_000 },
    ], now)).toBe("5h 92% · resets in 2h · 7d 10% · resets in 3d")
  })

  it("does not show an old percentage once its window has reset", () => {
    expect(hubUsageText([
      { window: "five_hour", utilization: 0.92, resetsAt: now - 60_000 },
      { window: "seven_day", utilization: 0.4, resetsAt: now },
    ], now)).toBe("")
  })

  it("shows the percentage only when no reset time is reported", () => {
    expect(hubUsageText([
      { window: "five_hour", utilization: 0.5 },
      { window: "seven_day", utilization: 0.25 },
    ], now)).toBe("5h 50% · 7d 25%")
  })

  it("shows only the window that has a reading", () => {
    expect(hubUsageText([{ window: "seven_day", utilization: 0.3 }], now)).toBe("7d 30%")
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
    expect(nav).not.toContain("data-wall-theme")
    expect(html).toContain('id="hs-cli-pop"')
  })

  it("keeps the bar on one line down to the 900 px icon nav (#2101)", () => {
    const narrow = HUB_STATUS_CSS.slice(HUB_STATUS_CSS.indexOf("@media (max-width: 1180px)"))
    expect(narrow).toContain(".hs__btn[data-wall-theme] > span { display: none; }")
    expect(HUB_STATUS_CSS).not.toContain(".hs__usage:not(.hs__i)")
    // Accounts is its one word there, never cut mid-word (#2101 C2).
    expect(narrow).toContain(".hs__acct-s { display: none; }")
    expect(HUB_STATUS_CSS).toContain(".hs > .hs__usage.hs__i { flex: 0 1 auto; min-width: 60px;")
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
    expect(HUB_STATUS_HTML).toContain('id="hs-running-i" hidden')
    expect(HUB_STATUS_HTML).toMatch(/id="hs-node"[^>]* hidden>/)
    expect(HUB_STATUS_CSS).toContain(".hs [hidden] { display: none !important; }")
    const html = renderWallPage({ owner: true })
    expect(html).toContain('id="hub-status"')
    expect(html).toContain('id="wall-more"')
  })
})
