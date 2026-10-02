#!/usr/bin/env node
// Reproducible screenshots of the isolated, seeded demo. No production
// target override, private name swaps, or fabricated browser content.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const out = resolve(repo, "docs/public/screenshots")
const target = process.env.AGENTX_DASHBOARD || "http://127.0.0.1:18931"
if (target !== "http://127.0.0.1:18931") throw new Error("Refusing a non-demo dashboard target")
const cfg = JSON.parse(readFileSync(resolve(repo, ".agentx-demo/node-a/agentx.json"), "utf8"))
if (cfg.node?.id !== "demo-laptop" || cfg.agents?.cx?.provider !== "demo") throw new Error("Expected the isolated scripted demo")
const chromePath = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].find(existsSync)
if (!chromePath) throw new Error("Set CHROME_PATH to Chrome or Chromium")

const askSteps = [
  { click: ".ax-chat__pill" },
  { type: ".ax-chat__input", text: "Build the demo report workflow" },
  { click: ".ax-chat__send" },
  { wait: ".ax-chat__applybtn" },
]
const shots = [
  { name: "live", path: "/live", wait: ".ax-agent__name" },
  { name: "operations", path: "/mesh", wait: "body" },
  { name: "operations/routines", path: "/mesh", wait: "body", steps: [{ clickText: "Operations" }, { wait: "#mx-routines .mx-flags" }, { scroll: "#mx-routines-title" }] },
  { name: "activity", path: "/activity", wait: ".ac-row" },
  { name: "activity-by-client", path: "/activity", wait: ".ac-row", steps: [{ clickText: "Client" }] },
  { name: "activity-by-channel", path: "/activity", wait: ".ac-row", steps: [{ clickText: "Channel" }] },
  { name: "monitor-inbox", path: "/monitor", wait: "#you .bf-act", full: true },
  { name: "monitor-only-you", path: "/monitor", wait: "#you .bf-act", steps: [{ scroll: "#you" }] },
  { name: "monitor-agents-handle", path: "/monitor", wait: "#agents .bf-act", steps: [{ scroll: "#agents" }] },
  { name: "approvals/inbox", path: "/approvals", wait: ".apv__item" },
  { name: "approvals/details", path: "/approvals", wait: ".apv__item", steps: [{ click: ".apv__detail summary" }] },
  { name: "settings", path: "/admin", wait: "#agent-list" },
  { name: "settings-channels", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="channels"]' }] },
  { name: "settings-crons", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="crons"]' }] },
  { name: "settings-tokens", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="tokens"]' }] },
  { name: "notifications/dashboard-routing", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="channels"]' }, { click: "#notif-section summary" }, { scroll: "#notif-section" }] },
  { name: "notifications/dashboard-this-mac", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="channels"]' }, { click: "#notif-section summary" }, { type: "#notif-local-icon", text: "/Users/you/Pictures/team-logo.png" }, { scroll: "fieldset:has(#notif-local-banner)" }] },
  { name: "workflows-list", path: "/workflows", wait: "body" },
  { name: "editor-chat-closed", path: "/workflows/editor?id=demo-report", wait: ".ax-chat__pill" },
  { name: "editor-chat-reply", path: "/workflows/editor?id=demo-report", wait: ".ax-chat__pill", steps: askSteps },
  { name: "editor-canvas", path: "/workflows/editor?id=demo-report", wait: ".ax-chat__pill", steps: [...askSteps, { click: ".ax-chat__applybtn" }, { click: 'button[title="Collapse"]' }] },
  { name: "activity/map", path: "/activity", wait: ".ac-row", steps: [{ clickText: "Map" }, { wait: ".subbar__lbl" }] },
  { name: "chat/panel", path: "/monitor", wait: "#you .bf-act", steps: [{ click: "#ax-as-handle" }, { type: "#ax-as-bar-input", text: "Summarize what needs my attention on this page." }, { click: "#ax-as-bar-send" }, { wait: ".ax-as__msg--them.ax-as__md" }] },
  { name: "operations/schedule-drawer", path: "/mesh", wait: "#mx-tab-ops", steps: [{ click: "#mx-tab-ops" }, { wait: "#mx-runs .mx-item" }, { click: "#mx-runs .mx-item" }, { wait: "#mx-drawer.is-open" }] },
  { name: "operations/nodes", path: "/mesh", wait: "#mx-tab-ops", steps: [{ click: "#mx-tab-ops" }, { wait: "#mx-nodes .ax-row-card, #mx-nodes > *" }, { scroll: "#mx-nodes-title" }] },
  { name: "settings/webhooks", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="webhooks"]' }, { scroll: "#tab-webhooks" }] },
  { name: "settings/webhook-routing", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="webhooks"]' }, { click: "#tab-webhooks details summary" }, { scroll: "#tab-webhooks details" }] },
  { name: "settings/mesh", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="mesh"]' }, { scroll: "#tab-mesh" }] },
  { name: "settings/mesh-cadence", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="mesh"]' }, { click: "#tab-mesh details.add-form summary" }, { scroll: "#tab-mesh details.add-form" }] },
  { name: "settings/boards", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="boards-cfg"]' }, { wait: "#tab-boards-cfg details.add-form" }, { click: "#tab-boards-cfg details.add-form summary" }, { scroll: "#tab-boards-cfg" }] },
  { name: "settings/actions", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="actions"]' }, { wait: "#tab-actions details:not(.add-form)" }, { click: "#tab-actions details:not(.add-form) summary" }, { type: "#tab-actions details:not(.add-form) input", text: "the team" }, { click: "#tab-actions details:not(.add-form) button.primary" }, { wait: "#tab-actions [data-ac-msg].ok" }, { scroll: "#tab-actions" }] },
  { name: "settings/advanced-tree", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="advanced"]' }, { wait: ".ax-jv-line" }, { click: "#jv-collapse-all" }, { click: ".ax-jv-toggle" }, { click: '.ax-jv-line[data-path="agents"] .ax-jv-toggle' }, { click: '.ax-jv-line[data-path="agents.cx"] .ax-jv-toggle' }, { scroll: "#tab-advanced" }] },
  { name: "channels/gitlab", path: "/admin", wait: "#agent-list", steps: [{ click: '[data-tab="channels"]' }, { clickText: "GitLab", within: "#ch-devtools .ax-connector" }, { wait: "#gl-env" }, { type: "#gl-env", text: "GITLAB_TOKEN" }, { scroll: "#ch-gitlab" }] },
  { name: "agents/personality", path: "/admin/agents/cx", wait: "#f-triggers .ax-trig-pill", steps: [{ click: 'a[data-tab="identity"]' }] },
  { name: "setup/filled", path: "/setup", wait: "#wizard", steps: [
    { fill: '[name="agentName"]', text: "Support" }, { fill: '[name="agentId"]', text: "support" },
    { fill: '[name="triggerWords"]', text: "@support, support" }, { select: '[name="tier"]', value: "sdk" },
    { fill: '[name="personality"]', text: "Answer questions about our opening hours and returns policy. Keep replies short." },
    { scroll: '[name="agentName"]' },
  ] },
  { name: "setup/engine", path: "/setup", wait: "#wizard", steps: [{ select: '[name="tier"]', value: "sdk" }, { scroll: '[name="triggerWords"]' }] },
  { name: "costs/page", path: "/admin/cost", wait: "body" },
  // Only the first check group: the others describe this machine's desktop
  // app and home folder, which a screenshot must not publish.
  { name: "doctor/tab", path: "/admin/health", wait: '[data-tab="doctor"]', steps: [{ click: '[data-tab="doctor"]' }, { wait: ".ax-obs__doctor-group" }], clipBefore: ".ax-obs__doctor-group + .ax-obs__doctor-group" },
  { name: "health/routing", path: "/admin/health", wait: '[data-tab="routing"]', steps: [{ click: '[data-tab="routing"]' }] },
  { name: "live/running-build", path: "/live", wait: ".ax-build", clipTo: ".ax-topbar__right" },
  // Last: the scripted reply takes a minute, so later shots would show it running.
  { name: "live/running-task", path: "/live", wait: ".ax-agent__name", steps: [{ task: { agent: "cx", message: "Go through the demo backlog and tell me what is ready." } }, { wait: ".ax-task-action--update" }] },
]

function client(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener("message", ({ data }) => {
    const m = JSON.parse(String(data))
    // Moving between editor shots can trigger its unsaved-changes dialog.
    if (m.method === "Page.javascriptDialogOpening") {
      ws.send(JSON.stringify({ id: ++id, method: "Page.handleJavaScriptDialog", params: { accept: true } }))
      return
    }
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

const profile = mkdtempSync(join(tmpdir(), "agentx-docs-chrome-"))
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" })
let launchError
chrome.on("error", e => { launchError = e })
let ws
try {
  const portFile = join(profile, "DevToolsActivePort")
  for (let i = 0; !existsSync(portFile) && i < 100; i++) { if (launchError) throw launchError; await sleep(100) }
  if (!existsSync(portFile)) throw new Error("Chrome did not start; check local process permissions")
  const port = readFileSync(portFile, "utf8").split("\n")[0]
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws = new WebSocket(pages.find(p => p.type === "page").webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }) })
  const cdp = client(ws)
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + (result.exceptionDetails.exception?.description || ""))
    return result.result?.value
  }
  const wait = async selector => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return
      await sleep(150)
    }
    throw new Error(`Missing element: ${selector}`)
  }
  await cdp("Page.enable")
  await cdp("Runtime.enable")
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] })
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('ax-theme', 'light'); localStorage.removeItem('ax-assistant-open'); localStorage.removeItem('ax-assistant-thread') } catch {}" })
  mkdirSync(out, { recursive: true })
  const requested = process.env.DOCS_SHOTS?.split(",")
  const selected = requested ? shots.filter(s => requested.includes(s.name)) : shots
  if (!selected.length) throw new Error("No matching DOCS_SHOTS")
  for (const shot of selected) {
    await cdp("Page.navigate", { url: target + shot.path })
    await sleep(500)
    await wait(shot.wait)
    await sleep(700)
    for (const step of shot.steps || []) {
      if (step.wait) await wait(step.wait)
      if (step.click) { await wait(step.click); await evaluate(`document.querySelector(${JSON.stringify(step.click)}).click()`) }
      if (step.clickText) await evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(step.within || "button")})].find(e => e.textContent.trim() === ${JSON.stringify(step.clickText)} || (${JSON.stringify(!!step.within)} && e.textContent.includes(${JSON.stringify(step.clickText)}))); if (!b) throw Error('Button missing'); b.click() })()`)
      if (step.type) {
        await wait(step.type)
        await evaluate(`document.querySelector(${JSON.stringify(step.type)}).focus()`)
        await cdp("Input.insertText", { text: step.text })
      }
      // Replace a prefilled value the way typing over a selection would.
      if (step.fill) {
        await wait(step.fill)
        await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(step.fill)}); e.focus(); e.select() })()`)
        await cdp("Input.insertText", { text: step.text })
      }
      if (step.select) await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(step.select)}); e.value = ${JSON.stringify(step.value)}; e.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      // Start a real scripted task on the demo daemon without waiting for it.
      if (step.task) fetch("http://127.0.0.1:18921/task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(step.task) }).catch(() => {})
      if (step.scroll) await evaluate(`window.scrollTo(0, document.querySelector(${JSON.stringify(step.scroll)}).getBoundingClientRect().top + window.scrollY - 110)`)
      await sleep(300)
    }
    await evaluate("document.fonts.ready")
    await evaluate("(() => { const s=document.createElement('style'); s.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';document.head.append(s) })()")
    const params = { format: "png", captureBeyondViewport: !!shot.full }
    if (shot.full) {
      const { cssContentSize } = await cdp("Page.getLayoutMetrics")
      params.clip = { x: 0, y: 0, width: 1440, height: Math.min(cssContentSize.height, 3600), scale: 1 }
    }
    if (shot.clipBefore) {
      await evaluate("window.scrollTo(0, 0)")
      const top = await evaluate(`document.querySelector(${JSON.stringify(shot.clipBefore)}).getBoundingClientRect().top`)
      params.clip = { x: 0, y: 0, width: 1440, height: Math.min(Math.floor(top) - 8, 900), scale: 1 }
    }
    // Only one element, with a little room around it.
    if (shot.clipTo) {
      const r = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(shot.clipTo)}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height } })()`)
      params.clip = { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 8), width: r.width + 24, height: r.height + 16, scale: 1 }
    }
    const screenshot = await cdp("Page.captureScreenshot", params)
    const file = resolve(out, `${shot.name}.png`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(screenshot.data, "base64"))
    console.log(`Captured ${shot.name}`)
  }
} finally {
  ws?.close()
  chrome.kill("SIGTERM")
  await sleep(1000)
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL")
  rmSync(profile, { recursive: true, force: true })
}
