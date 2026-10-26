#!/usr/bin/env node
// Builds the repository's social preview image (the card GitHub shows when a
// link to the repository is pasted into Slack, X, Discord or a chat).
// Renders docs/.scripts/social-preview/template.html with a local Chrome and
// writes docs/public/social-preview.png at 1280×640, the size GitHub recommends.
// Uploading it is a browser step for the owner: CONTRIBUTING.md › Social preview image.
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"

const here = dirname(fileURLToPath(import.meta.url))
const template = resolve(here, "social-preview/template.html")
const out = resolve(here, "../public/social-preview.png")
const WIDTH = 1280
const HEIGHT = 640
const check = process.argv.includes("--check")

const chromePath = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].find(existsSync)
if (!chromePath) throw new Error("Set CHROME_PATH to Chrome or Chromium")

// WCAG contrast, so a palette change cannot quietly make the card unreadable.
const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

const client = ws => {
  let id = 0
  const pending = new Map()
  ws.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data)
    if (!pending.has(msg.id)) return
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  })
  return (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id
    pending.set(key, { resolve, reject })
    ws.send(JSON.stringify({ id: key, method, params }))
  })
}

const profile = mkdtempSync(join(tmpdir(), "agentx-social-preview-"))
// Chrome refuses to start as root with its sandbox on (CI containers); everywhere else the sandbox stays.
const rootFlags = process.getuid?.() === 0 ? ["--no-sandbox"] : []
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--remote-debugging-port=0", ...rootFlags, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" })
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
  await cdp("Page.enable")
  await cdp("Runtime.enable")
  await cdp("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await cdp("Page.navigate", { url: pathToFileURL(template).href })
  await sleep(300)
  await evaluate("document.fonts.ready")
  for (const font of ['400 1em "Archivo Black"', '400 1em "Archivo"', '500 1em "Archivo"']) {
    if (!await evaluate(`document.fonts.check(${JSON.stringify(font)})`)) throw new Error(`Font did not load: ${font}`)
  }
  await evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")

  const colours = await evaluate(`(() => { const s = getComputedStyle(document.documentElement); return ["--ink", "--headline", "--body", "--accent-text"].map(v => s.getPropertyValue(v).trim()) })()`)
  const [ink, ...texts] = colours
  for (const text of texts) {
    const ratio = contrast(text, ink)
    if (ratio < 4.5) throw new Error(`${text} on ${ink} has contrast ${ratio.toFixed(2)}:1; WCAG AA needs 4.5:1`)
  }
  const overflow = await evaluate(`[...document.querySelectorAll(".brand, h1, p")].filter(e => { const r = e.getBoundingClientRect(); return r.right > ${WIDTH} || r.bottom > ${HEIGHT} }).map(e => e.tagName).join(",")`)
  if (overflow) throw new Error(`Text leaves the card: ${overflow}`)

  const { data } = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } })
  const png = Buffer.from(data, "base64")
  if (png.readUInt32BE(16) !== WIDTH || png.readUInt32BE(20) !== HEIGHT) throw new Error("Rendered size is not 1280×640")
  if (png.length > 1_000_000) throw new Error(`Image is ${png.length} bytes; GitHub accepts up to 1 MB`)
  if (check) {
    if (!existsSync(out)) throw new Error(`${out} is missing; run pnpm docs:social-preview`)
    if (!readFileSync(out).equals(png)) throw new Error("docs/public/social-preview.png is out of date; run pnpm docs:social-preview")
    console.log("social-preview.png matches its template.")
  } else {
    writeFileSync(out, png)
    console.log(`Wrote ${out} (${WIDTH}×${HEIGHT}, ${Math.round(png.length / 1024)} KB)`)
  }
} finally {
  ws?.close()
  chrome.kill("SIGTERM")
  await sleep(1000)
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL")
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
}
