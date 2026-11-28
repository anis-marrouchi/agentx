import { chromium } from "/Users/macbookpro/Developer/dev-session-workspace/state/shots-2352-tools/node_modules/playwright-core/index.mjs"
const b = await chromium.launch({ executablePath: process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell" })
for (const f of ["before", "after"]) for (const [n, w, hgt] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
  const p = await b.newPage({ viewport: { width: w, height: hgt }, deviceScaleFactor: n === "phone" ? 2 : 1 })
  await p.goto(`file:///tmp/ds-latest-when/${f}.html`); await p.waitForTimeout(300)
  await p.screenshot({ path: `/tmp/ds-latest-when/out/${f}-${n}.png` }); await p.close()
}
await b.close()
