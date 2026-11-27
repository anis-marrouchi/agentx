import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { avatar, axIcon, btn, emptyState, errorLine, rowMenu, skeleton, tabs, tip } from "../src/daemon/ui/components"
import { AX_COMPONENTS_CSS } from "../src/daemon/ui/components.css"
import { AX_COMPONENTS_SCRIPT } from "../src/daemon/ui/components.client"
import { renderShell } from "../src/daemon/ui/shell"

// Hub review S3 (orca-design): the shared old-HTML primitives pages call
// instead of hand-writing their own.

const lucidePaths = (name: string): string[] => {
  const file = createRequire(import.meta.url).resolve(`lucide-static/dist/esm/icons/${name}.js`)
  return [...readFileSync(file, "utf8").matchAll(/<(path|circle)[^>]*?\s*\/>/g)].map((m) => m[0].replace(/\s*\/>$/, "/>"))
}

describe("button sizes and tooltips (C14, C24)", () => {
  it("adds size variants as classes with data-slot and data-size", () => {
    expect(btn("Save", { size: "sm" })).toBe('<button type="button" class="ax-btn ax-btn--sm" data-slot="button" data-size="sm">Save</button>')
    expect(btn("Save")).toBe('<button type="button" class="ax-btn" data-slot="button">Save</button>')
    for (const n of [9, 8, 7, 6]) expect(AX_COMPONENTS_CSS).toContain(`.ax-btn--icon-${n} { width: ${n * 4}px; height: ${n * 4}px; padding: 0; }`)
    expect(AX_COMPONENTS_CSS).toContain(".ax-btn--sm { height: 32px;")
    expect(AX_COMPONENTS_CSS).toContain(".ax-btn--xs { height: 24px;")
  })
  it("an icon button keeps its name as an sr-only label and shows it as a tooltip", () => {
    const h = btn("Copy <id>", { ghost: true, size: "icon-7", icon: "<svg></svg>", shortcut: "C" })
    expect(h).toContain('data-tip="Copy &lt;id&gt;" data-tip-key="C"')
    expect(h).toContain('<svg></svg><span class="ax-sr">Copy &lt;id&gt;</span></button>')
    expect(tip("Search")).toBe('data-tip="Search"')
  })
})

describe("empty and error states carry their action (C15)", () => {
  it("emptyState draws the action it is given", () => {
    const h = emptyState({ title: "No agents yet", actionHtml: btn("Add agent", { size: "sm" }) })
    expect(h).toContain('data-slot="empty"')
    expect(h).toContain(">Add agent</button>")
    // @ts-expect-error the action is required
    emptyState({ title: "No agents yet" })
  })
  it("errorLine says what failed and offers a ghost sm Retry with RefreshCw", () => {
    const h = errorLine("Could not read the jobs: <timeout>.", 'data-act="reload"')
    expect(h).toContain('role="alert"')
    expect(h).toContain("<span>Could not read the jobs: &lt;timeout&gt;.</span>")
    expect(h).toContain('class="ax-btn ax-btn--ghost ax-btn--sm"')
    expect(h).toContain('data-act="reload"')
    expect(h).toContain("lucide-refresh-cw")
    expect(h).toMatch(/<\/svg>Retry<\/button><\/div>$/)
  })
})

describe("skeleton (P8)", () => {
  it("draws rows or cards shaped like content, busy for screen readers", () => {
    const rows = skeleton("rows")
    expect(rows).toContain('role="status" aria-busy="true"><span class="ax-sr">Loading</span>')
    expect(rows.match(/ax-skel__row/g)).toHaveLength(3)
    expect(skeleton("cards", 2).match(/class="ax-skel__card"/g)).toHaveLength(2)
  })
  it("shows only after 400ms", () => {
    expect(AX_COMPONENTS_CSS).toContain(".ax-skel { display: grid; gap: 8px; animation: ax-fade-flat 150ms ease-out 400ms both; }")
  })
})

describe("row ... menu (C12)", () => {
  const h = rowMenu("More for Scout", [
    { label: "Delete", attrs: 'data-act="del"', danger: true },
    { label: "Rename", attrs: 'data-act="ren"' },
  ])
  it("is a ghost size-7 Ellipsis trigger with a tooltip and a hidden menu", () => {
    expect(h).toContain('class="ax-btn ax-btn--ghost ax-btn--icon-7"')
    expect(h).toContain('aria-haspopup="menu" aria-expanded="false"')
    expect(h).toContain('data-tip="More for Scout"')
    expect(h).toContain('width="14" height="14"')
    expect(h).toContain("lucide-ellipsis")
    expect(h).toContain('role="menu" aria-label="More for Scout" hidden>')
  })
  it("puts destructive items last, after a separator", () => {
    expect(h.indexOf(">Rename<")).toBeLessThan(h.indexOf('role="separator"'))
    expect(h.indexOf('role="separator"')).toBeLessThan(h.indexOf(">Delete<"))
    expect(h).toContain('class="ax-menu__item ax-menu__item--danger" data-act="del">Delete</button>')
    expect(rowMenu("More", [{ label: "Rename" }])).not.toContain("separator")
  })
  it("opens 11rem wide with the floating shadow, scaling from .98 over 150ms", () => {
    expect(AX_COMPONENTS_CSS).toMatch(/\.ax-menu__content \{[^}]*min-width: 11rem;[^}]*box-shadow: var\(--ax-shadow-lg\);[^}]*animation: ax-menu-in 150ms/)
    expect(AX_COMPONENTS_CSS).toContain("@keyframes ax-menu-in { from { opacity: 0; transform: scale(0.98); } }")
  })
})

describe("tabs (C16)", () => {
  it("marks one tab selected and in the Tab order", () => {
    const h = tabs("Jobs by state", [
      { value: "open", label: "Open", count: 4, controls: "p-open" },
      { value: "done", label: "Done", selected: true },
    ])
    expect(h).toContain('role="tablist" aria-label="Jobs by state"')
    expect(h).toContain('data-value="open" aria-selected="false" tabindex="-1" aria-controls="p-open">Open<span class="ax-tabs__n">4</span>')
    expect(h).toContain('data-value="done" aria-selected="true" tabindex="0">Done</button>')
    expect(tabs("x", [{ value: "a", label: "A" }])).toContain('aria-selected="true" tabindex="0"')
  })
})

describe("avatar (C6)", () => {
  it("is a muted square with initials, beside the name", () => {
    expect(avatar("Ada Lovelace")).toBe('<span class="ax-avatar" data-slot="avatar" aria-hidden="true">AL</span>')
    expect(avatar("coder")).toContain(">C</span>")
    expect(AX_COMPONENTS_CSS).toMatch(/\.ax-avatar \{\s*width: 28px; height: 28px; border-radius: var\(--ax-radius-md\);[^}]*background: var\(--ax-surface-3\);/)
  })
})

describe("icons are lucide-static's", () => {
  it.each([["refresh-cw"], ["ellipsis"]] as const)("%s", (name) => {
    const svg = axIcon(name, 14)
    for (const p of lucidePaths(name)) expect(svg).toContain(p)
    expect(svg).toContain('aria-hidden="true"')
  })
})

describe("behaviour script and motion", () => {
  const body = AX_COMPONENTS_SCRIPT.replace(/^<script>|<\/script>$/g, "")
  it("parses, and is on every shell page", () => {
    expect(() => new Function(body)).not.toThrow()
    expect(renderShell({ title: "t", activeTab: "custom", body: "" } as Parameters<typeof renderShell>[0])).toContain(AX_COMPONENTS_SCRIPT)
  })
  it("waits 600ms for a tooltip, places it on top, and wires keys", () => {
    expect(body).toContain("setTimeout(function () { tipShow(el); }, 600)")
    expect(body).toContain("var top = b.top - h - 4, side = 'top'")
    expect(body).toContain("ev.key === 'ArrowRight'")
    expect(body).toContain("t.setAttribute('aria-selected', String(on))")
    expect(body).toContain("ev.key === 'Escape') { ev.preventDefault(); menuClose(true); }")
  })
  it("confirm: ghost Cancel first, destructive action, a Promise, Esc via the native dialog", () => {
    expect(body).toContain("window.axConfirm = function (o) {\n    return new Promise(")
    expect(body).toContain('class="ax-btn ax-btn--ghost" data-slot="button">Cancel</button>')
    expect(body).toContain('class="ax-btn ax-btn--danger"')
    expect(body).toContain("d.showModal()")
  })
  it("drops movement under reduced motion", () => {
    expect(AX_COMPONENTS_CSS).toContain("@media (prefers-reduced-motion: reduce) {\n  .ax-tip, .ax-menu__content, .ax-dialog[open] { animation-name: ax-fade-flat; }\n}")
  })
})
