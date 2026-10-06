import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { cameraSignal, watchingAgent } from "../src/daemon/app-camera"
import { cameraConstraints, shareClock, streamLabel, talkRelease } from "../src/daemon/ui/pages/app-camera-logic"
import { CAMERA_SCRIPT } from "../src/daemon/ui/pages/app-camera.client"
import { CAMERA_ASKS_SCRIPT } from "../src/daemon/ui/pages/app-camera-asks.client"
import { renderAppPage } from "../src/daemon/ui/pages/app"
import { CALL_PAGE_HTML } from "../src/daemon/call-page"
import { ringNotice } from "../src/channels/webrtc-signal"

// The phone app's Share camera (#325): the dashboard routes that carry the
// phone's WebRTC signalling to the daemon, the phone's identity in them, the
// page wiring, and the watch-only link the other machine's owner gets. The
// daemon is a fake that records what reaches it.

const DAEMON_TOKEN = "daemon-secret"
const NODE = "Node-A"

interface Seen { method: string; path: string; auth?: string; body: string }
let seen: Seen[] = []
let reply: (req: IncomingMessage, res: ServerResponse) => void

let dir: string
let tokens: TokenStore
let daemon: Server
let app: Server
let base: string
let phone: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-app-camera-"))
  tokens = new TokenStore(dir)
  phone = tokens.create({ name: "Test phone", scopes: ["app"] }).token
  daemon = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    seen.push({ method: req.method || "", path: req.url || "", auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") })
    reply(req, res)
  })
  await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r))
  const camera = { daemon: { url: `http://127.0.0.1:${(daemon.address() as any).port}`, token: DAEMON_TOKEN }, nodeName: NODE }
  app = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    if (!(await handleAppRequest(req, res, path, req.method || "GET", { tokens, camera }))) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(app.address() as any).port}`
})

afterAll(async () => {
  await new Promise((r) => app.close(r))
  daemon.closeAllConnections?.()
  await new Promise((r) => daemon.close(r))
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  seen = []
  reply = (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}') }
})

const asPhone = (init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as any), Authorization: `Bearer ${phone}` } })
const signal = (body: unknown) => fetch(`${base}/api/app/camera/signal`, asPhone({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))

describe("app camera routes", () => {
  it("refuse a phone that is not paired", async () => {
    for (const p of ["/api/app/camera/config", "/api/app/camera/events?callId=cam-1234"]) {
      expect((await fetch(base + p)).status).toBe(401)
    }
    expect((await fetch(`${base}/api/app/camera/signal`, { method: "POST", body: "{}" })).status).toBe(401)
    expect(seen).toEqual([])
  })

  it("config lists the other machines, never this one, with the camera settings", async () => {
    reply = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        localName: NODE,
        iceServers: [{ urls: "stun:example" }],
        peers: [{ name: "node-a", healthy: true }, { name: "Node-B", healthy: true }],
        camera: { width: 640, height: 480, frameRate: 10, maxSeconds: 60 },
      }))
    }
    const r = await fetch(`${base}/api/app/camera/config`, asPhone())
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      node: NODE,
      iceServers: [{ urls: "stun:example" }],
      peers: [{ name: "Node-B", healthy: true }],
      agents: [],
      camera: { width: 640, height: 480, frameRate: 10, maxSeconds: 60 },
    })
    expect(seen[0]).toMatchObject({ path: "/webrtc/config", auth: `Bearer ${DAEMON_TOKEN}` })
  })

  it("config says plainly when calls are off", async () => {
    reply = (_req, res) => { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"WebRTC signaling not enabled"}') }
    const r = await fetch(`${base}/api/app/camera/config`, asPhone())
    expect(r.status).toBe(503)
    expect((await r.json()).error).toMatch(/channels\.webrtc\.enabled/)
  })

  it("signals always come from this node, whatever the phone sends", async () => {
    const r = await signal({ kind: "answer", callId: "cam-abcd1234", from: "Node-B", to: "Node-B", sdp: "v=0" })
    expect(r.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: "POST", path: "/webrtc/signal/out", auth: `Bearer ${DAEMON_TOKEN}` })
    expect(JSON.parse(seen[0].body)).toEqual({ kind: "answer", callId: "cam-abcd1234", from: NODE, to: "Node-B", sdp: "v=0" })
  })

  it("a ring is marked as a camera share", async () => {
    await signal({ kind: "ring", callId: "cam-abcd1234", to: "Node-B" })
    expect(JSON.parse(seen[0].body)).toEqual({ kind: "ring", callId: "cam-abcd1234", from: NODE, to: "Node-B", reason: "camera" })
  })

  it("refuses malformed signals before they reach the daemon", async () => {
    const bad = [
      { kind: "bogus", callId: "cam-abcd1234", to: "Node-B" },
      { kind: "ring", callId: "x", to: "Node-B" },
      { kind: "ring", callId: "cam abcd/../1", to: "Node-B" },
      { kind: "ring", callId: "cam-abcd1234", to: "" },
      { kind: "ring", callId: "cam-abcd1234", to: "node a" },
      { kind: "offer", callId: "cam-abcd1234", to: "Node-B" },
      { kind: "ice", callId: "cam-abcd1234", to: "Node-B", candidate: {} },
    ]
    for (const b of bad) expect((await signal(b)).status).toBe(400)
    expect((await fetch(`${base}/api/app/camera/signal`, asPhone({ method: "POST", body: "not json" }))).status).toBe(400)
    expect(seen).toEqual([])
  })

  it("passes on the daemon's refusal", async () => {
    reply = (_req, res) => { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"ok":false,"error":"forward to \\"Node-B\\" failed"}') }
    const r = await signal({ kind: "ring", callId: "cam-abcd1234", to: "Node-B" })
    expect(r.status).toBe(502)
    expect((await r.json()).error).toMatch(/Node-B/)
  })

  it("streams the daemon's signalling events as this node", async () => {
    reply = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write('event: ready\ndata: {}\n\n')
      res.end('event: signal\ndata: {"kind":"offer"}\n\n')
    }
    const r = await fetch(`${base}/api/app/camera/events?callId=cam-abcd1234`, asPhone())
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("text/event-stream")
    expect(await r.text()).toBe('event: ready\ndata: {}\n\nevent: signal\ndata: {"kind":"offer"}\n\n')
    expect(seen[0]).toMatchObject({ path: "/webrtc/events?callId=cam-abcd1234&as=Node-A", auth: `Bearer ${DAEMON_TOKEN}` })
    expect((await fetch(`${base}/api/app/camera/events?callId=../x`, asPhone())).status).toBe(400)
  })
})

// An agent as the destination (#325 phases 2 and 3): the ring starts its
// bot, Look now asks it, and the Show bar answers its asks.
describe("app camera routes for an agent", () => {
  const post = (path: string, body: unknown) => fetch(base + path, asPhone({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))

  it("config lists the agents the phone may show its camera to", async () => {
    reply = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ localName: NODE, iceServers: [], peers: [], agents: [{ id: "writer", name: "Writer" }, { id: "ops" }, { bad: 1 }], camera: null }))
    }
    const r = await fetch(`${base}/api/app/camera/config`, asPhone())
    expect((await r.json()).agents).toEqual([{ id: "writer", name: "Writer" }, { id: "ops", name: "ops" }])
  })

  it("a ring to an agent starts its watch instead of being relayed", async () => {
    reply = (_req, res) => { res.writeHead(201, { "Content-Type": "application/json" }); res.end('{"watch":{"callId":"cam-abcd1234","agentId":"writer"}}') }
    const r = await signal({ kind: "ring", callId: "cam-abcd1234", to: "bot:writer" })
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual({ ok: true, watch: { callId: "cam-abcd1234", agentId: "writer" } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: "POST", path: "/webrtc/camera/watch", auth: `Bearer ${DAEMON_TOKEN}` })
    expect(JSON.parse(seen[0].body)).toEqual({ callId: "cam-abcd1234", agentId: "writer" })
  })

  it("the answer and ICE for an agent go through the broker as this node", async () => {
    await signal({ kind: "answer", callId: "cam-abcd1234", to: "bot:writer", sdp: "v=0" })
    expect(seen[0].path).toBe("/webrtc/signal/out")
    expect(JSON.parse(seen[0].body)).toEqual({ kind: "answer", callId: "cam-abcd1234", from: NODE, to: "bot:writer", sdp: "v=0" })
    expect((await signal({ kind: "ring", callId: "cam-abcd1234", to: "bot:" })).status).toBe(400)
    expect((await signal({ kind: "ring", callId: "cam-abcd1234", to: "bot:a b" })).status).toBe(400)
  })

  it("passes on why the agent cannot watch", async () => {
    reply = (_req, res) => { res.writeHead(409, { "Content-Type": "application/json" }); res.end('{"error":"writer is already watching a camera; stop that share first"}') }
    const r = await signal({ kind: "ring", callId: "cam-abcd1234", to: "bot:writer" })
    expect(r.status).toBe(409)
    expect((await r.json()).error).toMatch(/already watching/)
  })

  it("Look now asks the watching agent and returns its answer", async () => {
    reply = (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"reply":{"at":5,"note":"what?","text":"A rack.","frame":"frame-000003.png"},"frame":{"width":10,"height":5,"takenAt":4,"seq":3}}') }
    const r = await post("/api/app/camera/look", { callId: "cam-abcd1234", note: "what?" })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ reply: { at: 5, note: "what?", text: "A rack.", frame: "frame-000003.png" }, frame: { width: 10, height: 5, takenAt: 4, seq: 3 } })
    expect(seen[0]).toMatchObject({ method: "POST", path: "/webrtc/camera/watch/cam-abcd1234/look", auth: `Bearer ${DAEMON_TOKEN}` })
    expect(JSON.parse(seen[0].body)).toEqual({ note: "what?" })
    expect((await post("/api/app/camera/look", { callId: "../x" })).status).toBe(400)
    reply = (_req, res) => { res.writeHead(409, { "Content-Type": "application/json" }); res.end('{"error":"no picture has arrived from the phone yet"}') }
    expect((await post("/api/app/camera/look", { callId: "cam-abcd1234" })).status).toBe(409)
  })

  it("reads the watch back, for answers the agent gave by itself", async () => {
    reply = (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"watch":{"callId":"cam-abcd1234","replies":[]}}') }
    const r = await fetch(`${base}/api/app/camera/watch?callId=cam-abcd1234`, asPhone())
    expect(await r.json()).toEqual({ watch: { callId: "cam-abcd1234", replies: [] } })
    expect(seen[0].path).toBe("/webrtc/camera/watch/cam-abcd1234")
    expect((await fetch(`${base}/api/app/camera/watch?callId=x`, asPhone())).status).toBe(400)
  })

  it("Keep watching turns the agent's continuous look on and off (#687)", async () => {
    reply = (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"watch":{"callId":"cam-abcd1234","streamUntil":60000}}') }
    const r = await post("/api/app/camera/stream", { callId: "cam-abcd1234", seconds: 60, note: "watch the screws" })
    expect(await r.json()).toEqual({ watch: { callId: "cam-abcd1234", streamUntil: 60000 } })
    expect(seen[0]).toMatchObject({ method: "POST", path: "/webrtc/camera/watch/cam-abcd1234/stream", auth: `Bearer ${DAEMON_TOKEN}` })
    expect(JSON.parse(seen[0].body)).toEqual({ seconds: 60, note: "watch the screws" })
    expect((await post("/api/app/camera/stream", { callId: "cam-abcd1234", seconds: -2 })).status).toBe(400)
    expect((await post("/api/app/camera/stream", { callId: "x" })).status).toBe(400)
    expect(seen).toHaveLength(1)
  })

  it("says only an answer the watch holds, in the agent's voice or the phone's own (#687)", async () => {
    const watch = '{"watch":{"callId":"cam-abcd1234","agentId":"writer","replies":[{"at":7,"note":null,"text":"A blue cable.","frame":"f.png"}]}}'
    reply = (req, res) => {
      if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(watch); return }
      res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.from([1, 2, 3]))
    }
    const r = await post("/api/app/camera/speak", { callId: "cam-abcd1234", at: 7 })
    expect(r.headers.get("content-type")).toBe("audio/mpeg")
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3])
    expect(seen[1]).toMatchObject({ method: "POST", path: "/voice/speak" })
    expect(JSON.parse(seen[1].body)).toEqual({ agent: "writer", text: "A blue cable." })

    // A replay of the same answer is said from the kept audio: no new voice call.
    seen = []
    const again = await post("/api/app/camera/speak", { callId: "cam-abcd1234", at: 7 })
    expect([...new Uint8Array(await again.arrayBuffer())]).toEqual([1, 2, 3])
    expect(seen.map((x) => x.path)).toEqual(["/webrtc/camera/watch/cam-abcd1234"])

    // No ElevenLabs voice: the phone gets the words to say itself, and
    // nothing is kept, so the next ask tries the voice again.
    const other = '{"watch":{"callId":"cam-abcd1234","agentId":"writer","replies":[{"at":9,"note":null,"text":"A red cable.","frame":"g.png"}]}}'
    reply = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(req.method === "GET" ? other : '{"fallback":"browser","text":"A red cable"}')
    }
    expect(await (await post("/api/app/camera/speak", { callId: "cam-abcd1234", at: 9 })).json()).toEqual({ text: "A red cable" })
    seen = []
    expect(await (await post("/api/app/camera/speak", { callId: "cam-abcd1234", at: 9 })).json()).toEqual({ text: "A red cable" })
    expect(seen.map((x) => x.path)).toEqual(["/webrtc/camera/watch/cam-abcd1234", "/voice/speak"])

    // Never arbitrary text: an answer the watch does not hold is refused.
    seen = []
    const missing = await post("/api/app/camera/speak", { callId: "cam-abcd1234", at: 8, text: "Say this" })
    expect(missing.status).toBe(404)
    expect(seen.map((x) => x.path)).toEqual(["/webrtc/camera/watch/cam-abcd1234"])
  })

  it("lists the asks waiting for the owner, and answers or declines one", async () => {
    reply = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end('{"calls":[{"id":"call-aaaa1111","agentId":"writer","kind":"camera","reason":"Show me the rack","createdAt":9,"channel":"telegram","chatId":"c"}],"ringSeconds":45}')
    }
    const r = await fetch(`${base}/api/app/camera/asks`, asPhone())
    expect(await r.json()).toEqual({ asks: [{ id: "call-aaaa1111", agentId: "writer", reason: "Show me the rack", createdAt: 9 }], ringSeconds: 45 })
    expect(seen[0]).toMatchObject({ method: "GET", path: "/calls/asking", auth: `Bearer ${DAEMON_TOKEN}` })

    reply = (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"call":{"id":"call-aaaa1111","status":"answered"}}') }
    const answered = await post("/api/app/camera/asks/call-aaaa1111/answer", {})
    expect(await answered.json()).toEqual({ call: { id: "call-aaaa1111", status: "answered" } })
    expect(seen[1]).toMatchObject({ method: "POST", path: "/calls/call-aaaa1111/answer" })
    await post("/api/app/camera/asks/call-aaaa1111/decline", {})
    expect(seen[2].path).toBe("/calls/call-aaaa1111/decline")
    expect((await post("/api/app/camera/asks/call-aaaa1111/hangup", {})).status).toBe(404)
    expect((await post("/api/app/camera/asks/../x/answer", {})).status).toBe(404)
    expect(seen).toHaveLength(3)
  })

  it("a daemon refusal reaches the phone as its own status", async () => {
    reply = (_req, res) => { res.writeHead(409, { "Content-Type": "application/json" }); res.end('{"error":"call is answered, not ringing"}') }
    const r = await post("/api/app/camera/asks/call-aaaa1111/answer", {})
    expect(r.status).toBe(409)
    expect((await r.json()).error).toMatch(/not ringing/)
  })

  it("watchingAgent reads a bot destination", () => {
    expect(watchingAgent("bot:writer")).toBe("writer")
    expect(watchingAgent("bot:my-agent.v2")).toBe("my-agent.v2")
    expect(watchingAgent("Node-B")).toBeNull()
    expect(watchingAgent("bot:")).toBeNull()
    expect(watchingAgent("bot:a/b")).toBeNull()
  })

  it("the phone scripts parse and are wired: Look now, the Show bar, one event between them", () => {
    const html = renderAppPage()
    expect(html).toContain('id="cam-look"')
    expect(html).toContain('id="cam-ask-bar"')
    expect(html).toContain('id="cam-ask-show"')
    expect(() => new Function(CAMERA_ASKS_SCRIPT)).not.toThrow()
    expect(CAMERA_ASKS_SCRIPT).toContain("/api/app/camera/asks")
    expect(CAMERA_ASKS_SCRIPT).toContain("'ax-camera'")
    expect(CAMERA_SCRIPT).toContain("'ax-camera'")
    expect(CAMERA_SCRIPT).toContain("/api/app/camera/look")
    // An agent's watch has its own time limit; the phone shows the shorter one.
    expect(CAMERA_SCRIPT).toContain("maxSessionMinutes")
    // Voice first (#687): Talk, the transcription, spoken answers, Keep watching.
    for (const id of ["cam-talk", "cam-type", "cam-speaker", "cam-stream"]) expect(html).toContain(`id="${id}"`)
    for (const s of ["/api/app/voice/transcribe", "/api/app/camera/speak", "/api/app/camera/stream", "talkRelease", "streamLabel", "voiceInput", "speakAnswers", "streamMaxSeconds"]) expect(CAMERA_SCRIPT).toContain(s)
  })
})

describe("cameraSignal", () => {
  it("keeps only the fields the broker uses", () => {
    expect(cameraSignal({ kind: "ice", callId: "cam-abcd", to: "B", candidate: { candidate: "c", sdpMid: "0", sdpMLineIndex: 0, extra: 1 }, junk: true }, "A")).toEqual({
      kind: "ice", callId: "cam-abcd", from: "A", to: "B",
      candidate: { candidate: "c", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null },
    })
  })
})

describe("phone side", () => {
  it("opens the camera only, never the microphone", () => {
    expect(cameraConstraints(null, "environment")).toEqual({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15 } },
    })
    const c = cameraConstraints({ width: 640, height: 480, frameRate: 10, maxSeconds: 60 }, "user") as any
    expect(c.audio).toBe(false)
    expect(c.video).toEqual({ facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 10 } })
    expect((cameraConstraints(null, "anything") as any).video.facingMode).toEqual({ ideal: "environment" })
  })

  it("Talk: a hold sends on release, a tap keeps listening until the next tap", () => {
    expect(talkRelease(1200)).toBe("send")
    expect(talkRelease(400)).toBe("send")
    expect(talkRelease(120)).toBe("listen")
  })

  it("labels Keep watching with its length", () => {
    expect(streamLabel(60)).toBe("Keep watching 1 min")
    expect(streamLabel(45)).toBe("Keep watching 45 s")
    expect(streamLabel(null)).toBe("Keep watching 1 min")
  })

  it("shows the time left", () => {
    expect(shareClock(600_000)).toBe("10:00")
    expect(shareClock(65_500)).toBe("1:06")
    expect(shareClock(-5)).toBe("0:00")
  })

  it("mounts the button, the sheet and a script that parses", () => {
    const html = renderAppPage()
    expect(html).toContain('id="cam-btn"')
    expect(html).toContain('id="cam-stop"')
    expect(() => new Function(CAMERA_SCRIPT)).not.toThrow()
    // Every way a share ends is wired: Stop, the viewer, the background, the limit.
    for (const s of ["cam-stop", "'hangup'", "visibilitychange", "maxSeconds", "keepalive", "EventSource.CLOSED"]) expect(CAMERA_SCRIPT).toContain(s)
  })
})

describe("the machine that watches", () => {
  it("gets a watch-only link for a camera share, and the usual one for a call", () => {
    const sig = { kind: "ring" as const, callId: "cam-abcd", from: "Node A", to: "B" }
    expect(ringNotice({ ...sig, reason: "camera" }, "https://b.example")).toBe(
      "📷 Node A is sharing a phone camera — tap to watch: https://b.example/call?to=Node%20A&callId=cam-abcd&watch=1")
    expect(ringNotice(sig, "https://b.example")).toBe("📞 Node A is calling — tap to join: https://b.example/call?to=Node%20A&callId=cam-abcd")
  })

  it("the call page's watch mode opens nothing and offers to receive", () => {
    const script = CALL_PAGE_HTML.split("<script>")[1].split("</script>")[0]
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('qs.get("watch") === "1"')
    expect(script).toContain('addTransceiver("video", { direction: "recvonly" })')
  })
})
