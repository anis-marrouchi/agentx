import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CameraWatchManager, defaultSession, framePrompt, type CameraWatchDeps, type WatchView, type WatchReply } from "../src/camera/watch"
import type { VideoFrame } from "../src/channels/webrtc-bot"
import { handleCamera, isCameraPath } from "../src/daemon/camera-api"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { cameraBotSchema, type CameraBotConfig } from "../src/daemon/config"
import type { Call } from "../src/calls/store"

// An agent watching the phone camera (#325 phase 2): frames on demand and
// on the interval, the files it leaves behind, the limits, and the routes.
// The bot is a fake that hands frames straight to the manager.

interface FakeBot { callId: string; agentId: string; onFrame: (f: VideoFrame) => void; onClosed: (r: string) => void; closed: string | null }

let dir: string
let cfg: CameraBotConfig
let bots: FakeBot[]
let turns: Array<{ agentId: string; message: string; session: { channel: string; chatId: string; sender: string } }>
let delivered: Array<{ watch: WatchView; reply: WatchReply }>
let ended: Array<{ watch: WatchView; reason: string }>
let reply: string | null
let botFails: string | null
let now: number
let mgr: CameraWatchManager

const frame = (w = 8, h = 4, rotation = 0): VideoFrame => ({
  width: w, height: h, rotation, receivedAt: now,
  data: new Uint8Array(w * h + 2 * ((w + 1) >> 1) * ((h + 1) >> 1)).fill(128),
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-camera-watch-"))
  mkdirSync(join(dir, "writer-ws"))
  // 4 px is under the schema's floor; tests want tiny files.
  cfg = { ...cameraBotSchema.parse({ maxSessionMinutes: 2 }), maxFrameEdge: 4 }
  bots = []; turns = []; delivered = []; ended = []
  reply = "A grey wall with one cable."
  botFails = null
  now = 1_000_000
  const deps: CameraWatchDeps = {
    config: () => cfg,
    startBot: async (o) => {
      if (botFails) throw new Error(botFails)
      const bot: FakeBot = { ...o, closed: null }
      bots.push(bot)
      return { close: (r) => { bot.closed = r; o.onClosed(r) } }
    },
    workspaceOf: (id) => (id === "writer" ? join(dir, "writer-ws") : id === "ops" ? join(dir, "ops-ws") : null),
    agentName: (id) => ({ writer: "Writer", ops: "Ops", nowhere: "Nowhere" } as Record<string, string>)[id] ?? null,
    turn: async (t) => { turns.push(t); return reply },
    deliver: (watch, r) => { delivered.push({ watch, reply: r }) },
    onEnded: (watch, reason) => { ended.push({ watch, reason }) },
    cwd: () => dir,
    now: () => now,
  }
  mgr = new CameraWatchManager(deps)
})

afterEach(() => {
  mgr.shutdown()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const frames = (callId: string) => join(dir, "writer-ws", ".agentx", "camera", callId)

describe("config", () => {
  it("defaults: on demand only, 10 minutes, 1024 px, frames not kept", () => {
    expect(cameraBotSchema.parse(undefined)).toEqual({ frameIntervalSeconds: 0, maxSessionMinutes: 10, maxFrameEdge: 1024, keepFrames: false })
    expect(() => cameraBotSchema.parse({ maxFrameEdge: 10 })).toThrow()
  })
})

describe("start", () => {
  it("opens a bot for the agent and reports the watch", async () => {
    const r = await mgr.start({ callId: "cam-1234", agentId: "writer" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.watch).toMatchObject({ callId: "cam-1234", agentId: "writer", agentName: "Writer", frames: 0, looks: 0, replies: [], callRecordId: null })
    expect(r.watch.until).toBe(now + 2 * 60_000)
    expect(r.watch.session).toEqual(defaultSession("writer"))
    expect(bots.map((b) => [b.callId, b.agentId])).toEqual([["cam-1234", "writer"]])
    expect(mgr.active().map((w) => w.callId)).toEqual(["cam-1234"])
    expect(mgr.watchingFor("writer")?.callId).toBe("cam-1234")
    // No file until a frame is asked for.
    expect(existsSync(frames("cam-1234"))).toBe(false)
  })

  it("refuses bad ids, unknown agents, a second watch, and an agent without a workspace", async () => {
    expect(await mgr.start({ callId: "x", agentId: "writer" })).toMatchObject({ ok: false, status: 400 })
    expect(await mgr.start({ callId: "cam-1234", agentId: "ghost" })).toMatchObject({ ok: false, status: 404 })
    expect(await mgr.start({ callId: "cam-1234", agentId: "nowhere" })).toMatchObject({ ok: false, status: 409, error: /no workspace/ })
    expect((await mgr.start({ callId: "cam-1234", agentId: "writer" })).ok).toBe(true)
    expect(await mgr.start({ callId: "cam-1234", agentId: "ops" })).toMatchObject({ ok: false, status: 409, error: /already watching this share/ })
    expect(await mgr.start({ callId: "cam-5678", agentId: "writer" })).toMatchObject({ ok: false, status: 409, error: /already watching a camera/ })
    expect(bots).toHaveLength(1)
  })

  it("passes on a bot that cannot join", async () => {
    botFails = "no wrtc here"
    expect(await mgr.start({ callId: "cam-1234", agentId: "writer" })).toMatchObject({ ok: false, status: 502, error: /no wrtc here/ })
    expect(mgr.active()).toEqual([])
  })

  it("never writes through a linked .agentx", async () => {
    symlinkSync(dir, join(dir, "writer-ws", ".agentx"))
    expect(await mgr.start({ callId: "cam-1234", agentId: "writer" })).toMatchObject({ ok: false, status: 500, error: /is a link/ })
  })
})

describe("look", () => {
  it("needs a frame first", async () => {
    await mgr.start({ callId: "cam-1234", agentId: "writer" })
    expect(await mgr.look("cam-1234")).toMatchObject({ ok: false, status: 409, error: /no picture/ })
    expect(await mgr.look("cam-nope")).toMatchObject({ ok: false, status: 404 })
    expect(turns).toEqual([])
  })

  it("writes the newest frame as a PNG, names it in the agent's turn, and returns the reply", async () => {
    await mgr.start({ callId: "cam-1234", agentId: "writer" })
    bots[0].onFrame(frame(8, 4))
    now += 10
    bots[0].onFrame(frame(8, 4, 90))
    const r = await mgr.look("cam-1234", "  what is\n this? ")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // The second frame, turned upright (8x4 rotated is 4x8), bounded to 4 px.
    expect(r.frame).toMatchObject({ width: 2, height: 4, seq: 2, takenAt: now, path: join(frames("cam-1234"), "frame-000002.png") })
    expect(turns).toHaveLength(1)
    expect(turns[0].agentId).toBe("writer")
    expect(turns[0].session).toEqual({ channel: "voice", chatId: "voice:writer", sender: "Camera" })
    expect(turns[0].message).toBe(framePrompt({ ...r.frame, note: "what is this?" }))
    expect(turns[0].message).toContain(r.frame.path)
    expect(turns[0].message).toContain('The owner asks: "what is this?"')
    expect(r.reply).toEqual({ at: now, note: "what is this?", text: "A grey wall with one cable.", frame: "frame-000002.png" })
    expect(mgr.get("cam-1234")).toMatchObject({ frames: 2, looks: 1, replies: [r.reply] })
    // keepFrames is off: the file went once the turn was over.
    expect(existsSync(r.frame.path)).toBe(false)
  })

  it("the file is there while the agent's turn runs", async () => {
    let seen: Buffer | null = null
    const m2 = new CameraWatchManager({
      config: () => cfg, startBot: async (o) => { bots.push({ ...o, closed: null }); return { close: () => {} } },
      workspaceOf: () => join(dir, "writer-ws"), agentName: () => "Writer", cwd: () => dir, now: () => now,
      turn: async ({ message }) => { seen = readFileSync(message.split("\n")[1]); return "ok" },
    })
    await m2.start({ callId: "cam-2222", agentId: "writer" })
    bots[0].onFrame(frame())
    const r = await m2.look("cam-2222")
    expect(r.ok).toBe(true)
    expect(seen!.subarray(1, 4).toString()).toBe("PNG")
    m2.shutdown()
  })

  it("a prompt without a note asks for a description", () => {
    const p = framePrompt({ path: "/tmp/f.png", width: 10, height: 5, takenAt: 0 })
    expect(p).toContain("/tmp/f.png")
    expect(p).toContain("Describe what you see")
    expect(p).toContain("Read tool")
  })

  it("refuses a long note and reports an agent that did not answer", async () => {
    await mgr.start({ callId: "cam-1234", agentId: "writer" })
    bots[0].onFrame(frame())
    expect(await mgr.look("cam-1234", "x".repeat(301))).toMatchObject({ ok: false, status: 413 })
    reply = "  "
    expect(await mgr.look("cam-1234")).toMatchObject({ ok: false, status: 502, error: /Writer did not answer/ })
    expect(mgr.get("cam-1234")?.replies).toEqual([])
  })

  it("keeps the files when keepFrames is on", async () => {
    cfg = { ...cfg, keepFrames: true }
    await mgr.start({ callId: "cam-1234", agentId: "writer" })
    bots[0].onFrame(frame())
    const r = await mgr.look("cam-1234")
    expect(r.ok && existsSync(r.frame.path)).toBe(true)
    mgr.stop("cam-1234")
    expect(readdirSync(frames("cam-1234"))).toEqual(["frame-000001.png"])
  })
})

describe("snapshot (the agent's own look)", () => {
  it("returns the newest frame's path and leaves the file until the watch ends", async () => {
    expect(mgr.snapshot("writer")).toMatchObject({ ok: false, status: 404, error: /No live camera share for writer/ })
    await mgr.start({ callId: "cam-1234", agentId: "writer" })
    expect(mgr.snapshot("writer")).toMatchObject({ ok: false, status: 409 })
    bots[0].onFrame(frame())
    const r = mgr.snapshot("writer")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.callId).toBe("cam-1234")
    expect(existsSync(r.frame.path)).toBe(true)
    expect(turns).toEqual([])                       // no turn: the agent is already in one
    expect(mgr.snapshot("writer")).toMatchObject({ ok: true, frame: r.frame })  // same frame, same file
    expect(readdirSync(frames("cam-1234"))).toEqual(["frame-000001.png"])
    mgr.stop("cam-1234", "done")
    expect(existsSync(frames("cam-1234"))).toBe(false)
  })
})

describe("interval frames", () => {
  it("hands over the newest frame on the interval, only when new, and delivers the reply", async () => {
    vi.useFakeTimers()
    cfg = { ...cfg, frameIntervalSeconds: 30 }
    await mgr.start({ callId: "cam-1234", agentId: "writer" })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(turns).toEqual([])
    bots[0].onFrame(frame()); bots[0].onFrame(frame())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(turns).toHaveLength(1)
    expect(turns[0].message).toContain("frame-000002.png")
    expect(turns[0].message).toContain("Describe what you see")
    expect(delivered).toHaveLength(1)
    expect(delivered[0].reply).toMatchObject({ note: null, text: "A grey wall with one cable." })
    expect(delivered[0].watch.callId).toBe("cam-1234")
    await vi.advanceTimersByTimeAsync(45_000)
    expect(turns).toHaveLength(1)                   // nothing new: no turn
    expect(mgr.get("cam-1234")?.replies).toHaveLength(1)
  })
})

describe("session limits and ending", () => {
  it("ends after maxSessionMinutes, closes the bot, deletes the frames, and says so", async () => {
    vi.useFakeTimers()
    await mgr.start({ callId: "cam-1234", agentId: "writer" })
    bots[0].onFrame(frame())
    mgr.snapshot("writer")
    expect(existsSync(frames("cam-1234"))).toBe(true)
    await vi.advanceTimersByTimeAsync(2 * 60_000 - 1)
    expect(mgr.active()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mgr.active()).toEqual([])
    expect(bots[0].closed).toMatch(/time limit \(2 min\)/)
    expect(existsSync(frames("cam-1234"))).toBe(false)
    expect(ended).toEqual([{ watch: expect.objectContaining({ callId: "cam-1234", frames: 1, looks: 1 }), reason: expect.stringMatching(/time limit/) }])
    // The agent may watch again afterwards.
    expect((await mgr.start({ callId: "cam-5678", agentId: "writer" })).ok).toBe(true)
  })

  it("the phone hanging up ends the watch once", async () => {
    await mgr.start({ callId: "cam-1234", agentId: "writer" })
    bots[0].onClosed("hangup from Node-A")
    expect(mgr.active()).toEqual([])
    expect(ended.map((e) => e.reason)).toEqual(["hangup from Node-A"])
    expect(mgr.stop("cam-1234")).toBe(false)
    expect(ended).toHaveLength(1)
  })

  it("stop is idempotent and shutdown ends everything", async () => {
    await mgr.start({ callId: "cam-1234", agentId: "writer" })
    await mgr.start({ callId: "cam-5678", agentId: "ops" })
    expect(mgr.stop("cam-1234", "owner")).toBe(true)
    expect(mgr.stop("cam-1234", "owner")).toBe(false)
    mgr.shutdown()
    expect(mgr.active()).toEqual([])
    expect(bots.map((b) => b.closed)).toEqual(["owner", "shutdown"])
  })
})

describe("routes", () => {
  const proofOk = (id: string, p: { taskId?: string }) => p.taskId === `task-${id}`
  const calls = new Map<string, Call>()
  const api = (method: string, path: string, body: Record<string, unknown> = {}, proof = {}) =>
    handleCamera({ watch: mgr, isRunningTurn: proofOk, calls: { get: (id) => calls.get(id) } }, method, path, body, proof)
  const ask = (over: Partial<Call>): Call => ({
    id: "call-aaaa1111", agentId: "writer", kind: "camera", reason: "Show me the rack", urgency: "normal", status: "answered",
    createdAt: 1, ringingSince: null, answeredAt: 2, endedAt: null, ringAgainAt: null, note: null, summary: null,
    channel: "telegram", chatId: "chat-9", ...over,
  })

  beforeEach(() => calls.clear())

  it("are all mesh-gated", () => {
    for (const p of ["/webrtc/camera/watch", "/webrtc/camera/watch/cam-1/look", "/webrtc/camera/look"]) {
      expect(isCameraPath(p)).toBe(true)
      expect(isMeshGatedPath(p)).toBe(true)
    }
    expect(isCameraPath("/webrtc/config")).toBe(false)
    expect(isCameraPath("/webrtc/bots")).toBe(false)
  })

  it("start, list, look, read back, stop", async () => {
    const started = await api("POST", "/webrtc/camera/watch", { callId: "cam-1234", agentId: "writer" })
    expect(started.status).toBe(201)
    expect((started.body as any).watch.callId).toBe("cam-1234")
    expect(((await api("GET", "/webrtc/camera/watch")).body as any).active).toHaveLength(1)
    expect((await api("POST", "/webrtc/camera/watch/cam-1234/look")).status).toBe(409)
    bots[0].onFrame(frame())
    const looked = await api("POST", "/webrtc/camera/watch/cam-1234/look", { note: "hi" })
    expect(looked.status).toBe(200)
    expect((looked.body as any).reply.text).toBe("A grey wall with one cable.")
    expect((looked.body as any).frame).toEqual({ width: 4, height: 2, takenAt: now, seq: 1 })  // no path for the phone
    expect(((await api("GET", "/webrtc/camera/watch/cam-1234")).body as any).watch.looks).toBe(1)
    expect((await api("POST", "/webrtc/camera/watch/cam-1234/stop")).status).toBe(200)
    expect((await api("POST", "/webrtc/camera/watch/cam-1234/stop")).status).toBe(404)
    expect((await api("GET", "/webrtc/camera/watch/cam-1234")).status).toBe(404)
    expect((await api("POST", "/webrtc/camera/watch/cam-1234/explode")).status).toBe(404)
    expect((await api("GET", "/webrtc/camera/nope")).status).toBe(404)
  })

  it("an agent's own look needs proof of its running turn", async () => {
    await api("POST", "/webrtc/camera/watch", { callId: "cam-1234", agentId: "writer" })
    bots[0].onFrame(frame())
    expect((await api("POST", "/webrtc/camera/look", {})).status).toBe(400)
    expect((await api("POST", "/webrtc/camera/look", { agentId: "writer" })).status).toBe(403)
    expect((await api("POST", "/webrtc/camera/look", { agentId: "writer" }, { taskId: "task-ops" })).status).toBe(403)
    const r = await api("POST", "/webrtc/camera/look", { agentId: "writer" }, { taskId: "task-writer" })
    expect(r.status).toBe(200)
    expect((r.body as any).frame.path).toMatch(/frame-000001\.png$/)
    expect((await api("POST", "/webrtc/camera/look", { agentId: "ops" }, { taskId: "task-ops" })).status).toBe(404)
  })

  it("a share under an ask's id needs the owner's answer, and runs where the agent asked", async () => {
    calls.set("call-aaaa1111", ask({ status: "ringing" }))
    expect(await api("POST", "/webrtc/camera/watch", { callId: "call-aaaa1111", agentId: "writer" })).toMatchObject({ status: 409, body: { error: /not accepted/ } })
    calls.set("call-aaaa1111", ask({}))
    expect(await api("POST", "/webrtc/camera/watch", { callId: "call-aaaa1111", agentId: "ops" })).toMatchObject({ status: 403, body: { error: /asked by writer/ } })
    calls.set("call-bbbb2222", ask({ id: "call-bbbb2222", kind: "voice" }))
    expect(await api("POST", "/webrtc/camera/watch", { callId: "call-bbbb2222", agentId: "writer" })).toMatchObject({ status: 409, body: { error: /voice call/ } })
    const r = await api("POST", "/webrtc/camera/watch", { callId: "call-aaaa1111", agentId: "writer" })
    expect(r.status).toBe(201)
    expect((r.body as any).watch).toMatchObject({ callRecordId: "call-aaaa1111", session: { channel: "telegram", chatId: "chat-9", sender: "Camera" } })
    bots[0].onFrame(frame())
    await api("POST", "/webrtc/camera/watch/call-aaaa1111/look")
    expect(turns[0].session).toEqual({ channel: "telegram", chatId: "chat-9", sender: "Camera" })
    // A task run had no chat: the voice session.
    calls.set("call-cccc3333", ask({ id: "call-cccc3333", channel: null, chatId: null }))
    mgr.stop("call-aaaa1111")
    const r2 = await api("POST", "/webrtc/camera/watch", { callId: "call-cccc3333", agentId: "writer" })
    expect((r2.body as any).watch.session).toEqual(defaultSession("writer"))
  })
})
