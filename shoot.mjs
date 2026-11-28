// Before (0.251.0, port 4292) and after (0.311.0, port 4291) shots of two scratch
// AgentX installs with demo agents only: Hub at 1440x900 and phone app at 390x844,
// light and dark, in headless Chrome over CDP.
// Usage: node shoot.mjs <afterPairCode> <beforePairCode>
import { spawn } from "child_process"
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "fs"
const dir = new URL(".", import.meta.url).pathname
const [afterCode, beforeCode] = process.argv.slice(2)
const SETS = [
  { name: "after", base: "http://127.0.0.1:4291", code: afterCode },
  { name: "before", base: "http://127.0.0.1:4292", code: beforeCode },
]
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const prof = dir + "chrome-profile"
rmSync(prof, { recursive: true, force: true })
const proc = spawn(CH, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--disable-extensions", "--renderer-process-limit=1", `--user-data-dir=${prof}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(dir + "out", { recursive: true })
try {
  let port
  for (let i = 0; i < 150 && !port; i++) { await sleep(100); if (existsSync(prof + "/DevToolsActivePort")) port = readFileSync(prof + "/DevToolsActivePort", "utf8").split("\n")[0] }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener("open", r))
  let id = 0; const pending = new Map(); const logs = []
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
    if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + d.params.exceptionDetails.exception?.description?.slice(0, 200)) })
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  await send("Runtime.enable")
  const ev = async (expression) => (await send("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression })).result.result?.value
  const go = async (url, wait = 4000) => { await send("Page.navigate", { url: "about:blank" }); await sleep(200); await send("Page.navigate", { url }); await sleep(wait) }
  const shoot = async (file) => {
    const shot = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(dir + "out/" + file + ".png", Buffer.from(shot.result.data, "base64"))
    console.log("shot", file)
  }
  for (const s of SETS) {
    // Phone session cookie from the one-time pairing code.
    await go(s.base + "/app/pair", 1500)
    console.log(s.name, "pair:", await ev(`fetch("/api/app/pair-code",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:${JSON.stringify(s.code)}})}).then(r=>r.status+" "+r.headers.get("content-type"))`))
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] })
      await go(s.base + "/hub", 500)
      await ev(`localStorage.setItem("ax-theme","${theme}");localStorage.setItem("ax-wall-theme","${theme}");1`)
      await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
      await go(s.base + "/hub", 5000)
      console.log(s.name, theme, "hub:", (await ev(`document.body.innerText.replace(/\\s+/g," ").slice(0,300)`)))
      await shoot(`desktop-hub-${theme}-1440-${s.name}`)
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
      await go(s.base + "/app", 5000)
      console.log(s.name, theme, "app:", (await ev(`document.body.innerText.replace(/\\s+/g," ").slice(0,300)`)))
      await shoot(`phone-app-${theme}-390-${s.name}`)
      if (s.name === "after") { // 0.311.0 opens on Agents; 0.251.0 opened on Chat. Shoot Chat too.
        console.log("chat tab:", await ev(`(()=>{const b=[...document.querySelectorAll("nav button, nav a, [role=tab]")].find(e=>e.textContent.trim()==="Chat");if(!b)return "no Chat tab";b.click();return "clicked"})()`))
        await sleep(2500)
        await shoot(`phone-chat-${theme}-390-${s.name}`)
      }
    }
  }
  console.log(logs.join("\n"))
  ws.close()
} finally { proc.kill(); await sleep(1500); rmSync(prof, { recursive: true, force: true }) }
