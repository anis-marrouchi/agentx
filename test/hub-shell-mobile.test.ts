// The Mobile app page in the React simple shell (#2457): the old Hub's
// #page=mobile words drawn in the shell's centre, and the menu wiring
// (Mobile app opens in the shell, not the old Hub page).
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SHELL_MORE } from "../src/hub/shell"
import { parseHash } from "../src/hub/router"
import { shellPane } from "../src/hub/tasks"
import { MOBILE_GUIDE, MOBILE_PAIR, MOBILE_SERVE, MOBILE_WHY, MobilePane } from "../src/hub/pages/ShellMobile"
import { PHONE_SCREEN_MS, PHONE_SCREENS } from "../src/hub/pages/PhonePreview"
import { hubMobilePageHtml } from "../src/daemon/ui/pages/hub-nav"

const html = renderToStaticMarkup(createElement(MobilePane, {}))
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&")

describe("the Mobile app pane", () => {
  it("draws the why, the five steps, the note and the guide link", () => {
    expect(html).toContain('data-shell="mobile"')
    expect(html).toContain("Your agents, in your pocket")
    for (const w of MOBILE_WHY) expect(decode(html)).toContain(w.title)
    expect(html.match(/<li class="flex gap-3">/g)).toHaveLength(5)
    expect(html).toContain("The pairing code works once, for 10 minutes.")
    expect(html).toContain(`href="${MOBILE_GUIDE}"`)
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it("shows both commands, each with a Copy button", () => {
    expect(decode(html)).toContain(MOBILE_SERVE)
    expect(decode(html)).toContain(MOBILE_PAIR)
    expect(html.match(/aria-label="Copy the command"/g)).toHaveLength(2)
  })

  it("shows the phone preview (#2459): the first screen, the others hidden, a slow tilt that stops with reduced motion", () => {
    expect(html).toContain('data-mobile="phone"')
    expect(html.match(/<img /g)).toHaveLength(PHONE_SCREENS.length)
    expect(decode(html)).toContain(`alt="${PHONE_SCREENS[0].alt}"`)
    expect(html.match(/aria-hidden="true" loading=/g)).toHaveLength(PHONE_SCREENS.length - 1)
    expect(html).toContain("animate-ax-phone-tilt reduce-effects:animate-none")
    expect(PHONE_SCREEN_MS).toBeGreaterThanOrEqual(3000)
    // The phone sits after the why and before the steps (narrow window order).
    expect(html.indexOf('data-mobile="why"')).toBeLessThan(html.indexOf('data-mobile="phone"'))
    expect(html.indexOf('data-mobile="phone"')).toBeLessThan(html.indexOf('data-mobile="install"'))
  })

  it("keeps the old page's commands and guide", () => {
    const old = hubMobilePageHtml()
    for (const line of MOBILE_SERVE.split("\n")) expect(old).toContain(line)
    expect(old).toContain(MOBILE_PAIR)
    expect(old).toContain(MOBILE_GUIDE)
  })
})

describe("the menu", () => {
  it("opens Mobile app in the shell's centre", () => {
    const href = SHELL_MORE.mobile?.href ?? ""
    expect(href).toBe("#page=home&pane=mobile")
    expect(shellPane(parseHash(href)).pane).toBe("mobile")
  })
})
