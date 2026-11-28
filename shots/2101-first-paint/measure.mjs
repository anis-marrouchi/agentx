import { chromium } from "/Users/macbookpro/Developer/dev-session-workspace/state/shots-2352-tools/node_modules/playwright-core/index.mjs"
const [file, label] = process.argv.slice(2)
const b = await chromium.launch({ executablePath: process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell" })
const out = {}
for (const hash of ["#status=open", "#status=open&view=list"]) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
  await p.goto("file://" + file + hash)
  await p.waitForTimeout(1500)
  await p.evaluate(() => __snap("after page scripts, 1.5 s"))
  out[hash] = await p.evaluate(() => window.__probe)
  await p.screenshot({ path: `/tmp/ds-first-paint-tools/${label}-${hash.includes("list") ? "list" : "feed"}.png` })
  await p.close()
}
await b.close()
console.log(JSON.stringify({ label, out }, null, 1))
