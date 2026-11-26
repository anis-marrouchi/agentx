import { describe, expect, it } from "vitest"
import { ICON_NAMES, ICONS_CSS, STATES, icon, stateIcon, type IconName, type State } from "../src/daemon/ui/icons"
import { injectFns } from "../src/daemon/ui/inject"
import { hubIcon } from "../src/daemon/ui/pages/hub-lucide"
import { tcCtlHtml } from "../src/daemon/ui/pages/wall-task-ctl"
import { filesTabHtml, wflIcon } from "../src/daemon/ui/pages/wall-files"

describe("icon (lucide for the old-HTML pages)", () => {
  it("returns one inline svg: currentColor stroke, hidden from screen readers, 16 px by default", () => {
    const svg = icon("circle-check")
    expect(svg).toMatch(/^<svg [^>]*>.+<\/svg>$/)
    expect(svg).toContain('stroke="currentColor"')
    expect(svg).toContain('fill="none"')
    expect(svg).toContain('aria-hidden="true"')
    expect(svg).toContain('width="16" height="16"')
    expect(svg).toContain('viewBox="0 0 24 24"')
    // The path is lucide's, on one line: the same drawing as the side menu (hub-lucide.ts).
    expect(svg).toContain('d="m9 12 2 2 4-4"')
    expect(svg).not.toContain("\n")
    expect(svg).toBe(hubIcon("circle-check"))
    expect(svg.match(/<svg/g)!.length).toBe(1)
  })

  it("draws 14 px in dense rows and takes a class", () => {
    expect(icon("x", 14)).toContain('width="14" height="14"')
    expect(icon("x", 14, "wfl__ic")).toMatch(/class="lucide lucide-x wfl__ic"/)
  })

  it("has a fixed list of names, each with a drawing", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(20)
    for (const n of ICON_NAMES) expect(icon(n)).toMatch(/<svg [^>]*>\s*<(path|circle|rect|line|polyline|polygon)/)
    // @ts-expect-error: a name not in the list does not type-check.
    const bad: IconName = "not-an-icon"
    expect(ICON_NAMES).not.toContain(bad)
  })
})

describe("stateIcon (recipes.md §9)", () => {
  const all: State[] = ["waiting-on-you", "failed", "running", "live", "waiting", "not-started", "paused", "cancelled", "done", "idle"]

  it("covers every state with a known icon, a word and an order", () => {
    expect(Object.keys(STATES).sort()).toEqual([...all].sort())
    for (const s of all) {
      expect(ICON_NAMES).toContain(STATES[s].icon)
      expect(STATES[s].word).toMatch(/^[A-Z][a-z ]+$/)
      expect(stateIcon(s)).toBe(icon(STATES[s].icon, 16, s === "running" ? "ax-ic ax-ic-spin" : "ax-ic"))
    }
  })

  it("uses the §9 icons and order: what needs you first", () => {
    const icons = Object.fromEntries(all.map((s) => [s, STATES[s].icon]))
    expect(icons).toEqual({
      "waiting-on-you": "circle-alert", "failed": "circle-x", "running": "loader-circle", "live": "radio", "waiting": "clock",
      "not-started": "circle-dashed", "paused": "pause", "cancelled": "ban", "done": "circle-check", "idle": "circle",
    })
    const byOrder = [...all].sort((a, b) => STATES[a].order - STATES[b].order)
    expect(byOrder[0]).toBe("waiting-on-you")
    expect(byOrder[1]).toBe("failed")
    expect(byOrder[byOrder.length - 1]).toBe("idle")
    expect(STATES.running.word).toBe("Working")
  })

  it("turns only the running icon, and holds it still under reduced motion", () => {
    expect(stateIcon("running")).toContain("ax-ic-spin")
    expect(all.filter((s) => stateIcon(s).includes("ax-ic-spin"))).toEqual(["running"])
    expect(ICONS_CSS).toMatch(/prefers-reduced-motion: reduce\) \{ \.ax-ic-spin \{ animation: none/)
  })
})

describe("functions shipped with injectFns carry their icons", () => {
  it("tcCtlHtml draws the same lucide icons on the page as on the server", () => {
    const run = new Function(injectFns({ tcCtlHtml }) + "return tcCtlHtml(arguments[0])")
    const html = run({ running: true })
    expect(html).toBe(tcCtlHtml({ running: true }))
    expect(html).toContain(icon("pause"))
    expect(html).toContain(icon("square"))
    expect(run({ running: false, paused: { state: "stopped", resumable: true } })).toContain(icon("play"))
  })

  it("wflIcon and filesTabHtml work once stringified, and no string closes the script", () => {
    const code = injectFns({ wflIcon, filesTabHtml })
    const data = code.match(/Object\.assign\(wflIcon,(.*?)\);const filesTabHtml/)![1]
    expect(data).not.toContain("<")
    const run = new Function(code + "return [wflIcon('read'), filesTabHtml(arguments[0], { key: 'k' })]")
    const r = { files: [{ path: "a/b.ts", op: "edited", n: 1, changes: [] }], artifacts: [], attached: [] }
    const [read, tab] = run(r)
    expect(read).toBe(icon("eye", 14, "wfl__ic"))
    expect(tab).toBe(filesTabHtml(r as never, { key: "k" }))
    expect(tab).toContain(icon("pencil-line", 14, "wfl__ic"))
  })

  it("adds nothing for a function without data", () => {
    function plain() { return 1 }
    expect(injectFns({ plain })).not.toContain("Object.assign")
  })
})
