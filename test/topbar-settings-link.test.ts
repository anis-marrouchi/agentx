// The Settings links open the new React Settings, not the old page (#2101).
import { describe, expect, it } from "vitest"
import { renderTopbar } from "../src/daemon/topbar"
import { HUB_PATH } from "../src/daemon/ui/hub-name"
import { SHELL_SETTINGS } from "../src/hub/shell"
import { SETTINGS_PAGE, settingsHash } from "../src/hub/settings/address"

describe("Settings links (#2101)", () => {
  it("side menu Settings opens the React Settings page", () => {
    expect(SHELL_SETTINGS.href).toBe(settingsHash())
    expect(SHELL_SETTINGS.href).toBe(`#page=${SETTINGS_PAGE}`)
  })

  it("topbar Settings opens the same page as the side menu", () => {
    const bar = renderTopbar({ activeTab: "admin", subtitle: "t" })
    expect(bar).toContain(`href="${HUB_PATH}#page=${SETTINGS_PAGE}"`)
    expect(bar).not.toContain(`href="${HUB_PATH}#page=settings"`)
  })
})
