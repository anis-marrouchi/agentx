#!/usr/bin/env node
// Reproducible screenshots of the phone app for the docs, from the
// loopback-only fixture (test/fixtures/mobile-app-preview.ts): scripted
// answers, neutral names, no agent, no device and no live fleet.
//
//   pnpm docs:shots:mobile                    every picture
//   DOCS_SHOTS=chat,fleet pnpm docs:shots:mobile   a subset
//
// Needs Node 22 and Chrome or Chromium (CHROME_PATH if it is elsewhere).
// The browser runs headless with its built-in fake camera, so the camera
// pictures show a test pattern and never a real room. The only things the
// page gets that a phone would not are small stand-ins for what a demo
// cannot have: a WebRTC viewer that "connects", a push subscription, and a
// camera that shows a QR code. Everything else is the app as shipped.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const out = resolve(repo, "docs/public/screenshots/mobile-app")
const base = "http://127.0.0.1:18948"
const chromePath = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].find(existsSync)
if (!chromePath) throw new Error("Set CHROME_PATH to Chrome or Chromium")
const QRCode = createRequire(import.meta.url)("qrcode")

// --- The fixture ---
const up = async () => { try { return (await fetch(base + "/api/app/me")).status < 500 } catch { return false } }
let fixture
if (!(await up())) {
  const tsx = join(repo, "node_modules/.bin/tsx")
  fixture = spawn(tsx, [join(repo, "test/fixtures/mobile-app-preview.ts")], { stdio: ["ignore", "ignore", "inherit"] })
  for (let i = 0; !(await up()) && i < 100; i++) await sleep(200)
  if (!(await up())) throw new Error("The fixture did not start on " + base)
}

// --- The browser ---
function client(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener("message", ({ data }) => {
    const m = JSON.parse(String(data))
    if (m.method === "Runtime.exceptionThrown") console.error("Page error:", m.params.exceptionDetails.exception?.description)
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

// Stand-ins for what the demo cannot have, read from the flags each
// picture sets before it loads the page.
const BOOT = `(function () {
  var flags = {}; try { flags = JSON.parse(localStorage.getItem('ax-demo') || '{}') } catch (e) {}
  // No viewer to connect to: the peer connection reports "connected" by itself.
  function PC() { var pc = this; pc.connectionState = 'new'; setTimeout(function () { pc.connectionState = 'connected'; if (pc.onconnectionstatechange) pc.onconnectionstatechange() }, 400) }
  PC.prototype.addTrack = function () {}; PC.prototype.close = function () {}; PC.prototype.getSenders = function () { return [] }
  PC.prototype.setRemoteDescription = PC.prototype.setLocalDescription = PC.prototype.addIceCandidate = function () { return Promise.resolve() }
  PC.prototype.createAnswer = function () { return Promise.resolve({ sdp: '' }) }
  window.RTCPeerConnection = PC;
  // Notifications already on: a push subscription the demo computer knows.
  if (flags.pushOn && window.ServiceWorkerContainer) {
    var sub = { endpoint: 'https://push.example/demo', toJSON: function () { return { endpoint: this.endpoint, keys: {} } }, unsubscribe: function () { return Promise.resolve(true) } };
    var reg = { pushManager: { getSubscription: function () { return Promise.resolve(sub) }, subscribe: function () { return Promise.resolve(sub) } } };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: function () { return Promise.resolve(reg) }, configurable: true });
    try { localStorage.setItem('ax-push-key', 'demo-key') } catch (e) {}
  }
  // The scanner's camera shows a QR code that is not a pairing code.
  if (flags.qr && navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = function () {
      var c = document.createElement('canvas'); c.width = 390; c.height = 844;
      var ctx = c.getContext('2d'), img = new Image(); img.src = flags.qr;
      var stream = c.captureStream(10), track = stream.getVideoTracks()[0];
      function paint() { ctx.fillStyle = '#8a8a8a'; ctx.fillRect(0, 0, 390, 844); if (img.complete) ctx.drawImage(img, 35, 262, 320, 320); if (track.requestFrame) track.requestFrame() }
      paint(); setInterval(paint, 100);
      return Promise.resolve(stream)
    }
  }
  // Opened from the AgentX Android app (the Places card links to its settings).
  if (flags.shell) { try { localStorage.setItem('ax-shell', 'android') } catch (e) {} }
  // The camera permission was refused.
  if (flags.noCamera && navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = function () { var e = new Error('Permission denied'); e.name = 'NotAllowedError'; return Promise.reject(e) }
  }
})();`

const profile = mkdtempSync(join(tmpdir(), "agentx-docs-phone-"))
const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "about:blank",
], { stdio: "ignore" })
let launchError
chrome.on("error", (e) => { launchError = e })
let ws
try {
  const portFile = join(profile, "DevToolsActivePort")
  for (let i = 0; !existsSync(portFile) && i < 100; i++) { if (launchError) throw launchError; await sleep(100) }
  if (!existsSync(portFile)) throw new Error("Chrome did not start; check local process permissions")
  const port = readFileSync(portFile, "utf8").split("\n")[0]
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }) })
  const cdp = client(ws)
  const ev = async (expression) => {
    const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ": " + (r.exceptionDetails.exception?.description || ""))
    return r.result?.value
  }
  // Waits for a selector, or (prefixed "js:") for an expression to be true.
  const wait = async (what) => {
    const test = what.startsWith("js:") ? what.slice(3) : `!!document.querySelector(${JSON.stringify(what)})`
    for (let i = 0; i < 200; i++) {
      if (await ev(test)) return
      await sleep(100)
    }
    throw new Error(`Still waiting for: ${what}`)
  }
  const click = async (selector) => { await wait(selector); await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.click() })()`) }
  const type = async (selector, text) => { await wait(selector); await ev(`document.querySelector(${JSON.stringify(selector)}).focus()`); await cdp("Input.insertText", { text }) }
  const key = async (k) => {
    const code = { Escape: 27, ArrowRight: 39, Home: 36 }[k]
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code })
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k })
  }
  const scene = async (s) => { await fetch(base + "/__scene", { method: "POST", body: JSON.stringify(s) }) }
  const reset = async () => { await fetch(base + "/__reset", { method: "POST" }) }
  // Loads a page with the phone's remembered settings: the conversation on
  // screen, the theme, typing mode, and the demo's stand-in flags.
  const open = async (path, o = {}) => {
    await cdp("Page.navigate", { url: base + "/app/sw.js" })
    await sleep(150)
    await ev(`(() => {
      localStorage.clear();
      localStorage.setItem('ax-theme', ${JSON.stringify(o.theme || "light")});
      ${o.conv ? `localStorage.setItem('ax-chat-conv', JSON.stringify(${JSON.stringify(o.conv)}));` : ""}
      ${o.typing ? "localStorage.setItem('ax-voice-typing', '1');" : ""}
      localStorage.setItem('ax-demo', ${JSON.stringify(JSON.stringify(o.flags || {}))});
    })()`)
    await cdp("Page.navigate", { url: base + path })
    await sleep(400)
    if (o.conv) await wait("#cx-log .cx-msg")
    await sleep(300)
  }
  const tab = async (name, ready) => { await click("#tab-" + name); await wait(ready); await sleep(300) }
  // The Alerts card reads the push subscription once the service worker is ready.
  const alerts = async (ready) => {
    await ev("Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 10000))]).then(() => true)")
    await tab("alerts", ready)
  }
  const shot = async (name) => {
    await ev("document.fonts.ready")
    // Pictures the agent made must have arrived.
    await wait("js:[...document.images].every(i => i.complete)")
    await sleep(150)
    const { data } = await cdp("Page.captureScreenshot", { format: "png" })
    writeFileSync(resolve(out, `${name}.png`), Buffer.from(data, "base64"))
    console.log(`Captured ${name}`)
  }
  // The chat's microphone, replaced by a recording that is always "heard".
  const fakeMic = `AXVoiceIO.canRecord = () => true; AXVoiceIO.unlock = () => {}; AXVoiceIO.record = () => Promise.resolve({ level: () => 0.4, stop: (keep) => Promise.resolve(keep ? { blob: new Blob(['demo'], { type: 'audio/webm' }), ms: 500 } : null) })`
  const orb = (type) => ev(`document.querySelector('#vx-orb').dispatchEvent(new PointerEvent('${type}', { button: 0, pointerId: 1, bubbles: true }))`)
  const camera = async (peer) => {
    await click("#cam-btn")
    await wait("js:!document.querySelector('#cam-pick').hidden")
    await ev(`(() => { const s = document.querySelector('#cam-peer'); s.value = ${JSON.stringify(peer)}; s.dispatchEvent(new Event('change')) })()`)
  }
  const stopCamera = async () => { await click("#cam-stop"); await wait("#cam-live[hidden]"); await click("#cam-close") }
  const qr = await QRCode.toDataURL("https://example.com/menu", { width: 320, margin: 0, color: { light: "#8a8a8aff" } })

  const shots = {
    // --- The app ---
    "app-light": async () => { await open("/app", { conv: "cdemo" }); await shot("app-light") },
    "app-dark": async () => { await open("/app", { conv: "cdemo", theme: "dark" }); await shot("app-dark") },
    // --- Chat ---
    "chat": async () => { await open("/app", { conv: "cweekly" }); await wait(".cx-ui-btn"); await shot("chat") },
    "chat-strip": async () => { await open("/app", { conv: "cdemo" }); await wait(".cs-chip"); await shot("chat-strip") },
    "chat-finish-banner": async () => {
      await open("/app", { conv: "cdemo" })
      await wait(".cs-chip")
      await scene({ support: "done" })
      await ev("AXStrip.poll()")
      await wait(".cs-banner")
      await sleep(200)
      await shot("chat-finish-banner")
      await scene({ support: "thinking" })
    },
    "chat-picker": async () => { await open("/app", { conv: "cdemo" }); await click("#cx-pick"); await wait("#cx-picker button"); await sleep(200); await shot("chat-picker"); await key("Escape") },
    "chat-history": async () => { await open("/app", { conv: "cdemo" }); await click("#cx-history-btn"); await wait("#cx-history button"); await sleep(200); await shot("chat-history"); await key("Escape") },
    "chat-media": async () => { await open("/app", { conv: "corders" }); await wait(".cx-pic img"); await shot("chat-media") },
    "chat-media-viewer": async () => { await open("/app", { conv: "corders" }); await click(".cx-pic"); await wait(".cx-viewer:not([hidden]) img"); await sleep(200); await shot("chat-media-viewer"); await key("Escape") },
    // --- Voice ---
    "voice-typing": async () => { await open("/app", { conv: "cdemo", typing: true }); await type("#cx-input", "Make the photos smaller on the blog too"); await ev("document.activeElement.blur()"); await shot("voice-typing") },
    "voice-listening": async () => {
      await open("/app", { conv: "cdemo" })
      await ev(fakeMic)
      await orb("pointerdown")
      await wait("js:AXVoice.state() === 'listening'")
      await sleep(300)
      await shot("voice-listening")
      await orb("pointerup")
      await wait("js:AXVoice.state() === 'idle'")
    },
    "voice-thinking": async () => {
      await open("/app", { conv: "cdemo" })
      await scene({ slow: true })
      await ev(fakeMic)
      await orb("pointerdown"); await sleep(400); await orb("pointerup")
      await wait("js:AXVoice.state() === 'thinking' && !document.querySelector('#cx-stop').hidden")
      await sleep(300)
      await shot("voice-thinking")
      await click("#cx-stop")
      await scene({ slow: false })
    },
    "voice-speaking": async () => { await open("/app", { conv: "cdemo" }); await ev("AXVoice.show('speaking')"); await sleep(200); await shot("voice-speaking"); await ev("AXVoice.show('idle')") },
    // --- Fleet and Activity ---
    "fleet": async () => { await open("/app"); await tab("fleet", "#panel-fleet .fx-card"); await shot("fleet") },
    "fleet-schedule-sheet": async () => {
      await open("/app"); await tab("fleet", "#panel-fleet .fx-card")
      await click("#panel-fleet details summary"); await click('[data-act="cron"]')
      await wait(".fx-sheet[open]"); await sleep(200); await shot("fleet-schedule-sheet"); await key("Escape")
    },
    "activity-dark": async () => { await open("/app", { theme: "dark" }); await tab("activity", "#panel-activity .fx-card"); await shot("activity-dark") },
    // --- Alerts ---
    "alerts": async () => { await scene({ push: "off" }); await open("/app"); await alerts("#al-btn:not([hidden])"); await shot("alerts") },
    "alerts-chat-finish": async () => {
      await scene({ push: "on" }); await open("/app", { flags: { pushOn: true } })
      await alerts("js:(() => document.querySelector('#al-pill').textContent === 'On')()"); await shot("alerts-chat-finish")
    },
    "alerts-announcements": async () => {
      await scene({ push: "on", announcements: "two" }); await open("/app", { flags: { pushOn: true } })
      await alerts("#an-list li p"); await wait("js:(() => document.querySelector('#al-pill').textContent === 'On')()"); await shot("alerts-announcements")
    },
    // --- Places ---
    "places": async () => {
      await scene({ push: "on" }); await open("/app", { flags: { pushOn: true, shell: true } })
      await alerts("#pl-list .pl-place"); await ev("document.querySelector('#pl-card').scrollIntoView()"); await sleep(200); await shot("places")
    },
    "places-reminder": async () => {
      await scene({ push: "on" }); await open("/app", { flags: { pushOn: true, shell: true } })
      await alerts("#pl-list .pl-place"); await click("#pl-list .pl-place:nth-child(2) .pl-more summary")
      await type('#pl-list .pl-place:nth-child(2) input[name="text"]', "Return the borrowed books")
      await ev("document.activeElement.blur(); document.querySelector('#pl-list .pl-place:nth-child(2)').scrollIntoView()"); await sleep(200); await shot("places-reminder")
    },
    "places-add": async () => {
      await scene({ push: "on" }); await open("/app", { flags: { pushOn: true, shell: true } })
      await alerts("#pl-list .pl-place"); await click("#pl-add-wrap summary")
      await type('#pl-add input[name="name"]', "Sports hall"); await type('#pl-add input[name="coords"]', "48.8530, 2.3499")
      await ev("document.activeElement.blur(); document.querySelector('#pl-add-wrap').scrollIntoView()"); await sleep(200); await shot("places-add")
    },
    // --- Share camera ---
    "camera-sheet": async () => { await open("/app", { conv: "cdemo" }); await camera("Workshop"); await sleep(200); await shot("camera-sheet"); await click("#cam-close") },
    "camera-agent-pick": async () => { await open("/app", { conv: "cdemo" }); await camera("bot:helper"); await sleep(200); await shot("camera-agent-pick"); await click("#cam-close") },
    "camera-live": async () => {
      await open("/app", { conv: "cdemo" }); await camera("Workshop"); await click("#cam-start")
      await wait("js:(() => document.querySelector('#cam-msg').textContent.includes('is watching'))()"); await sleep(600)
      await shot("camera-live"); await stopCamera()
    },
    "camera-agent-reply": async () => {
      await open("/app", { conv: "cdemo" }); await camera("bot:helper"); await click("#cam-start")
      await wait("js:(() => document.querySelector('#cam-msg').textContent.includes('can see the camera'))()")
      await type("#cam-note", "What is plugged into the switch?"); await click("#cam-look")
      await wait("#cam-reply:not([hidden]) div"); await ev("document.activeElement.blur()"); await sleep(600)
      await shot("camera-agent-reply"); await stopCamera()
    },
    "camera-ask-bar": async () => { await scene({ ask: true }); await open("/app", { conv: "cdemo" }); await wait("#cam-ask-bar:not([hidden])"); await shot("camera-ask-bar"); await scene({ ask: false }) },
    "camera-ask-live": async () => {
      await scene({ ask: true }); await open("/app", { conv: "cdemo" }); await wait("#cam-ask-bar:not([hidden])")
      await click("#cam-ask-show")
      await wait("js:(() => document.querySelector('#cam-msg').textContent.includes('can see the camera'))()"); await sleep(600)
      await shot("camera-ask-live"); await stopCamera(); await scene({ ask: false })
    },
    // --- Pairing ---
    "not-paired": async () => {
      await scene({ locked: true }); await open("/app/locked"); await wait("#scan-btn:not([hidden])")
      await type("#pair-code", "abcdefgh"); await wait("js:(() => document.querySelector('#pair-code').value === 'ABCD-EFGH')()")
      await shot("not-paired")
    },
    "pair-code-too-many": async () => {
      await scene({ locked: true, pair: "too-many" }); await open("/app/locked")
      await type("#pair-code", "7kq4m2xh"); await click("#pair-btn"); await wait("#pair-msg.bad"); await ev("document.activeElement.blur()")
      await shot("pair-code-too-many"); await scene({ pair: "ok" })
    },
    "scan-camera-denied": async () => {
      await scene({ locked: true }); await open("/app/locked", { flags: { noCamera: true } })
      await click("#scan-btn"); await wait("#scan-msg.bad"); await sleep(200); await shot("scan-camera-denied"); await click("#scan-close")
    },
    "scan-not-agentx": async () => {
      await scene({ locked: true }); await open("/app/locked", { flags: { qr } })
      await click("#scan-btn"); await wait("#scan-msg.bad"); await sleep(300); await shot("scan-not-agentx"); await click("#scan-close")
    },
  }

  await cdp("Page.enable")
  await cdp("Runtime.enable")
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: BOOT })
  // The caret never shows, and nothing moves: every picture is the same twice.
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*{caret-color:transparent!important}'; document.head.append(s) })" })
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: true })
  // Headless Chrome refuses notifications; the Alerts tab reads that permission.
  await cdp("Browser.grantPermissions", { origin: base, permissions: ["notifications"] })
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  mkdirSync(out, { recursive: true })
  const requested = process.env.DOCS_SHOTS?.split(",")
  const selected = requested ? requested.filter((n) => shots[n]) : Object.keys(shots)
  if (!selected.length) throw new Error("No matching DOCS_SHOTS")
  for (const name of selected) {
    await reset()
    await shots[name]()
  }
  await reset()
} finally {
  ws?.close()
  chrome.kill("SIGTERM")
  fixture?.kill("SIGTERM")
  await sleep(1000)
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL")
  rmSync(profile, { recursive: true, force: true })
}
