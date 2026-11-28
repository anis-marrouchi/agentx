// #2593: in the simple layout the old Hub draws an empty slot for the React
// side menu (src/hub/shell/HubMenuFrame.tsx) and hides its own menu's rows
// from the first paint, so no page shows two menus or the old one.
import { describe, expect, it, vi } from "vitest"

// The React bundle is not built in the tests: stand in for its head tags.
vi.mock("../src/daemon/ui/hub-react", async (orig) => ({
  ...(await orig<typeof import("../src/daemon/ui/hub-react")>()),
  hubReactHead: () => '<script type="module" src="/hub-assets/main.js"></script>',
}))

const { renderWallPage } = await import("../src/daemon/ui/pages/wall")
const { resolveHubLayout } = await import("../src/hub/layout")
const { MENU_SLOT } = await import("../src/hub/shell/menu-frame")

const page = (layout: "simple" | "full", extra: { owner?: boolean; legacyPages?: string[] } = {}) =>
  renderWallPage({ owner: extra.owner ?? true, hub: { react: true, layout: resolveHubLayout({ layout }), legacyPages: extra.legacyPages } })

describe("the old Hub's slot for the one side menu (#2593)", () => {
  it("simple layout: the slot is the first thing in #wall-nav and the old rows step aside", () => {
    const html = page("simple")
    expect(html).toContain('<div class="ax-wall is-react-menu">')
    expect(html).toMatch(new RegExp(`<nav class="ax-wall__nav" id="wall-nav" aria-label="[^"]*">\\s*<div id="${MENU_SLOT}"></div>`))
  })
  it("full layout, a viewer without the shell, or the shell sent back: the old menu as before", () => {
    for (const html of [page("full"), page("simple", { owner: false }), page("simple", { legacyPages: ["home"] })]) {
      expect(html).not.toContain("is-react-menu")
      expect(html).not.toContain(MENU_SLOT)
    }
  })
})
