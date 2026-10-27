#!/usr/bin/env node
// The shared Wall page check (#1454). Opens every view in
// scripts/wall-page-check.json at 390 px and at desktop width in headless
// Chrome, and fails on any console error, uncaught exception, failed request
// or HTTP error response. Saves a screenshot of each for the PR.
//
//   node scripts/wall-page-check.mjs [--only feed,cost] [--out dir]
//
//   WALL_CHECK_URL    the dashboard (default: the demo's, http://127.0.0.1:18931)
//   WALL_CHECK_TOKEN  its dashboard.token, sent as the owner's browser would
//   CHROME_PATH       Chrome or Chromium, when not in a usual place
//
// Same raw DevTools protocol as docs/.scripts/capture.mjs: no extra
// dependency. Exit 1 lists every problem, view by view.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { setTimeout as sleep } from "node:timers/promises"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { values: args } = parseArgs({ options: { only: { type: "string" }, out: { type: "string" } } })
const target = (process.env.WALL_CHECK_URL || "http://127.0.0.1:18931").replace(/\/+$/, "")
const token = process.env.WALL_CHECK_TOKEN || ""
const out = resolve(args.out || join(tmpdir(), "agentx-wall-check"))
const { views: all } = JSON.parse(readFileSync(join(repo, "scripts/wall-page-check.json"), "utf8"))
const only = args.only?.split(",")
const views = only ? all.filter((v) => only.includes(v.name)) : all
if (!views.length) throw new Error(`No view named ${args.only}`)
const SIZES = [
  { name: "390", metrics: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } },
  { name: "desktop", metrics: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false } },
]
const READY_MS = 20000
// After the view draws: requests it starts late, and errors they cause.
const SETTLE_MS = 1500

const chromePath = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(existsSync)
if (!chromePath) throw new Error("Set CHROME_PATH to Chrome or Chromium")

function client(ws, onEvent) {
  let id = 0
  const pending = new Map()
  ws.addEventListener("message", ({ data }) => {
    const m = JSON.parse(String(data))
    if (!m.id) return onEvent(m.method, m.params)
    const entry = pending.get(m.id)
    if (!entry) return
    clearTimeout(entry.timer); pending.delete(m.id)
    m.error ? entry.reject(new Error(m.error.message)) : entry.resolve(m.result)
  })
  return (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timed out: ${method}`)) }, 30000)
    pending.set(key, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: key, method, params }))
  })
}

// What went wrong on the page being checked; reset for each view and size.
let problems = []
const urls = new Map()
function onEvent(method, p) {
  if (method === "Runtime.exceptionThrown") problems.push(`uncaught: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`)
  if (method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "assert")) {
    problems.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`)
  }
  if (method === "Log.entryAdded" && p.entry.level === "error") problems.push(`console: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ""}`)
  if (method === "Network.requestWillBeSent") urls.set(p.requestId, p.request.url)
  if (method === "Network.responseReceived" && p.response.status >= 400) problems.push(`HTTP ${p.response.status}: ${p.response.url}`)
  // A request the page itself dropped (a poll it replaced) is not a failure.
  if (method === "Network.loadingFailed" && !p.canceled) problems.push(`failed request: ${urls.get(p.requestId) || p.requestId} (${p.errorText})`)
}

const profile = mkdtempSync(join(tmpdir(), "agentx-wall-check-"))
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" })
let launchError
chrome.on("error", (e) => { launchError = e })
let ws
const report = []
try {
  const portFile = join(profile, "DevToolsActivePort")
  for (let i = 0; !existsSync(portFile) && i < 150; i++) { if (launchError) throw launchError; await sleep(100) }
  if (!existsSync(portFile)) throw new Error("Chrome did not start")
  const port = readFileSync(portFile, "utf8").split("\n")[0]
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }) })
  const cdp = client(ws, onEvent)
  const evaluate = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true })).result?.value
  await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map((m) => cdp(m)))
  if (token) await cdp("Network.setExtraHTTPHeaders", { headers: { Authorization: `Bearer ${token}` } })
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  mkdirSync(out, { recursive: true })

  for (const view of views) {
    for (const size of SIZES) {
      await cdp("Emulation.setDeviceMetricsOverride", size.metrics)
      // A fresh load each time: hash-only moves would keep the last view's page.
      await cdp("Page.navigate", { url: "about:blank" })
      problems = []
      urls.clear()
      await cdp("Page.navigate", { url: target + view.path })
      let ready = false
      for (const until = Date.now() + READY_MS; !ready && Date.now() < until; await sleep(200)) {
        ready = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(view.ready)}); return !!e && !!(e.offsetParent || e.getClientRects().length) })()`)
      }
      if (!ready) problems.push(`not drawn within ${READY_MS / 1000}s: ${view.ready}`)
      await sleep(SETTLE_MS)
      const shot = await cdp("Page.captureScreenshot", { format: "png" })
      const file = join(out, `${view.name}-${size.name}.png`)
      writeFileSync(file, Buffer.from(shot.data, "base64"))
      const found = [...new Set(problems)]
      report.push({ view: view.name, size: size.name, screenshot: file, problems: found })
      console.log(`${found.length ? "✗" : "✓"} ${view.name} @ ${size.name}`)
      for (const p of found) console.log(`    ${p}`)
    }
  }
} finally {
  ws?.close()
  chrome.kill("SIGTERM")
  await sleep(500)
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL")
  rmSync(profile, { recursive: true, force: true })
}

writeFileSync(join(out, "report.json"), JSON.stringify({ target, checkedAt: new Date().toISOString(), results: report }, null, 2) + "\n")
const failed = report.filter((r) => r.problems.length)
console.log(`\n${report.length - failed.length}/${report.length} passed. Screenshots and report.json in ${out}`)
if (failed.length) process.exit(1)
