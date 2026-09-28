import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TokenStore } from "../src/daemon/token-store"
import { handleAppRequest } from "../src/daemon/app-routes"
import { AppChatStore } from "../src/daemon/app-chat-store"
import { SPEAK_INPUT_MAX, type AppVoiceDeps } from "../src/daemon/app-voice"
import { AUDIO_LIMITS } from "../src/voice/transcribe"
import { openDb, closeDb } from "../src/storage/sqlite"

// The phone app's voice routes on the dashboard: the device token, the
// bounds on what a phone sends, and the hand-off to the daemon, which is a
// fake here that records what reaches it.

const DAEMON_TOKEN = "daemon-secret"
const AUDIO = Buffer.from("fake-mp4-audio-" + "y".repeat(500))

interface Seen { path: string; auth?: string; type?: string; duration?: string; body: Buffer }
let seen: Seen[] = []
let reply: (res: ServerResponse, seen: Seen) => void = (res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"text":"hello","engine":"elevenlabs"}') }

let dir: string
let tokens: TokenStore
let store: AppChatStore
let daemon: Server
let app: Server
let base: string
let phone: string
let otherPhone: string
let convId: string
let peerConvId: string

async function fakeDaemon(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const s: Seen = {
    path: req.url || "", auth: req.headers.authorization, type: req.headers["content-type"],
    duration: req.headers["x-audio-duration-ms"] as string | undefined, body: Buffer.concat(chunks),
  }
  seen.push(s)
  reply(res, s)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentx-app-voice-"))
  tokens = new TokenStore(dir)
  store = new AppChatStore(openDb({ path: join(dir, "db.sqlite") })!)
  const rec = tokens.create({ name: "Test phone", scopes: ["app"] })
  phone = rec.token
  otherPhone = tokens.create({ name: "Other phone", scopes: ["app"] }).token
  const id = tokens.verify(phone)!.id
  convId = store.create(id, { node: "local", nodeName: "node-a", agent: "alpha", agentName: "Alpha" }, "hi").id
  peerConvId = store.create(id, { node: "peer-b", nodeName: "node-b", agent: "beta", agentName: "Beta" }, "hi").id

  daemon = createServer((req, res) => { void fakeDaemon(req, res) })
  await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r))
  const deps: AppVoiceDeps = { store: () => store, daemon: { url: `http://127.0.0.1:${(daemon.address() as any).port}`, token: DAEMON_TOKEN } }
  app = createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname
    if (!(await handleAppRequest(req, res, path, req.method || "GET", { tokens, voice: deps }))) { res.writeHead(418); res.end() }
  })
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(app.address() as any).port}`
})

afterAll(() => {
  app.close()
  daemon.close()
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  seen = []
  reply = (res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"text":"hello","engine":"elevenlabs"}') }
})

const post = (path: string, body: BodyInit, headers: Record<string, string>, t: string | null = phone) =>
  fetch(base + path, { method: "POST", body, headers: { ...headers, ...(t ? { Authorization: `Bearer ${t}` } : {}) } })
const transcribe = (body: BodyInit = AUDIO, headers: Record<string, string> = { "Content-Type": "audio/mp4", "X-Audio-Duration-Ms": "2400" }, t?: string | null) =>
  post("/api/app/voice/transcribe", body, headers, t === undefined ? phone : t)
const speak = (body: unknown, t: string | null = phone) => post("/api/app/voice/speak", JSON.stringify(body), { "Content-Type": "application/json" }, t)

describe("voice routes need the device token", () => {
  it("refuses both routes with no token or a token without the app scope", async () => {
    const { token: admin } = tokens.create({ name: "admin", scopes: ["dashboard:write", "agent:*"] })
    for (const t of [null, admin, "nonsense"]) {
      expect((await transcribe(AUDIO, { "Content-Type": "audio/mp4" }, t)).status).toBe(401)
      expect((await speak({ conversationId: convId, text: "hi" }, t)).status).toBe(401)
    }
    expect(seen).toEqual([])
  })
})

describe("POST /api/app/voice/transcribe", () => {
  it("forwards the recording to the daemon with the daemon token, not the phone's", async () => {
    const r = await transcribe()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ text: "hello", engine: "elevenlabs" })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: "/voice/transcribe", auth: `Bearer ${DAEMON_TOKEN}`, type: "audio/mp4", duration: "2400" })
    expect(seen[0].body.equals(AUDIO)).toBe(true)
  })

  it("bounds the type, the size and the length before anything reaches the daemon", async () => {
    expect((await transcribe(AUDIO, { "Content-Type": "application/json" })).status).toBe(415)
    expect((await transcribe(Buffer.alloc(AUDIO_LIMITS.bytes + 10), { "Content-Type": "audio/webm" })).status).toBe(413)
    const long = await transcribe(AUDIO, { "Content-Type": "audio/webm", "X-Audio-Duration-Ms": String(AUDIO_LIMITS.ms + 60_000) })
    expect(long.status).toBe(413)
    expect((await transcribe(Buffer.alloc(0), { "Content-Type": "audio/webm" })).status).toBe(400)
    expect((await fetch(base + "/api/app/voice/transcribe", { headers: { Authorization: `Bearer ${phone}` } })).status).toBe(405)
    expect(seen).toEqual([])
  })

  it("passes the daemon's 503 on, so the phone can say voice input isn't set up", async () => {
    reply = (res) => { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Voice input isn't set up on this computer.", hint: "Add an ElevenLabs key" })) }
    const r = await transcribe()
    expect(r.status).toBe(503)
    expect((await r.json()).hint).toMatch(/ElevenLabs/)
  })

  it("says the computer's AgentX is too old when the daemon has no such route", async () => {
    reply = (res) => { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found", endpoints: ["GET /health"] })) }
    const r = await transcribe()
    expect(r.status).toBe(503)
    expect((await r.json()).error).toMatch(/too old/)
  })

  it("logs nothing of the audio", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m))
    try {
      await transcribe()
      for (const s of spies) for (const call of s.mock.calls) expect(call.join(" ")).not.toContain("fake-mp4-audio")
    } finally { spies.forEach((s) => s.mockRestore()) }
  })
})

describe("POST /api/app/voice/speak", () => {
  it("speaks in the voice of the agent the conversation is pinned to, as audio", async () => {
    reply = (res) => { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.from("ID3-mp3")) }
    const r = await speak({ conversationId: convId, text: "Hello there", agent: "someone-else" })
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("audio/mpeg")
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("ID3-mp3")
    expect(seen[0].path).toBe("/voice/speak")
    expect(JSON.parse(seen[0].body.toString())).toEqual({ agent: "alpha", text: "Hello there" })
  })

  it("names the mesh peer for an agent on another computer", async () => {
    await speak({ conversationId: peerConvId, text: "Hi" })
    expect(JSON.parse(seen[0].body.toString())).toEqual({ agent: "beta", text: "Hi", peer: "peer-b" })
  })

  it("caps the text it sends", async () => {
    await speak({ conversationId: convId, text: "a".repeat(SPEAK_INPUT_MAX + 500) })
    expect(JSON.parse(seen[0].body.toString()).text).toHaveLength(SPEAK_INPUT_MAX)
  })

  it("passes on the daemon's fallback to the phone's own voice", async () => {
    reply = (res) => { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "No ElevenLabs key", fallback: "browser", text: "Hello there" })) }
    const r = await speak({ conversationId: convId, text: "**Hello** there" })
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ fallback: "browser", text: "Hello there" })
  })

  it("only reads out this phone's own conversations", async () => {
    expect((await speak({ conversationId: convId, text: "hi" }, otherPhone)).status).toBe(404)
    expect((await speak({ conversationId: "cnotreal123", text: "hi" })).status).toBe(404)
    expect((await speak({ conversationId: convId, text: "  " })).status).toBe(400)
    expect(seen).toEqual([])
  })
})

describe("the agent's colour for the orb", () => {
  it("comes with each agent in the picker when its node sends one", async () => {
    const { buildPicker } = await import("../src/daemon/app-chat")
    const nodes = [{ id: "a", url: "http://a.test", name: "node-a", reachable: true, agents: [
      { id: "alpha", name: "Alpha", active: 0, errors: 0, color: "#0D9488" },
      { id: "plain", name: "Plain", active: 0, errors: 0 },
    ] }]
    const [node] = buildPicker(nodes, { url: "http://a.test" }, [])
    expect(node.agents).toEqual([
      { id: "alpha", name: "Alpha", busy: false, running: 0, color: "#0D9488" },
      { id: "plain", name: "Plain", busy: false, running: 0 },
    ])
  })
})
