import { chromium } from "/Users/macbookpro/Developer/dev-session-workspace/state/shots-2352-tools/node_modules/playwright-core/index.mjs"
const b = await chromium.launch({ executablePath: process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell" })
for (const f of ["before", "after"]) for (const [v, h] of [["feed", "#status=open"], ["list", "#status=open&view=list"]]) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
  await p.goto(`file:///tmp/ds-first-paint-tools/${f}-frame0.html${h}`); await p.waitForTimeout(300)
  await p.screenshot({ path: `/tmp/ds-first-paint-tools/out/${f}-${v}-first-frame.png` })
  await p.goto(`file:///tmp/ds-first-paint-tools/${f}.html${h}`); await p.waitForTimeout(1500)
  await p.screenshot({ path: `/tmp/ds-first-paint-tools/out/${f}-${v}-settled.png` })
  await p.close()
}
await b.close()
