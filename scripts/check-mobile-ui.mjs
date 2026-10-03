// Browser regression check against the loopback-only mobile fixture, never a live fleet.
// Start: pnpm exec tsx test/fixtures/mobile-app-preview.ts
// Then: node scripts/check-mobile-ui.mjs (Node 22+, Chrome CDP on 9222).
// Evidence screenshots are written to /tmp/488-evidence.
import { writeFileSync, mkdirSync } from "node:fs"
import assert from "node:assert/strict"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await fetch("http://127.0.0.1:18948/__reset", { method: "POST" })
const target = await (
  await fetch("http://127.0.0.1:9222/json/new?http://127.0.0.1:18948/app", {
    method: "PUT",
  })
).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener("open", r, { once: true }))
let id = 0
const pending = new Map(),
  errors = []
ws.addEventListener("message", ({ data }) => {
  let m = JSON.parse(data)
  if (m.method === "Runtime.exceptionThrown")
    errors.push(m.params.exceptionDetails.exception?.description)
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    m.error ? p.reject(m.error) : p.resolve(m.result)
  }
})
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const ev = async (expression) => {
  let r = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description)
  return r.result.value
}
const click = (s) =>
  ev(
    `(()=>{let e=document.querySelector(${JSON.stringify(s)}); e.focus(); e.click()})()`,
  )
const check = async (s, msg) => assert(await ev(s), msg)
const key = async (key, code = key) => {
  await cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: key === "Escape" ? 27 : undefined,
  })
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code })
}
const shot = async (name) => {
  await ev("document.activeElement.blur()")
  await sleep(120)
  let { data } = await cdp("Page.captureScreenshot", { format: "png" })
  writeFileSync(
    "/tmp/488-evidence/" + name + ".png",
    Buffer.from(data, "base64"),
  )
}
mkdirSync("/tmp/488-evidence", { recursive: true })
await cdp("Runtime.enable")
await cdp("Page.enable")
await cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
})
await cdp("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
})
await ev(
  `localStorage.setItem('ax-chat-conv',JSON.stringify('cdemo'));localStorage.setItem('ax-theme','light');localStorage.removeItem('ax-alerts-read');localStorage.removeItem('ax-voice-typing')`,
)
await cdp("Page.navigate", { url: "http://127.0.0.1:18948/app" })
await sleep(1000)
await ev("document.querySelector('#tab-chat').focus()")
await key("ArrowRight")
await sleep(250)
await check(
  "!!document.querySelector('#panel-fleet .fx-card')",
  "keyboard loads fleet on first visit",
)
await key("Home")
for (const [w, h] of [
  [390, 844],
  [320, 568],
  [430, 932],
  [360, 800],
]) {
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: true,
  })
  for (const theme of ["light", "dark"]) {
    await ev(`document.documentElement.setAttribute('data-theme','${theme}')`)
    for (const tab of ["chat", "fleet", "activity", "alerts"]) {
      await click("#tab-" + tab)
      await sleep(300)
      await check(
        `document.documentElement.scrollWidth<=innerWidth && document.body.scrollHeight<=innerHeight+1`,
        "overflow " + w + theme + tab,
      )
      await check(
        `(()=>{let r=document.querySelector('.tabs').getBoundingClientRect();return r.bottom<=innerHeight+1})()`,
        "tabs visible",
      )
      if (tab === "chat")
        await check(
          `(()=>{let r=document.querySelector('#vx-orb').getBoundingClientRect();return r.width===96&&Math.abs(r.x+r.width/2-innerWidth/2)<1&&r.top>0&&r.bottom<innerHeight-56})()`,
          "centered orb",
        )
      if (w === 390) await shot(tab + "-" + theme)
    }
  }
}
await cdp("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
})
await ev(`document.documentElement.setAttribute('data-theme','light')`)
await click("#tab-chat")
await ev(`document.querySelector('#tab-chat').focus()`)
await key("ArrowRight")
await check(
  `document.querySelector('#tab-fleet').getAttribute('aria-selected')==='true'`,
  "arrow tabs",
)
await key("End")
await check(
  `document.querySelector('#tab-alerts').getAttribute('aria-selected')==='true'`,
  "end tab",
)
await key("Home")
await click("#cx-pick")
await sleep(100)
await check(`document.querySelector('#cx-dialog').open`, "picker opens")
await shot("chat-picker")
await key("Escape")
await check(
  `!document.querySelector('#cx-dialog').open && document.activeElement.id==='cx-pick'`,
  "escape restores focus",
)
await click("#cx-history-btn")
await sleep(120)
await shot("chat-history")
await click("#cx-sheet-done")
await click("#cx-pick")
await sleep(120)
await click('#cx-picker button[data-a="0"]')
await sleep(100)
await check(
  `!document.querySelector('#cx-dialog').open && AXChat.target().agent==='helper'`,
  "pick agent",
)
await click("#cx-pick")
await sleep(100)
let box = await ev(
  `(()=>{let r=document.querySelector('.sheet-handle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
)
await cdp("Input.dispatchMouseEvent", {
  type: "mousePressed",
  x: box.x,
  y: box.y,
  button: "left",
  clickCount: 1,
})
await cdp("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: box.x,
  y: box.y + 100,
  button: "left",
})
await cdp("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: box.x,
  y: box.y + 100,
  button: "left",
  clickCount: 1,
})
await check(`!document.querySelector('#cx-dialog').open`, "pull dismiss")
await click("#vx-keys")
await ev(`document.querySelector('#cx-input').value='Typed test message'`)
await shot("voice-typing")
await click("#cx-send")
await sleep(300)
await check(
  `document.querySelector('#cx-log').textContent.includes('Demo answer received.')`,
  "typed streaming reply",
)
await click("#vx-keys")
await ev(
  `AXVoiceIO.canRecord=()=>true;AXVoiceIO.unlock=()=>{};AXVoiceIO.record=()=>Promise.resolve({level:()=>.4,stop:keep=>Promise.resolve(keep?{blob:new Blob(['demo'],{type:'audio/webm'}),ms:500}:null)})`,
)
await ev(
  `document.querySelector('#vx-orb').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,bubbles:true}))`,
)
await sleep(450)
await check(`AXVoice.state()==='listening'`, "voice hold")
await shot("voice-listening")
await ev(
  `document.querySelector('#vx-orb').dispatchEvent(new PointerEvent('pointerup',{pointerId:1,bubbles:true}))`,
)
await sleep(400)
await check(
  `document.querySelector('#cx-log').textContent.includes('Voice test message')`,
  "voice send",
)
for (const state of ["thinking", "speaking"]) {
  await ev(`AXVoice.show('${state}')`)
  await shot("voice-" + state)
}
await ev(`AXVoice.show('idle')`)
await click("#tab-activity")
await sleep(300)
await click('[data-act="followup"]')
await shot("activity-followup")
await ev(
  `document.querySelector('#fx-input').value='Please check the images too.'`,
)
await click("#fx-ok")
await sleep(200)
await check(`!document.querySelector('.fx-sheet').open`, "followup sent")
await click("#tab-fleet")
await sleep(300)
await click("details summary")
await click('[data-act="cron"]')
await shot("fleet-schedule-sheet")
await key("Escape")
await click("#tab-alerts")
await sleep(150)
await check(
  `document.querySelector('#tab-alerts').classList.contains('has-unread')`,
  "unread dot",
)
await click("#al-list button")
await check(
  `document.querySelector('#tab-alerts').getAttribute('aria-label')==='Alerts, 1 unread'`,
  "read one",
)
await click("#al-read-all")
await check(
  `!document.querySelector('#tab-alerts').classList.contains('has-unread')`,
  "read all",
)
await cdp("Page.reload")
await sleep(500)
await check(
  `!document.querySelector('#tab-alerts').classList.contains('has-unread')`,
  "read persists",
)
await click("#tab-chat")
await ev(`window.dispatchEvent(new Event('offline'))`)
await shot("offline")
await check(`!document.querySelector('#offline').hidden`, "offline banner")
await ev(`window.dispatchEvent(new Event('online'))`)
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true })
await cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
})
await click("#tab-chat")
await cdp("Input.dispatchTouchEvent", {
  type: "touchStart",
  touchPoints: [{ x: 310, y: 280 }],
})
await cdp("Input.dispatchTouchEvent", {
  type: "touchMove",
  touchPoints: [{ x: 210, y: 283 }],
})
await sleep(30)
await cdp("Input.dispatchTouchEvent", {
  type: "touchMove",
  touchPoints: [{ x: 70, y: 284 }],
})
await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
await sleep(300)
await check(
  `document.querySelector('#tab-fleet').getAttribute('aria-selected')==='true'`,
  "touch swipe",
)
await click("#tab-chat")
await ev(`document.querySelector('#cx-log').scrollTop=0`)
await check(`document.querySelector('#an-card')`, "announcements retained")
await click("#cam-btn")
await sleep(200)
await shot("camera-sheet")
await check(
  "!document.querySelector('#cam-peer').hidden",
  "camera destination controls",
)
await ev(
  "document.querySelector('#cam-peer').value='bot:helper';document.querySelector('#cam-peer').dispatchEvent(new Event('change'))",
)
await shot("camera-agent-pick")
assert.deepEqual(errors, [])
console.log(
  "PASS: 32 viewport/theme/tab layouts; keyboard, sheets, typing, voice hold/send, follow-up, schedule, unread persistence, offline.",
)
ws.close()
