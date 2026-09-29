import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { cameraSignal } from "../src/daemon/app-camera"
import { cameraConstraints, shareClock } from "../src/daemon/ui/pages/app-camera-logic"
import { CAMERA_SCRIPT } from "../src/daemon/ui/pages/app-camera.client"
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
    for (const s of ["cam-stop", "'hangup'", "visibilitychange", "maxSeconds"]) expect(CAMERA_SCRIPT).toContain(s)
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
