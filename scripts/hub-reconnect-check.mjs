#!/usr/bin/env node
// The React Hub's live connection comes back after a daemon restart, with no
// page reload (#2218 condition C3). Opens the component catalog
// (/hub?react=1#page=catalog) in headless Chrome, stops the demo, starts it
// again, and waits for the catalog's live card to say "open" with one
// return. A value set on the page before the restart must still be there
// after it: the page was not reloaded. Saves a screenshot of each step.
//
//   node scripts/hub-reconnect-check.mjs --out dir
//
//   HUB_CHECK_TOKEN  the demo's dashboard.token (default ci-demo-only-token)
//   CHROME_PATH      Chrome or Chromium, when not in a usual place
//
// It stops and restarts `node dist/cli.js demo`: run it on CI or a demo
// machine only, never beside a daemon you use.
import { execSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { setTimeout as sleep } from "node:timers/promises"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { values: args } = parseArgs({ options: { out: { type: "string" } } })
const out = resolve(args.out || join(tmpdir(), "agentx-hub-reconnect"))
mkdirSync(out, { recursive: true })
const base = "http://127.0.0.1:18931"
const token = process.env.HUB_CHECK_TOKEN || "ci-demo-only-token"
const chromePath = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync)
if (!chromePath) throw new Error("Set CHROME_PATH to Chrome or Chromium")

const port = 9333
const profile = mkdtempSync(join(tmpdir(), "hub-reconnect-"))
// Linux CI runners have no user namespaces for Chrome's sandbox, as in
// wall-page-check.mjs. CI only: on a desktop the sandbox stays on.
const ciFlags = process.env.CI && process.platform === "linux" ? ["--no-sandbox"] : []
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, ...ciFlags, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" })
const done = (code) => { try { chrome.kill() } catch {} rmSync(profile, { recursive: true, force: true }); process.exit(code) }

let up = false
for (let i = 0; i < 150 && !up; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); up = true } catch { await sleep(200) } }
if (!up) { console.error("✗ Chrome did not start"); done(1) }
const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener("open", r))
let id = 0
const pending = new Map()
ws.addEventListener("message", ({ data }) => { const m = JSON.parse(String(data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const cdp = (method, params = {}) => new Promise((r) => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({ id: k, method, params })) })

await cdp("Network.enable")
await cdp("Network.setExtraHTTPHeaders", { headers: { Authorization: `Bearer ${token}` } })
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp("Page.navigate", { url: `${base}/hub?react=1#page=catalog` })

const read = async () => JSON.parse((await cdp("Runtime.evaluate", { returnByValue: true, expression: `JSON.stringify({
  mark: window.__hubMark || null,
  state: document.querySelector('[data-testid=live-state]')?.textContent || null,
  back: document.querySelector('[data-testid=live-reconnects]')?.textContent || null,
  banner: !!document.querySelector('.ax-hub [role=status]'),
})` })).result.result.value)
const shot = async (name) => {
  await cdp("Runtime.evaluate", { expression: "document.querySelector('section[aria-label=Live]')?.scrollIntoView({block:'center'})" })
  await sleep(300)
  const r = await cdp("Page.captureScreenshot", { format: "png" })
  writeFileSync(join(out, name), Buffer.from(r.result.data, "base64"))
}
const waitFor = async (what, ok, seconds) => {
  for (let i = 0; i < seconds * 2; i++) { const v = await read(); if (ok(v)) { console.log(`✓ ${what}`, JSON.stringify(v)); return v } await sleep(500) }
  console.error(`✗ ${what}: timed out`, JSON.stringify(await read()))
  return null
}

if (!await waitFor("live card open", (v) => v.state === "open", 30)) done(1)
await cdp("Runtime.evaluate", { expression: "window.__hubMark = 'same-page'" })
await shot("1-open.png")

execSync(`pkill -f "dist/cli.js demo" || true`)
if (!await waitFor("reconnecting shown while the daemon is down", (v) => v.state === "reconnecting" && v.banner, 30)) done(1)
await shot("2-reconnecting.png")

const log = openSync(join(out, "demo-restart.log"), "w")
spawn("node", ["dist/cli.js", "demo", "--no-open", "--keep", "--dashboard-token", token], { cwd: repo, detached: true, stdio: ["ignore", log, log] }).unref()
const back = await waitFor("open again after the restart, same page", (v) => v.state === "open" && v.back === "1" && !v.banner, 180)
if (!back) done(1)
if (back.mark !== "same-page") { console.error("✗ the page was reloaded"); done(1) }
await shot("3-back.png")
console.log(`Reconnected without a reload. Screenshots in ${out}`)
ws.close()
done(0)
