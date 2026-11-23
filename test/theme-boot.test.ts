import { describe, expect, it } from "vitest"
import { AX_THEME_BOOT_JS } from "../src/daemon/ui/tokens"

// Runs the one theme boot (#2101) against a fake browser.
function boot(stored: Record<string, string>, systemDark = false) {
  const store = new Map(Object.entries(stored))
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  let theme = ""
  const document = { documentElement: { setAttribute: (_: string, v: string) => { theme = v } } }
  const window = { matchMedia: () => ({ matches: systemDark }) }
  new Function("localStorage", "document", "window", "matchMedia", AX_THEME_BOOT_JS)(
    localStorage, document, window, window.matchMedia)
  return { theme, store: Object.fromEntries(store) }
}

describe("theme boot (#2101 condition 6)", () => {
  it("moves a saved Hub choice to ax-theme and drops the old key", () => {
    const r = boot({ "ax-wall-theme": "light", "ax-theme": "dark" })
    expect(r.theme).toBe("light")
    expect(r.store).toEqual({ "ax-theme": "light" })
  })

  it("drops a junk old key without touching the shared choice", () => {
    const r = boot({ "ax-wall-theme": "crt", "ax-theme": "dark" })
    expect(r.theme).toBe("dark")
    expect(r.store).toEqual({ "ax-theme": "dark" })
  })

  it("follows the computer's setting when nothing is saved", () => {
    expect(boot({}, true).theme).toBe("dark")
    expect(boot({}, false).theme).toBe("light")
    expect(boot({}, true).store).toEqual({})
  })
})
