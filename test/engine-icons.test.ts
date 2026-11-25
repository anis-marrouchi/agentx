import { describe, expect, it } from "vitest"
import { engineIcon, engineIconKey } from "../src/daemon/ui/pages/engine-icons"
import { hubEngines } from "../src/daemon/ui/pages/hub-status"
import { injectFns } from "../src/daemon/ui/inject"
import { liveTreeHtml, liveTreeModel } from "../src/daemon/ui/pages/wall-tree"

// #2272: the engines' own logos, in their own colours, from one map.
describe("engine icons", () => {
  it("gives every engine Settings lists, and every model family, its own mark", () => {
    const want: Record<string, string> = {
      "claude-code": "claude-code", "codex-cli": "codex", opencode: "opencode", sdk: "anthropic-api", orchestrator: "other",
    }
    for (const [tier] of hubEngines()) expect(engineIconKey(tier)).toBe(want[tier])
    expect(engineIconKey("gemini-cli")).toBe("gemini-cli")
    expect(engineIconKey("codex")).toBe("codex")
    expect(engineIconKey("anthropic")).toBe("anthropic-model")
    expect(engineIconKey("openai")).toBe("openai")
    expect(engineIconKey("google")).toBe("gemini")
    expect(engineIconKey("")).toBe("other")
    expect(engineIconKey("something-new")).toBe("other")
  })

  it("draws the brand colours, and one-colour marks in the text colour", () => {
    expect(engineIcon("claude-code")).toContain('fill="#D97757"')
    expect(engineIcon("anthropic")).toContain('fill="#D97757"')
    expect(engineIcon("codex-cli")).toContain('stop-color="#3941FF"')
    expect(engineIcon("google")).toContain('fill="#3186FF"')
    expect(engineIcon("gemini-cli")).toContain('stop-color="#EE4D5D"')
    for (const k of ["openai", "sdk", "opencode", "orchestrator"]) expect(engineIcon(k)).toContain("currentColor")
  })

  it("is the same for the same input, and every gradient fill has a plain fallback", () => {
    for (const k of ["codex-cli", "gemini-cli", "google"]) {
      const svg = engineIcon(k, "x")
      expect(engineIcon(k, "x")).toBe(svg)
      const refs = svg.match(/fill="url\(#[^)]+\)[^"]*"/g) || []
      expect(refs.length).toBeGreaterThan(0)
      for (const r of refs) expect(r).toMatch(/\) (#[0-9A-Fa-f]{6}|none)"$/)
      for (const id of svg.match(/url\(#([^)]+)\)/g)!.map((u) => u.slice(5, -1))) expect(svg).toContain('id="' + id + '"')
    }
  })

  it("is hidden from a screen reader unless named, and escapes the name", () => {
    expect(engineIcon("openai")).toContain('aria-hidden="true"')
    const named = engineIcon("openai", "c", 'Open"AI<')
    expect(named).toContain('role="img" aria-label="Open&quot;AI&lt;"')
    expect(named).toContain('class="c"')
  })

  it("runs in the browser from its own source (injectFns)", () => {
    const run = new Function(injectFns({ engineIconKey, engineIcon }) + "return engineIcon('codex-cli', 'lt__prov');")
    expect(run()).toBe(engineIcon("codex-cli", "lt__prov"))
  })

  it("draws the live tree's row logos when the page passes them", () => {
    const now = Date.UTC(2026, 10, 25, 20)
    const tree = liveTreeModel([{ name: "Mac", url: "http://m", reachable: true, agents: [
      { id: "a", name: "A", model: "claude-opus-5-5", runningTasks: [{ id: "t1", messagePreview: "x" }] },
      { id: "b", name: "B", model: "gpt-5", runningTasks: [{ id: "t2", messagePreview: "y" }] },
      { id: "c", name: "C", model: "gemini-3-pro", runningTasks: [{ id: "t3", messagePreview: "z" }] },
    ] }] as never, [], now)
    const html = liveTreeHtml(tree, () => "#x", {}, undefined, (p) => engineIcon(p, "lt__prov"))
    expect(html).toContain('data-engine="anthropic-model"')
    expect(html).toContain('data-engine="openai"')
    expect(html).toContain('data-engine="gemini"')
    // Without the map, the tree draws no brand at all.
    expect(liveTreeHtml(tree, () => "#x", {})).not.toContain("data-engine")
  })
})
