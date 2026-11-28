import { chromium } from "/Users/macbookpro/Developer/dev-session-workspace/state/shots-2352-tools/node_modules/playwright-core/index.mjs"
const b = await chromium.launch({ executablePath: process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell" })
for (const f of ["mesh-error", "machine-pending", "machine-error"]) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
  await p.goto(`file:///tmp/ds-st3b-fix/${f}.html`); await p.waitForTimeout(300)
  await p.screenshot({ path: `/tmp/ds-st3b-fix/out/${f}.png`, fullPage: true }); await p.close()
}
await b.close()
