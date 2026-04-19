#!/usr/bin/env node
// Dashboard screenshot capture with pre-render name swaps + post-process blur.
//
// Usage:
//   node docs/.scripts/capture.mjs
//
// How it works:
//   1. Launches Chrome headless with --remote-debugging-port so we can use
//      the DevTools Protocol (no puppeteer dependency).
//   2. For each shot in SHOTS[]:
//      - Navigate.
//      - Wait for DOMContentLoaded + one paint cycle.
//      - Evaluate `replaceText` with the redactions for this shot — walks
//        text nodes and swaps operator-real strings for demo equivalents.
//      - Capture via Page.captureScreenshot (full window).
//      - Optional ImageMagick post-blur for regions that text-swap can't
//        reach (e.g. images, canvas, code blocks in <pre>).
//   3. Emits PNGs into docs/public/screenshots/.

import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, "../public/screenshots")
mkdirSync(OUT, { recursive: true })

const DASHBOARD = process.env.AGENTX_DASHBOARD || "http://localhost:4202"

// Operator-real text → demo text. Applied as whole-word replacements across
// every text node after render. Keep the REAL side as strings that uniquely
// identify operator data, not generic UI labels.
const REDACTIONS = [
  // Agent display names
  [/\bNadia\b/gi, "Marketing"],
  [/\bDevOps\b/g, "Ops"],
  [/\bAccountant\b/g, "Billing"],
  [/\bSales Manager\b/g, "Sales"],
  [/\bGraph Agent\b/g, "Indexer"],
  // Agent IDs / slugs
  [/\bmarketing-agent\b/g, "marketing"],
  [/\bdevops-agent\b/g, "ops"],
  [/\baccountant-agent\b/g, "billing"],
  [/\bsales-manager-agent\b/g, "sales"],
  [/\bgraph-agent\b/g, "indexer"],
  // cron IDs prefixed with operator names
  [/\bnadia-/g, "marketing-"],
  // Owner / operator person names
  [/\banis\b/gi, "owner"],
  // Project names
  [/\bMTGL\b/gi, "Demo"],
  [/\bmtgl\b/gi, "demo"],
  [/\bNoqta\b/gi, "Acme"],
  [/\bnoqta\.tn\b/g, "acme.co"],
  [/\bhackathonat\b/gi, "DemoSite"],
  // IPs + hosts
  [/\b100\.[0-9]+\.[0-9]+\.[0-9]+\b/g, "100.64.0.X"],
  [/\b64\.226\.102\.124\b/g, "198.51.100.23"],
  [/clawd-server/gi, "peer-server"],
  [/clawd\.noqta\.tn/gi, "peer.acme.co"],
  [/\bmacbook-local\b/gi, "hq-local"],
  [/\bMacBook-Local\b/g, "HQ"],
  // Any gitlab.* → demo
  [/gitlab\.[a-z][a-z0-9.-]+/gi, "gitlab.acme.co"],
  // /Users/... paths → ~/...
  [/\/Users\/[a-z][a-z0-9_-]*/gi, "~"],
  // /home/clawd → ~
  [/\/home\/[a-z][a-z0-9_-]*/gi, "~"],
  // Credential fragments
  [/\b\d{7,}:[A-Za-z0-9_-]{30,}\b/g, "123456:demo-bot-token"],
  [/\bAAA[0-9A-Za-z_-]{30,}\b/g, "<telegram-token>"],
  // Phone numbers
  [/\+\d{10,14}/g, "+1555000000"],
  // Chat IDs (Telegram group format)
  [/-100\d{8,}/g, "-1001000000000"],
]

const SHOTS = [
  { name: "boards",    url: "/",              waitSel: ".ax-board-col" },
  { name: "live",      url: "/live",          waitSel: ".ax-agent__name", postDelayMs: 1500 },
  { name: "admin",     url: "/admin",         waitSel: "#agent-list", scrollTo: 0 },
  { name: "channels",  url: "/admin",         waitSel: "[data-tab=channels]", clickSel: "[data-tab=channels]", postDelayMs: 600 },
  { name: "mesh",      url: "/admin",         waitSel: "[data-tab=mesh]",     clickSel: "[data-tab=mesh]",     postDelayMs: 600 },
  { name: "webhooks",  url: "/admin",         waitSel: "[data-tab=webhooks]", clickSel: "[data-tab=webhooks]", postDelayMs: 600 },
  { name: "crons",     url: "/admin",         waitSel: "[data-tab=crons]",    clickSel: "[data-tab=crons]",    postDelayMs: 600 },
  { name: "graph",     url: "/admin/graph",   waitSel: "body" },
  { name: "setup",     url: "/setup",         waitSel: "body" },
  { name: "glossary",  url: "/glossary",      waitSel: "body" },
]

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const PORT = 9222 + Math.floor(Math.random() * 1000)

function launchChrome() {
  const child = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-sandbox",
    "--disable-features=PaintHolding,BackForwardCache",
    "--window-size=1440,900",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/agentx-capture-${process.pid}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] })
  child.stderr.on("data", () => {}) // suppress CDP banner noise
  return child
}

async function getDebuggerUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      // /json/list enumerates page targets. Connect to a PAGE's WS so Page.*
      // domain calls work — the /json/version endpoint is browser-scope only
      // and doesn't accept Page.enable / Page.navigate / Page.captureScreenshot.
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const arr = await r.json()
        const page = arr.find((t) => t.type === "page")
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      }
    } catch {}
    await sleep(200)
  }
  throw new Error(`Chrome DevTools never came up on port ${PORT}`)
}

function makeCDP(ws) {
  let nextId = 1
  const inflight = new Map()
  ws.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(ev.data.toString())
      if (m.id && inflight.has(m.id)) {
        const { resolve: r, reject: j } = inflight.get(m.id)
        inflight.delete(m.id)
        if (m.error) j(new Error(m.error.message))
        else r(m.result)
      }
    } catch {}
  })
  return (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++
    inflight.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (inflight.has(id)) {
        inflight.delete(id)
        rej(new Error(`timeout ${method}`))
      }
    }, 15000)
  })
}

function redactScript() {
  const pairs = REDACTIONS.map(([re, to]) => [re.source, re.flags, to])
  return `
    (() => {
      const pairs = ${JSON.stringify(pairs)};
      const rules = pairs.map(([s, f, t]) => [new RegExp(s, f), t]);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (!n.nodeValue) continue;
        let v = n.nodeValue, changed = false;
        for (const [re, to] of rules) {
          const next = v.replace(re, to);
          if (next !== v) { v = next; changed = true; }
        }
        if (changed) n.nodeValue = v;
      }
      // Also rewrite common attributes that render user data in tooltips
      // or placeholders.
      for (const el of document.querySelectorAll("[title],[placeholder],[aria-label]")) {
        for (const attr of ["title","placeholder","aria-label"]) {
          const v = el.getAttribute(attr);
          if (!v) continue;
          let next = v;
          for (const [re, to] of rules) next = next.replace(re, to);
          if (next !== v) el.setAttribute(attr, next);
        }
      }
      // Input values (the setup wizard pre-fills Team name, IDs, etc.)
      for (const el of document.querySelectorAll("input, textarea")) {
        if (typeof el.value !== "string" || !el.value) continue;
        let next = el.value;
        for (const [re, to] of rules) next = next.replace(re, to);
        if (next !== el.value) el.value = next;
      }
      // <select> <option> text (the wizard populates agent dropdowns)
      for (const el of document.querySelectorAll("option")) {
        if (!el.text) continue;
        let next = el.text;
        for (const [re, to] of rules) next = next.replace(re, to);
        if (next !== el.text) el.text = next;
      }
    })();
    true
  `
}

async function waitFor(cdp, selector, ms = 6000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const r = await cdp("Runtime.evaluate", {
      expression: `!!document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: true,
    })
    if (r.result?.value) return true
    await sleep(100)
  }
  return false
}

async function run() {
  const chrome = launchChrome()
  try {
    const wsUrl = await getDebuggerUrl()
    const { WebSocket } = globalThis
    if (!WebSocket) throw new Error("Node 22+ required (uses global WebSocket)")
    const ws = new WebSocket(wsUrl)
    await new Promise((r, j) => {
      ws.addEventListener("open", r, { once: true })
      ws.addEventListener("error", j, { once: true })
    })
    const cdp = makeCDP(ws)

    await cdp("Page.enable")
    await cdp("Runtime.enable")

    for (const shot of SHOTS) {
      const url = DASHBOARD + shot.url
      process.stdout.write(`  ${shot.name.padEnd(10)} ${url} ... `)
      try {
        await cdp("Page.navigate", { url })
        await sleep(400)
        if (shot.waitSel) await waitFor(cdp, shot.waitSel)
        // Give async data fetches (live sparklines, graph nodes, etc.)
        // a moment to paint before we capture.
        await sleep(shot.postDelayMs || 500)

        // Optional: click a tab before capturing
        if (shot.clickSel) {
          await cdp("Runtime.evaluate", {
            expression: `document.querySelector(${JSON.stringify(shot.clickSel)})?.click()`,
            awaitPromise: true,
          })
          await sleep(shot.postDelayMs || 400)
        }

        // Inject redactions
        await cdp("Runtime.evaluate", {
          expression: redactScript(),
          awaitPromise: true,
        })

        // Capture
        const r = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
        const buf = Buffer.from(r.data, "base64")
        const out = resolve(OUT, `${shot.name}.png`)
        writeFileSync(out, buf)
        process.stdout.write(`✓ ${(buf.length / 1024).toFixed(0)}KB\n`)
      } catch (e) {
        process.stdout.write(`✗ ${e.message}\n`)
      }
    }

    ws.close()
  } finally {
    chrome.kill("SIGTERM")
  }
}

run().catch((e) => { console.error(e); process.exit(1) })
