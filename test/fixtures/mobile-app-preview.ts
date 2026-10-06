// Isolated UI fixture for the phone app: binds only loopback and never
// calls an agent, a device or a real daemon. Neutral names only.
//
// Start: pnpm exec tsx test/fixtures/mobile-app-preview.ts
// Used by scripts/check-mobile-ui.mjs (regression checks) and
// docs/.scripts/capture-mobile.mjs (the docs screenshots).
//
// Scenes: POST /__scene with a JSON object switches what the API answers,
// so one server shows every state the docs picture (see `scene` below).
// POST /__reset puts everything back.
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { renderAppLockedPage, renderAppPage } from "../../src/daemon/ui/pages/app"

const now = Date.now(),
  ts = new Date(now).toISOString()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

// --- Conversations ---
const website = {
  id: "cdemo",
  node: "local",
  nodeName: "Studio",
  agent: "helper",
  agentName: "Helper",
  title: "Website build",
  updatedAt: now,
  messages: [
    { role: "user", content: "Why is the website build slow today?" },
    {
      role: "assistant",
      content:
        "Most of the time goes to the photo step. It got slower after yesterday’s update.\n\n```sh\nnpm run build -- --optimize-images --quality 90 --width 2400 ./public/photos/*.jpg\n```\n\n| Step | Today | Yesterday | Change |\n|---|---|---|---|\n| Photos | 48 seconds | 17 seconds | 31 seconds slower |\n| Scripts | 12 seconds | 11 seconds | 1 second slower |\n\nI can make the photos smaller. Shall I?",
    },
    { role: "user", content: "Yes, go ahead. Tell me the new time." },
    { role: "assistant", content: "Done. The photo step now takes 18 seconds." },
  ],
}
// An answer with tools, a link button and a poll (the agentx:ui extras).
const weekly = {
  id: "cweekly",
  node: "local",
  nodeName: "Studio",
  agent: "helper",
  agentName: "Helper",
  title: "Weekly summary",
  updatedAt: now - 3600000,
  messages: [
    { role: "user", content: "Send me the weekly summary." },
    {
      role: "assistant",
      content:
        "**Week 40 in short:** 14 support threads closed, 2 waiting on the customer, and the response time is down to 3 hours. Nothing needs you today.\n\nThe full report is ready. Shall I send it to the team?",
      tools: [
        { id: "t1", name: "read_file", arg: "reports/week-40.md" },
        { id: "t2", name: "sql", arg: "support threads this week" },
      ],
      ui: {
        buttons: [{ label: "Open the report", url: "https://example.com/reports/week-40" }],
        poll: { question: "Send it to the team?", options: ["Yes, now", "Monday morning", "Not this week"] },
      },
    },
  ],
}
// Files the agent made: a chart under the answer, and a PDF to open.
const CHART_ID = "0123456789abcdef0123456789abcdef"
const PDF_ID = "fedcba9876543210fedcba9876543210"
const orders = {
  id: "corders",
  node: "local",
  nodeName: "Studio",
  agent: "helper",
  agentName: "Helper",
  title: "Orders this week",
  updatedAt: now - 7200000,
  messages: [
    { role: "user", content: "Show me this week’s orders as a chart." },
    {
      role: "assistant",
      content: "I saved the chart and a summary in my workspace. Friday was the busiest day.",
      files: [
        { id: CHART_ID, name: "orders-per-day.svg", kind: "image" },
        { id: PDF_ID, name: "orders-summary.pdf", kind: "file" },
      ],
    },
  ],
}
const bars = [
  ["Mon", 42], ["Tue", 55], ["Wed", 38], ["Thu", 61], ["Fri", 70], ["Sat", 48], ["Sun", 33],
] as const
const chartSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" font-family="system-ui, sans-serif">` +
  `<rect width="640" height="360" fill="#fff"/><text x="24" y="36" font-size="20" font-weight="600" fill="#0b0d10">Demo shop: orders per day</text>` +
  bars
    .map(([day, n], i) => {
      const x = 48 + i * 82, h = n * 3.6, y = 310 - h
      return `<rect x="${x}" y="${y}" width="56" height="${h}" rx="4" fill="#1f66e5"/><text x="${x + 28}" y="${y - 8}" font-size="15" text-anchor="middle" fill="#5a616c">${n}</text><text x="${x + 28}" y="336" font-size="15" text-anchor="middle" fill="#5a616c">${day}</text>`
    })
    .join("") +
  `</svg>`
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")

const conversations: Record<string, any> = { cdemo: website, cweekly: weekly, corders: orders }
const original = structuredClone(conversations)

const agents = [
  { id: "helper", name: "Helper", active: 1, busy: true, running: 1, errors: 0, last: { ok: true, text: "Making the photos smaller." } },
  { id: "support", name: "Support", active: 0, busy: false, errors: 0 },
]

// --- Scenes ---
const defaults = {
  // The other conversation: "thinking" (strip chip) or "done" (its finish banner).
  support: "thinking" as "thinking" | "done",
  // Notifications on this phone: "na" (not set up), "off" (Turn on), "on" (Turn off).
  push: "na" as "na" | "off" | "on",
  // Announcements: none, or two recent ones with the notify switch.
  announcements: "none" as "none" | "two",
  // An agent asking to see through the camera.
  ask: false,
  // What the microphone "heard" (speech to text answers this).
  heard: "Voice test message",
  // The pairing page: the phone is not known, and the code may be rate limited.
  locked: false,
  pair: "ok" as "ok" | "too-many",
  // A sent message takes 15 seconds to answer, to show the thinking state.
  slow: false,
}
let scene = { ...defaults }
// Keep watching on the camera sheet: when it stops by itself.
let streamUntil = 0

function api(path: string): any {
  switch (path) {
    case "/api/app/me":
      return scene.locked ? 401 : { device: "Demo phone", node: "Studio" }
    case "/api/app/agents":
      return { nodes: [{ name: "Studio", target: "local", online: true, agents }, { name: "Workshop", target: "peer", online: false, agents: [] }] }
    case "/api/app/conversations":
      return { conversations: Object.values(conversations).map((c) => ({ ...c, messages: undefined })) }
    case "/api/app/chat/active":
      // The one on screen gets its chip from the phone itself.
      return {
        conversations: [
          scene.support === "done"
            ? { id: "cother", agentName: "Support", agent: "support", nodeName: "Studio", state: "done", status: "done", updatedAt: now, title: "Release notes", preview: "Release notes drafted: faster checkout, a fix for the retry loop, and clearer error messages." }
            : { id: "cother", agentName: "Support", agent: "support", nodeName: "Studio", state: "thinking", title: "Release notes" },
        ],
      }
    case "/api/app/fleet":
      return {
        ts,
        nodes: [
          {
            name: "Studio", url: "local", reachable: true, uptimeSec: 36000, agents,
            crons: {
              today: { success: 4, failed: 0 },
              items: [{ id: "Morning summary", enabled: true, schedule: "0 9 * * *", agent: "helper", last: { status: "success", text: "Summary delivered." } }],
            },
          },
          { name: "Workshop", url: "peer", reachable: false, agents: [], error: "Connection lost" },
        ],
      }
    case "/api/app/activity":
      return { ts, tasks: [{ taskId: "t1", agentName: "Helper", node: "local", nodeName: "Studio", channel: "app", startedAt: ts, preview: "Making the website photos smaller." }] }
    case "/api/app/approvals":
      return { nodes: [{ node: "local", nodeName: "Studio", items: [{ key: "a1", title: "Review the draft", ask: "Is this ready to share?", recommend: "Read the changes first", raisedBy: "Support" }] }] }
    case "/api/app/push":
      return scene.push === "na"
        ? { available: false, reason: "Notifications are off in this demo." }
        : { available: true, publicKey: "demo-key", subscriptions: scene.push === "on" ? 1 : 0, chatFinish: true }
    case "/api/app/alerts":
      return {
        items: [
          { id: 1, at: now, title: "Website update ready", body: "The photo step is faster. Open the conversation to see the result.", url: "/app#chat=cdemo" },
          { id: 2, at: now - 180000, title: "Workshop offline", body: "This computer stopped answering. The rest of the fleet still works." },
        ],
      }
    case "/api/app/announcements":
      return scene.announcements === "two"
        ? {
            notifyAvailable: true, notify: true,
            items: [
              { text: "Maintenance tonight at 22:00. Agents pause for ten minutes.", by: "Helper", node: "Studio", at: iso(120000) },
              { text: "The new label printer is set up in the workshop.", node: "Workshop", at: iso(5400000) },
            ],
          }
        : { items: [], notify: false }
    case "/api/app/camera/asks":
      return { asks: scene.ask ? [{ id: "cam-ask-demo", agentId: "helper", reason: "Show me the switch at the top of the rack" }] : [] }
    case "/api/app/camera/config":
      return {
        peers: [{ name: "Workshop" }], agents: [{ id: "helper", name: "Helper" }],
        camera: { width: 1280, height: 720, frameRate: 15, maxSeconds: 600, voiceInput: true, speakAnswers: true, bot: { maxSessionMinutes: 10, streamMaxSeconds: 60 } },
      }
    case "/api/app/camera/watch":
      return { watch: { replies: [], streamUntil: streamUntil > Date.now() ? streamUntil : null } }
    case "/api/app/places":
      return {
        enabled: true, reason: null, pushAvailable: true, pushReason: null,
        limits: { defaultRadiusMeters: 150, minRadiusMeters: 100, maxRadiusMeters: 5000, maxPlaces: 50 },
        syncMinutes: 60, android: { packageName: "dev.agentx.phone" }, agents: ["helper", "support"],
        places: [
          { id: "pl_demo00school", name: "School", lat: 48.8584, lng: 2.2945, radius: 200, createdAt: iso(86400000) },
          { id: "pl_demo0library", name: "Library", lat: 48.8606, lng: 2.3376, radius: 150, createdAt: iso(86400000) },
        ],
        rules: [
          { id: "pr_demo00000001", placeId: "pl_demo00school", on: "enter", text: "Pick up the parcel at the front desk", repeat: false, enabled: true, createdAt: iso(3600000) },
          { id: "pr_demo00000002", placeId: "pl_demo00school", on: "exit", text: "What is left on today's list?", agent: "helper", repeat: true, enabled: true, createdAt: iso(3600000) },
        ],
      }
  }
  const conv = /^\/api\/app\/conversations\/([a-z0-9]+)$/.exec(path)
  if (conv) return conversations[conv[1]] || 404
  return 404
}

const require = createRequire(import.meta.url)
const jsqr = readFileSync(require.resolve("jsqr/dist/jsQR.js"))

createServer(async (req, res) => {
  const path = req.url!.split("?")[0]
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  }
  const read = async () => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    return raw ? JSON.parse(raw) : {}
  }
  if (path === "/__reset") {
    for (const id of Object.keys(conversations)) conversations[id] = structuredClone(original[id])
    scene = { ...defaults }
    res.end("ok")
    return
  }
  if (path === "/__scene" && req.method === "POST") {
    Object.assign(scene, await read())
    json(200, scene)
    return
  }
  if (path === "/app") {
    res.setHeader("Content-Type", "text/html")
    res.end(renderAppPage())
    return
  }
  // The real daemon serves this page at /app with a 401; here it has its
  // own address so both can be shown.
  if (path === "/app/locked") {
    res.setHeader("Content-Type", "text/html")
    res.end(renderAppLockedPage())
    return
  }
  // A service worker that does nothing: enough for the Push API's checks.
  if (path === "/app/sw.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/app" })
    res.end("// demo: no caching\n")
    return
  }
  if (path === "/app/qr.js") {
    res.setHeader("Content-Type", "text/javascript")
    res.end(jsqr)
    return
  }
  if (path === "/api/app/files/" + CHART_ID) {
    res.setHeader("Content-Type", "image/svg+xml")
    res.end(chartSvg)
    return
  }
  if (path === "/api/app/files/" + PDF_ID) {
    res.setHeader("Content-Type", "application/pdf")
    res.end(pdf)
    return
  }
  if (path === "/api/app/chat" && req.method === "POST") {
    const body = await read()
    // A first message with no conversation yet lands in the demo's main one.
    const conv = conversations[body.conversationId] || conversations.cdemo
    conv.messages.push({ role: "user", content: body.message }, { role: "assistant", content: "Demo answer received." })
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    res.write("event: conversation\ndata: " + JSON.stringify({ ...conv, messages: conv.messages.slice(0, -1) }) + "\n\n")
    const finish = () => res.end("event: final\ndata: " + JSON.stringify({ content: "Demo answer received.", status: "done" }) + "\n\n")
    if (scene.slow) setTimeout(finish, 15000)
    else finish()
    return
  }
  if (path === "/api/app/voice/transcribe") {
    json(200, { text: scene.heard })
    return
  }
  if (path === "/api/app/pair-code" && req.method === "POST") {
    if (scene.pair === "too-many") json(429, { error: "Too many attempts", retryAfter: 240 })
    else json(401, { error: "That code didn't work" })
    return
  }
  if (path === "/api/app/push/prefs" && req.method === "POST") {
    json(200, { chatFinish: true, announce: true, ...(await read()) })
    return
  }
  // The camera's signalling: the phone rings, and this demo never offers a
  // real connection (the screenshots stub the peer connection instead).
  if (path === "/api/app/camera/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    res.write("event: ready\ndata: {}\n\n")
    req.on("close", () => res.end())
    return
  }
  if (path === "/api/app/camera/look" && req.method === "POST") {
    const body = await read()
    json(200, {
      reply: {
        text: "I can see a metal rack with a network switch at the top. Two cables are plugged into the first two ports and the third port is empty. The label on the switch reads SW-01.",
        note: body.note || "",
        at: Date.now(),
      },
    })
    return
  }
  if (path === "/api/app/camera/stream" && req.method === "POST") {
    const body = await read()
    streamUntil = body.seconds > 0 ? Date.now() + body.seconds * 1000 : 0
    json(200, { watch: { streamUntil: streamUntil || null } })
    return
  }
  if (req.method === "POST") {
    console.log(path)
    json(200, { ok: true })
    return
  }
  const out = api(path)
  if (out === 404) {
    res.writeHead(404)
    res.end()
    return
  }
  if (out === 401) {
    json(401, { error: "not paired" })
    return
  }
  json(200, out)
}).listen(18948, "127.0.0.1", () => console.log("Preview http://127.0.0.1:18948/app"))
