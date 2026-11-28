// Settings leaves the old Hub's 30 px status bar in view on a computer, the
// same as the React shell (#2101 R5): before this, Settings' fixed inset-0
// z-30 root covered #hub-status (z 9), so the usage bars were never seen.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { HUB_STATUS_CSS } from "../src/daemon/ui/pages/hub-status"

const page = readFileSync(new URL("../src/hub/settings/SettingsPage.tsx", import.meta.url), "utf8")
const root = page.match(/<div data-slot="settings"[^>]*>/)?.[0] ?? ""

describe("Settings and the bottom status bar (#2101 R5)", () => {
  it("ends 30 px above the bottom where the bar shows (above 640 px), full height on a phone", () => {
    expect(root).not.toBe("")
    expect(root).not.toContain("inset-0")
    expect(root).toContain("bottom-0")
    expect(root).toContain("min-[641px]:bottom-[30px]")
    // The bar is hidden at 640 px and below, so the gap starts at 641 px.
    expect(HUB_STATUS_CSS).toContain("@media (max-width: 640px) { .hs, .hsa { display: none; } }")
  })
  it("opens the bar's drop-downs over Settings", () => {
    expect(HUB_STATUS_CSS).toContain('body:has([data-slot="settings"]) .hsa, body:has([data-slot="settings"]) .hsu-pop { z-index: 40; }')
  })
})
