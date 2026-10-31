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
  // The Wall (#1180): the home page, a post's thread, the list, and a phone.
  { name: "wall/wall", path: "/hub", wait: ".wp" },
  { name: "wall/thread", path: "/hub", wait: ".wp", steps: [{ click: "#post-req-docs-wall-handoff [data-thread]" }, { wait: "#post-req-docs-wall-handoff .wt li" }], clipTo: "#post-req-docs-wall-handoff" },
  // #1242: a post leads with its result; one tap opens the request under it.
  { name: "wall/result-first", path: "/hub#status=", wait: "#post-req-docs-wall-done .wp__result", clipTo: "#post-req-docs-wall-done" },
  { name: "wall/result-request", path: "/hub#status=", wait: "#post-req-docs-wall-done .wp__ask", steps: [{ click: "#post-req-docs-wall-done .wp__ask summary" }, { wait: "#post-req-docs-wall-done .wp__ask[open]" }], clipTo: "#post-req-docs-wall-done" },
  { name: "wall/list", path: "/hub#status=&grp=owner&view=list", wait: ".wl__g" },
  // #1316: a post on its own with its thread, and the nav's own pages.
  { name: "wall/post", path: "/hub#status=&post=req-docs-wall-done", wait: "#open-req-docs-wall-done .wt li" },
  { name: "wall/task", path: "/hub#status=&post=req-docs-plan", wait: "#open-req-docs-plan .wtk__plan", clipTo: "#open-req-docs-plan" },
  { name: "wall/agents", path: "/hub#page=agents", wait: ".wag" },
  { name: "wall/running", path: "/hub#page=running", wait: "#wall-running .wn" },
  // #1355: the feed keeps posts compact; these flags show on the opened post.
  { name: "wall/concurrent", path: "/hub#status=&post=req-docs-wall-question", wait: "#open-req-docs-wall-question .ax-conc", clipTo: "#open-req-docs-wall-question" },
  // A pending decision card on its post (#1185), under "Waiting on the owner".
  { name: "wall/owner-card", path: "/hub#status=waiting_owner&post=req-docs-wall-question", wait: "#open-req-docs-wall-question .wc", clipTo: "#open-req-docs-wall-question" },
  // A QA verdict on its post, and the awaiting-QA filter (#1188).
  { name: "wall/qa", path: "/hub#status=&post=req-docs-qa-block", wait: "#open-req-docs-qa-block .wp__qa", clipTo: "#open-req-docs-qa-block" },
  { name: "wall/qa-awaiting", path: "/hub#status=&qa=1&view=list", wait: ".wl" },
  { name: "wall/phone", path: "/hub", wait: ".wp", phone: true },
  // #1355: Projects as cards, Jobs per machine, the Creator, the phone dark.
  { name: "wall/projects", path: "/hub#status=open&view=projects", wait: ".wpc" },
  { name: "wall/jobs", path: "/hub#status=open&view=jobs", wait: ".wjb" },
  // The Hub pages the docs link from every page (#1448): its nav groups on a
  // phone, the build line, and the Activity and Workflows pages.
  { name: "wall/more-phone", path: "/hub", wait: ".wp", phone: true, steps: [{ click: "[data-more-nav]" }, { wait: "#wall-more:not([hidden])" }] },
  { name: "wall/build-line", path: "/hub", wait: "#wall-build:not(.is-wait)", clipTo: ".ax-wall__head" },
  { name: "wall/activity", path: "/hub#page=activity", wait: "#wall-activity > *" },
  { name: "wall/workflows", path: "/hub#page=workflows", wait: "#wall-workflows .wwf__tabs" },
  { name: "wall/failures", path: "/hub#status=open&view=failures", wait: "#wall-failures .wf" },
  { name: "wall/needs-you", path: "/hub#status=open&view=decide", wait: "#wall-decide .wdc" },
  { name: "wall/needs-you-phone", path: "/hub#status=open&view=decide", wait: "#wall-decide .wdc", phone: true },
  // /approvals redirects to Needs you (#1440): a drafted post on the Drafts
  // chip, Done and Drop on an open post, and the Requests settings.
  { name: "wall/needs-you-drafts", path: "/hub#status=open&view=decide", wait: "#wall-decide .wdc", steps: [{ click: '[data-dkind="drafts"]' }, { wait: '[data-dkind="drafts"].is-on' }] },
  { name: "wall/post-close", path: "/hub#status=&post=req-docs-plan", wait: "#wdo-close [data-act=close-done]", steps: [{ click: "#wdo-close [data-act=close-done]" }, { wait: "#wdo-close .wdc__confirm" }], clipTo: "#open-req-docs-plan .wdo" },
  { name: "wall/settings-requests", path: "/hub#page=settings&section=requests", wait: "#wall-settings [data-st-form=req]" },
  { name: "wall/settings-approvals", path: "/hub#page=settings&section=inbox", wait: "#wall-settings [data-st-form=apv]", steps: [{ scroll: "#wall-settings [data-st-form=apv]" }] },
  { name: "wall/creator", path: "/hub#page=creator", wait: ".wcr__a", steps: [{ click: ".wcr__a" }, { wait: ".wcr__a.is-on" }, { type: "#cr-text", text: "Summarise the open support tickets by topic" }, { type: "#cr-done", text: "A short list in the post" }] },
  { name: "wall/comment", path: "/hub#status=&post=req-docs-wall-done", wait: "#wdo-text", steps: [{ type: "#wdo-text", text: "Thanks. @builder please add the delivery times to the shop page too" }], clipTo: ".wdo" },
  { name: "wall/phone-dark", path: "/hub", wait: ".wp", phone: true, dark: true },
  // Settings on the Wall (#1428): the Agents section, one agent, a save, and a phone.
  { name: "wall/settings", path: "/hub#page=settings&section=agents", wait: ".wsa" },
  // #1428 / #1451 frame 2: two changes not saved, then Save… open, then Saved.
  { name: "wall/settings-agent", path: "/hub#page=settings&section=agents&agent=cx", wait: "#st-e-name", steps: [{ fill: "#st-e-maxConcurrent", text: "3" }, { fill: "#st-e-triggerWords", text: "@cx, desk" }, { wait: "#st-bar:not([hidden])" }] },
  { name: "wall/settings-confirm", path: "/hub#page=settings&section=agents&agent=cx", wait: "#st-e-name", steps: [{ fill: "#st-e-maxConcurrent", text: "3" }, { fill: "#st-e-triggerWords", text: "@cx, desk" }, { click: "[data-st-act=review]" }, { wait: ".wsd" }] },
  { name: "wall/settings-saved", path: "/hub#page=settings&section=agents&agent=cx", wait: "#st-e-name", steps: [{ fill: "#st-e-maxConcurrent", text: "3" }, { click: "[data-st-act=review]" }, { click: "#st-dlg-save" }, { waitText: ["#st-n-edit", "Saved"] }], clipTo: "#st-bar" },
  { name: "wall/settings-phone", path: "/hub#page=settings", wait: ".wst__sec", phone: true },
  { name: "wall/settings-phone-agents", path: "/hub#page=settings&section=agents", wait: ".wsa", phone: true },
  { name: "wall/settings-health", path: "/hub#page=settings&section=health", wait: ".wsh__nodes" },
  { name: "wall/settings-handovers", path: "/hub#page=settings&section=agents&agent=cx&atab=handovers", wait: ".wsa-tab h4", steps: [{ click: ".wsa-tab .wsx > summary" }, { wait: "#st-h-chat" }] },
  // #1355: the status tabs with the filters open, and the composer.
  { name: "wall/filters", path: "/hub#status=waiting", wait: ".wp", steps: [{ click: "#wall-search" }, { wait: "#wall-filters.is-open" }] },
  { name: "wall/compose", path: "/hub", wait: ".wp", steps: [{ type: "#wc-text", text: "@cx please summarise the open support tickets" }], clipTo: "#wall-compose" },
  // The portfolio (#1194), opened with the demo-only key seed-demo.mjs made.
  { name: "wall/portfolio", path: "/portfolio", wait: "#key-form", steps: [{ type: "#key", text: "agx_live_" + "demo".repeat(16) }, { click: "#key-form button" }, { wait: "#projects table" }], full: true },
  { name: "wall/portfolio-phone", path: "/portfolio", wait: "#projects table", phone: true },
  // The posts of one goal under its progress and cost (#1392).
  { name: "wall/goal", path: "/hub#status=&goal=shop-relaunch", wait: ".wgl__bar" },
  // An agent's profile over its own posts (#1207).
  { name: "wall/profile", path: "/hub#owner=cx&status=", wait: ".wpf" },
  // Blocked tasks grouped by the agent that blocks them (#1193).
  { name: "wall/blocked", path: "/hub#status=blocked&by=agent&view=list", wait: ".wl" },
  // The review queue: pending and decided classifications (#1182).
  { name: "wall/reviews", path: "/hub#status=&view=reviews", wait: "[data-rtab]", steps: [{ click: '[data-rtab="approved"]' }, { wait: ".wr__diff" }], clipTo: "#review-docs-review-invoice" },
  // Classic /live opens Wall Live (#1439).
  { name: "live", path: "/hub#page=live", wait: ".wmc" },
  { name: "operations", path: "/mesh", wait: "body" },
  { name: "operations/routines", path: "/mesh", wait: "body", steps: [{ clickText: "Operations" }, { wait: "#mx-routines .mx-flags" }, { scroll: "#mx-routines-title" }] },
  { name: "activity", path: "/activity", wait: ".ac-row" },
  { name: "activity-by-client", path: "/activity", wait: ".ac-row", steps: [{ clickText: "Client" }] },
  { name: "activity-by-channel", path: "/activity", wait: ".ac-row", steps: [{ clickText: "Channel" }] },
  { name: "monitor-inbox", path: "/monitor", wait: "#you .bf-act", full: true },
  { name: "monitor-only-you", path: "/monitor", wait: "#you .bf-act", steps: [{ scroll: "#you" }] },
  { name: "monitor-agents-handle", path: "/monitor", wait: "#agents .bf-act", steps: [{ scroll: "#agents" }] },
  // Hub Settings sections, which /admin opens since #1447.
  { name: "settings-channels", path: "/hub#page=settings&section=channels", wait: "#wall-settings [data-st-form=tg]" },
  { name: "settings-crons", path: "/hub#page=settings&section=schedules", wait: "#wall-settings [data-st-form=cron]" },
  { name: "settings-tokens", path: "/hub#page=settings&section=tokens", wait: "#wall-settings [data-st-form=token]" },
  { name: "notifications/dashboard-routing", path: "/hub#page=settings&section=inbox", wait: "#wall-settings [data-st-form=inbox]" },
  { name: "notifications/dashboard-this-mac", path: "/hub#page=settings&section=inbox", wait: "#st-in-icon", steps: [{ fill: "#st-in-icon", text: "/Users/you/Pictures/team-logo.png" }, { scroll: "#st-in-icon" }] },
  { name: "workflows-list", path: "/workflows", wait: "body" },
  { name: "editor-chat-closed", path: "/workflows/editor?id=demo-report", wait: ".ax-chat__pill" },
  { name: "editor-chat-reply", path: "/workflows/editor?id=demo-report", wait: ".ax-chat__pill", steps: askSteps },
  { name: "editor-canvas", path: "/workflows/editor?id=demo-report", wait: ".ax-chat__pill", steps: [...askSteps, { click: ".ax-chat__applybtn" }, { click: 'button[title="Collapse"]' }] },
  // The editor on the Wall (#1524): two columns, a step's settings, the side
  // menu folded away (last: the editor remembers it), and a phone. The old
  // address redirects there, and loads the page afresh for each shot.
  { name: "workflows/editor", path: "/workflows/editor?id=demo-whatsapp-intake", wait: "#wfe-root .node" },
  { name: "workflows/editor-step", path: "/workflows/editor?id=demo-whatsapp-intake", wait: "#wfe-root .node", steps: [{ click: '#wfe-root .node[data-node="route"]' }, { wait: "#wfe-root .node.is-selected" }] },
  { name: "workflows/editor-loop", path: "/workflows/editor?id=demo-merge-verify", wait: "#wfe-root .node[data-node=verify]" },
  { name: "workflows/editor-phone", path: "/workflows/editor?id=demo-whatsapp-intake", wait: "#wfe-root .node", phone: true },
  { name: "workflows/editor-menu-closed", path: "/workflows/editor?id=demo-whatsapp-intake", wait: "#wfe-root .node", steps: [{ click: "#wfe-root .tb__menu" }, { wait: '#wfe-root .app[data-menu="closed"]' }] },
  { name: "activity/map", path: "/activity", wait: ".ac-row", steps: [{ clickText: "Map" }, { wait: ".subbar__lbl" }] },
  { name: "chat/panel", path: "/monitor", wait: "#you .bf-act", steps: [{ click: "#ax-as-handle" }, { type: "#ax-as-bar-input", text: "Summarize what needs my attention on this page." }, { click: "#ax-as-bar-send" }, { wait: ".ax-as__msg--them.ax-as__md" }] },
  { name: "operations/schedule-drawer", path: "/mesh", wait: "#mx-tab-ops", steps: [{ click: "#mx-tab-ops" }, { wait: "#mx-runs .mx-item" }, { click: "#mx-runs .mx-item" }, { wait: "#mx-drawer.is-open" }] },
  { name: "operations/nodes", path: "/mesh", wait: "#mx-tab-ops", steps: [{ click: "#mx-tab-ops" }, { wait: "#mx-nodes .ax-row-card, #mx-nodes > *" }, { scroll: "#mx-nodes-title" }] },
  // Profile pictures (#1425): docs/jobs/profile-pictures.md sets them on the demo first.
  { name: "pictures/wall-agents", path: "/hub#page=agents", wait: ".wag .av--pic" },
  { name: "pictures/wall-profile", path: "/hub#page=agents", wait: "#agent-cx .av", steps: [{ click: "#agent-cx .av" }, { wait: "#wall-profile .wpc-pic" }], clipTo: "#wall-profile" },
  { name: "pictures/wall-profile-phone", path: "/hub#page=agents", wait: "#agent-cx .av", phone: true, steps: [{ click: "#agent-cx .av" }, { wait: "#wall-profile .wpc-pic" }] },
  { name: "settings/webhooks", path: "/hub#page=settings&section=webhooks", wait: "#wall-settings [data-st-form=wh]" },
  { name: "settings/webhook-routing", path: "/hub#page=settings&section=webhooks", wait: "#wall-settings .wsj__route", steps: [{ click: "#wall-settings .wsj__route summary" }, { scroll: "#wall-settings .wsj__route" }] },
  { name: "settings/mesh", path: "/hub#page=settings&section=mesh", wait: "#wall-settings [data-st-form=mesh-peer]", steps: [{ click: "#wall-settings details.wsc > summary" }] },
  { name: "settings/mesh-cadence", path: "/hub#page=settings&section=mesh", wait: "#wall-settings [data-st-form=mesh-health]", steps: [{ scroll: "#wall-settings [data-st-form=mesh-health]" }] },
  { name: "wiki-notes/settings", path: "/hub#page=settings&section=schedules", wait: "#wall-settings [data-st-form=wn]", steps: [{ scroll: "#wall-settings [data-st-form=wn]" }] },
  { name: "wiki-notes/recent", path: "/hub#page=settings&section=schedules", wait: "#wall-settings [data-st-form=wn]", steps: [{ click: "[data-st-act=wn-list]" }, { wait: "#wall-settings [data-st-form=wn] ~ .wsj__trig li" }, { scroll: "#wall-settings [data-st-form=wn] ~ .wsj__trig" }] },
  { name: "settings/boards", path: "/hub#page=settings&section=boards", wait: "#wall-settings [data-st-form=bd]", steps: [{ click: "#wall-settings details.wsc:has([data-st-form=bd]) > summary" }, { scroll: "#wall-settings [data-st-form=bd]" }] },
  { name: "settings/actions", path: "/hub#page=settings&section=actions", wait: "#wall-settings .wsj__route", steps: [{ click: "#wall-settings .wsj__route summary" }, { type: "#wall-settings [data-st-form=ac-run] input", text: "the team" }, { click: "#wall-settings [data-st-form=ac-run] button[type=submit]" }, { wait: "#wall-settings .wst-out" }, { scroll: "#wall-settings .wsj__route" }] },
  { name: "settings/advanced", path: "/hub#page=settings&section=advanced", wait: "#st-adv-text" },
  { name: "channels/gitlab", path: "/hub#page=settings&section=channels", wait: "#wall-settings .wsj__tabs", steps: [{ click: '[data-st-act=ch][data-ch="gitlab"]' }, { wait: "#st-gl-env" }, { fill: "#st-gl-env", text: "GITLAB_TOKEN" }, { scroll: "#wall-settings [data-st-form=gitlab]" }] },
  { name: "agent-memory/wiki-absorb", path: "/admin/agents/cx", wait: '.ax-opts[data-field="wikiAbsorb"] button.is-active', steps: [{ scroll: '.ax-opts[data-field="wikiAbsorb"]' }] },
  { name: "agents/personality", path: "/admin/agents/cx", wait: "#f-triggers .ax-trig-pill", steps: [{ click: 'a[data-tab="identity"]' }] },
  { name: "setup/filled", path: "/setup", wait: "#wizard", steps: [
    { fill: '[name="agentName"]', text: "Support" }, { fill: '[name="agentId"]', text: "support" },
    { fill: '[name="triggerWords"]', text: "@support, support" }, { select: '[name="tier"]', value: "sdk" },
    { fill: '[name="personality"]', text: "Answer questions about our opening hours and returns policy. Keep replies short." },
    { scroll: '[name="agentName"]' },
  ] },
  { name: "setup/engine", path: "/setup", wait: "#wizard", steps: [{ select: '[name="tier"]', value: "sdk" }, { scroll: '[name="triggerWords"]' }] },
  // The Wall's Cost page (#1423), which /admin/cost now opens: the page, a
  // phone, the details it folds, and the monthly budgets with their form.
  { name: "wall/cost", path: "/hub#status=open&view=cost&range=30", wait: "#wall-cost .wc__row" },
  { name: "wall/cost-phone", path: "/hub#status=open&view=cost&range=30", wait: "#wall-cost .wc__row", phone: true },
  { name: "costs/page", path: "/hub#status=open&view=cost&range=30", wait: "#wall-cost .wc__row", steps: [{ click: "[data-cdetails]" }, { wait: "#wc-details:not([hidden])" }], clipTo: "#wall-cost .wc__more" },
  { name: "costs/budgets", path: "/hub#status=open&view=cost&range=30", wait: "#wall-cost .wc__form", clipTo: "#wall-cost-budgets" },
  // Only the first check group: the others describe this machine's desktop
  // app and home folder, which a screenshot must not publish.
  { name: "doctor/tab", path: "/admin/health", wait: '[data-tab="doctor"]', steps: [{ click: '[data-tab="doctor"]' }, { wait: ".ax-obs__doctor-group" }], clipBefore: ".ax-obs__doctor-group + .ax-obs__doctor-group" },
  { name: "health/routing", path: "/admin/health", wait: '[data-tab="routing"]', steps: [{ click: '[data-tab="routing"]' }] },
  { name: "live/running-build", path: "/mesh", wait: ".ax-build", clipTo: ".ax-topbar__right" },
  // Last: the scripted reply takes a minute, so later shots would show it running.
  // Wall Live (#1439): a running task's page with Pause; the same task
  // paused, with its plan open; Live with it; the machine cards; a phone.
  { name: "wall/task-pause", path: "/hub#page=live", wait: ".wlv", steps: [{ task: { agent: "cx", message: "Go through the demo backlog and tell me what is ready." } }, { wait: ".wls.is-work" }, { click: ".wls.is-work" }, { wait: "#wtask-ops .wtask__pause" }] },
  { name: "wall/live-paused", path: "/hub#page=live", wait: ".wlv", steps: [{ pause: "cx" }, { wait: ".wls.is-stopped .wls__plan" }, { click: ".wls.is-stopped .wls__plan summary" }, { wait: ".wls.is-stopped .wls__plan[open]" }], clipTo: ".wls.is-stopped" },
  { name: "wall/live", path: "/hub#page=live", wait: ".wls.is-stopped" },
  { name: "wall/live-machines", path: "/hub#page=live", wait: ".wmc", clipTo: ".wlv__mc" },
  { name: "wall/live-phone", path: "/hub#page=live", wait: ".wls.is-stopped", phone: true },
  // Every task in a workflow (#858): switched on through the card itself,
  // then a task on the Live tab shows its run's step; switched off again.
  { name: "workflows/required-settings", path: "/workflows", wait: "#wf-required", steps: [{ click: "#wf-required > summary" }, { wait: "#wf-required-agents select" }, { click: "#wf-required-enabled" }, { waitText: ["#wf-required-note", "Saved"] }, { click: ".ax-wf__req-agents > summary" }], clipTo: ".ax-wf__required" },
  { name: "live/running-task-workflow", path: "/hub#page=live", wait: ".wlv", steps: [{ task: { agent: "cx", message: "Go through the demo backlog and tell me what is ready." } }, { waitText: [".wls.is-work", "Workflow"] }, { post: { path: "/api/workflows/required", body: { enabled: false } } }], clipTo: ".wls.is-work" },
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
const chrome = spawn(chromePath, ["--headless=new", "--mute-audio", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" })
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
  // The portfolio opens only on a dashboard with a token (#1194), so
  // docs:demo sets a demo-only one. Every other page gets it as the owner's
  // browser would; the portfolio shots go without it, to type the key.
  const dashToken = cfg.dashboard?.token
  if (!dashToken && selected.some(s => s.name.startsWith("wall/portfolio"))) throw new Error("The portfolio shots need the demo started with pnpm docs:demo (it sets a demo dashboard token)")
  await cdp("Network.enable")
  for (const shot of selected) {
    await cdp("Network.setExtraHTTPHeaders", { headers: dashToken && !shot.name.startsWith("wall/portfolio") ? { Authorization: "Bearer " + dashToken } : {} })
    // A phone-sized page for the shots that say so; the desktop size after.
    await cdp("Emulation.setDeviceMetricsOverride", shot.phone
      ? { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
      : { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
    // Dark for the shots that say so (#1355); light after.
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: shot.dark ? "dark" : "light" }, { name: "prefers-reduced-motion", value: "reduce" }] })
    // A hash-only move keeps the page, and with it the last shot's theme.
    await cdp("Page.navigate", { url: "about:blank" })
    await cdp("Page.navigate", { url: target + shot.path })
    await sleep(500)
    await wait(shot.wait)
    await sleep(700)
    for (const step of shot.steps || []) {
      if (step.wait) await wait(step.wait)
      if (step.waitText) {
        const [sel, text] = step.waitText
        for (let i = 0; i < 200 && !(await evaluate(`(document.querySelector(${JSON.stringify(sel)})?.textContent || "").includes(${JSON.stringify(text)})`)); i++) await sleep(150)
      }
      // A dashboard API call, as the page would make it.
      if (step.post) await evaluate(`fetch(${JSON.stringify(step.post.path)}, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "agentx-board" }, body: ${JSON.stringify(JSON.stringify(step.post.body))} }).then(r => r.status)`)
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
      // Start a manual run of a seeded workflow on the demo daemon (#870).
      if (step.workflow) {
        const r = await fetch(`http://127.0.0.1:18921/workflows/${encodeURIComponent(step.workflow)}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        if (!r.ok) throw new Error(`Workflow run failed: ${r.status} ${await r.text()}`)
      }
      // Pause the agent's running task with a stop signal (#857).
      if (step.pause) {
        const agents = await (await fetch("http://127.0.0.1:18921/agents")).json()
        const run = agents.find(a => a.id === step.pause)?.runningTasks?.[0]
        if (!run) throw new Error(`No running task on ${step.pause}`)
        const r = await fetch("http://127.0.0.1:18921/api/signals/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: run.id, reason: "deploy at 15:00" }) })
        if (!r.ok) throw new Error(`Pause failed: ${r.status} ${await r.text()}`)
      }
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
      // In page coordinates, captured beyond the viewport: an element below
      // the fold would otherwise come out blank.
      const r = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(shot.clipTo)}).getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height } })()`)
      params.captureBeyondViewport = true
      // The fixed Ask bar would land over the element.
      await evaluate("(() => { const s=document.createElement('style'); s.textContent='#ax-as-dock,#ax-as-handle{display:none!important}';document.head.append(s) })()")
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
