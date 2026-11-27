// The Hub's React parts (src/hub/ui) against orca-design (Hub review S4):
// focus ring, data-slot and sizes on Button, the tooltip delay and shortcut
// chip, lucide in place of glyphs, no title= tooltips, EmptyState's hero
// icon, the motion tokens with their reduced-motion fallback, and the
// catalog showing every part.
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Dialog, EmptyState, Kbd, StatusDot, TooltipProvider,
} from "../src/hub/ui"
import { DialogCloseX } from "../src/hub/ui/dialog"

const UI = join(__dirname, "../src/hub/ui")
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8")

describe("Button (C16, C24)", () => {
  it("carries data-slot, data-variant and data-size", () => {
    const out = html(createElement(Button, { variant: "outline", size: "sm" }, "Open"))
    expect(out).toContain('data-slot="button"')
    expect(out).toContain('data-variant="outline"')
    expect(out).toContain('data-size="sm"')
    expect(html(createElement(Button, null, "Go"))).toContain('data-variant="default" data-size="default"')
  })
  it("focuses with the 3px ring at half strength, no offset", () => {
    const out = html(createElement(Button, null, "Go"))
    expect(out).toContain("focus-visible:ring-[3px]")
    expect(out).toContain("focus-visible:ring-ring/50")
    expect(out).not.toContain("ring-offset")
  })
  it("has the icon sizes 6, 8, 9 and 10", () => {
    const size = (s: "icon-xs" | "icon-sm" | "icon" | "icon-lg") => html(createElement(Button, { size: s, "aria-label": "x" }))
    expect(size("icon-xs")).toContain("size-6")
    expect(size("icon-sm")).toContain("size-8")
    expect(size("icon")).toContain("size-9")
    expect(size("icon-lg")).toContain("size-10")
  })
})

describe("tooltip, dialog and status parts (C9, C14)", () => {
  it("waits 600ms before the first tooltip unless told otherwise", () => {
    expect(TooltipProvider({ children: null }).props.delayDuration).toBe(600)
    expect(TooltipProvider({ children: null, delayDuration: 0 }).props.delayDuration).toBe(0)
  })
  it("Kbd is a chip that turns inverted inside a tooltip", () => {
    const out = html(createElement(Kbd, null, "⌘K"))
    expect(out).toContain('data-slot="kbd"')
    expect(out).toContain("in-data-[slot=tooltip-content]:bg-background/20")
  })
  it("the dialog's close is a lucide X with a name, not a glyph", () => {
    const out = html(createElement(Dialog, { open: true }, createElement(DialogCloseX)))
    expect(out).toContain("lucide-x")
    expect(out).toContain('aria-label="Close"')
    expect(out).not.toContain("✕")
  })
  it("a status dot names its state for screen readers, without title=", () => {
    const out = html(createElement(StatusDot, { state: "ok", label: "Done" }))
    expect(out).toContain('aria-label="Done"')
    expect(out).not.toContain("title=")
  })
  it("no part in src/hub/ui uses title= or a glyph for an icon", () => {
    for (const f of readdirSync(UI).filter((n) => n.endsWith(".tsx"))) {
      const src = readFileSync(join(UI, f), "utf8")
      expect(src, f).not.toMatch(/\stitle=/)
      expect(src, f).not.toMatch(/[✕✓▸●⋯×]/)
    }
  })
})

describe("EmptyState (C15)", () => {
  it("draws the size-7 hero icon and the action", () => {
    const out = html(createElement(EmptyState, { title: "No tasks", icon: "inbox", action: createElement(Button, { size: "sm", variant: "outline" }, "Ask an agent") }, "Tasks show here."))
    expect(out).toMatch(/class="[^"]*size-7[^"]*"[^<]*<svg[^>]*lucide-inbox/)
    expect(out).toContain("Ask an agent")
  })
  it("has no icon unless asked", () => {
    expect(html(createElement(EmptyState, { title: "No tasks" }))).not.toContain("<svg")
  })
})

describe("Collapsible (C22)", () => {
  it("marks its parts and hides the body when folded", () => {
    const fold = (open: boolean) => html(createElement(Collapsible, { open },
      createElement(CollapsibleTrigger, null, "Running now"), createElement(CollapsibleContent, null, "row")))
    expect(fold(true)).toContain('data-slot="collapsible"')
    expect(fold(true)).toContain('data-slot="collapsible-trigger"')
    expect(fold(true)).toContain("row")
    expect(fold(false)).not.toContain("row")
  })
})

describe("motion (C18, C20)", () => {
  const css = read("src/hub/styles.css")
  it("every animate-ax-* class a part uses is a theme token", () => {
    const used = new Set<string>()
    for (const f of readdirSync(UI).filter((n) => n.endsWith(".tsx"))) {
      for (const m of readFileSync(join(UI, f), "utf8").matchAll(/animate-(ax-[a-z-]+)/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(0)
    for (const name of used) expect(css, name).toContain(`--animate-${name}:`)
  })
  it("sheets take 300ms in and 200ms out; dialogs 200ms in", () => {
    expect(css).toMatch(/--animate-sheet-in: ax-sheet-in 300ms/)
    expect(css).toMatch(/--animate-sheet-out: ax-sheet-out 200ms/)
    expect(css).toMatch(/--animate-ax-dialog-in: ax-pop-in 200ms/)
  })
  it("under reduced motion every animated part only fades", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
    for (const slot of ["dialog-content", "sheet-content", "popover-content", "tooltip-content", "select-content", "dropdown-menu-content"]) {
      expect(reduced, slot).toContain(`[data-slot="${slot}"]`)
    }
    expect(reduced).toContain("animation: ax-fade-in 150ms")
  })
})

describe("the catalog stays the contract (P13)", () => {
  it("shows at least one export of every part in src/hub/ui", () => {
    const page = read("src/hub/pages/CatalogPage.tsx")
    const body = page.slice(page.indexOf('} from "../ui"'))
    for (const line of read("src/hub/ui/index.ts").matchAll(/export \{([^}]+)\} from "\.\/([a-z-]+)"/g)) {
      if (line[2] === "cn") continue
      const names = line[1].split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "))
      expect(names.some((n) => new RegExp(`\\b${n}\\b`).test(body)), line[2]).toBe(true)
    }
  })
})
