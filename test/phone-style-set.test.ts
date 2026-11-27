// Hub review batch 25: one phone style set (S7) and the phone shell's
// icons and states (orca-design C9, C10, C15, C16, C25).
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderAppLockedPage, renderAppPage, renderAppPairPage } from "../src/daemon/ui/pages/app"
import { renderMemberLockedPage, renderMemberSignInPage } from "../src/daemon/ui/pages/member"
import { PAIR_CSS, PHONE_BASE_CSS } from "../src/daemon/ui/pages/phone-base.css"

const PAGES = join(__dirname, "../src/daemon/ui/pages")

describe("one phone style set (S7)", () => {
  it("the phone app and the member pages share one base and one pairing form", () => {
    for (const html of [renderAppPage(), renderAppLockedPage(), renderAppPairPage(), renderMemberLockedPage(), renderMemberSignInPage(true)]) {
      expect(html).toContain(PHONE_BASE_CSS)
    }
    for (const html of [renderAppLockedPage(), renderAppPairPage(), renderMemberLockedPage(), renderMemberSignInPage(true)]) {
      expect(html).toContain(PAIR_CSS)
      expect(html.split(".pair-form {").length - 1).toBe(1)
    }
    for (const f of ["app-locked.client.ts", "member-styles.ts"]) {
      expect(readFileSync(join(PAGES, f), "utf8")).not.toContain("LOCKED_CSS")
    }
  })

  it("the pairing button uses the primary pair and the radius, and keeps the focus ring", () => {
    expect(PAIR_CSS).toContain(".pair-form button[type=submit] { color: var(--ax-primary-fg); background: var(--ax-primary); }")
    expect(PAIR_CSS).toMatch(/\.pair-form button \{[^}]*border-radius: var\(--ax-radius\);/)
    expect(PAIR_CSS).not.toMatch(/#fff|outline: none|--ax-radius-pill/)
  })

  it("the phone shell draws lucide icons, not glyphs or hand-drawn paths", () => {
    const html = renderAppPage()
    for (const name of ["bot", "message-square", "inbox", "bell", "ellipsis", "monitor", "activity", "chevron-left", "moon", "sun"]) {
      expect(html).toContain(`lucide-${name}`)
    }
    expect(html).not.toContain("‹ More")
    expect(html).not.toContain("content: '●'")
  })

  it("the offline strip and the sheet scrim use tokens, and a tab press stays small", () => {
    const css = readFileSync(join(PAGES, "app-redesign.css.ts"), "utf8")
    expect(css).not.toContain("#ffc94d")
    expect(css).not.toMatch(/::backdrop \{ background: rgb\(/)
    expect(css).toContain("::backdrop { background: var(--ax-overlay); }")
    expect(css).toContain("scale(.97)")
  })
})

describe("pair link (/app/pair)", () => {
  it("a failed pairing offers Try again, which re-sends the same key", () => {
    const html = renderAppPairPage()
    expect(html).toMatch(/<form id="retry" class="pair-form" hidden><button type="submit">Try again<\/button><\/form>/)
    expect(html).toContain("retry.hidden = false;")
    expect(html).toContain("'Bearer ' + key")
  })
})
