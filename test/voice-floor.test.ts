import { describe, it, expect, vi, afterEach } from "vitest"
import { EventEmitter } from "events"
import type { ChildProcess } from "child_process"
import type { Play, Utterance } from "../src/voice/speaker"
import { SpeechOut } from "../src/voice/speaking-queue"
import { Floor, describeFloor, type FloorView } from "../src/voice/floor"
import { handleFloor } from "../src/daemon/voice-floor-api"
import { handleGuide } from "../src/daemon/voice-guide-api"
import { describeQueue, handleQueue } from "../src/daemon/voice-queue-api"
import { VoiceTalkService } from "../src/daemon/voice-talk-api"
import { VoiceIntroTracker } from "../src/voice/agent-voice"
import { daemonConfigSchema } from "../src/daemon/config"

// #924: one speaker at a time, with a floor others must respect.

afterEach(() => vi.useRealTimers())

const voice = { provider: "system" as const, elevenlabs: "v", system: null, fallback: true }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const line = (text: string, extra: Partial<Utterance> = {}): Utterance => ({ voice, text, agentId: "a", kind: "answer", ...extra })
const none = new URLSearchParams()
const rect = { x: 100, y: 80, width: 90, height: 24 }

function audio(ms = 15) {
  const log: string[] = []
  const play: Play = (_file, u) => {
    const p = new EventEmitter() as ChildProcess
    log.push(`play ${u.text}`)
    const timer = setTimeout(() => p.emit("close", 0), ms)
    ;(p as any).kill = () => { clearTimeout(timer); log.push(`kill ${u.text}`); p.emit("close", null) }
    return p
  }
  return { play, log, plays: () => log.filter((l) => l.startsWith("play")) }
}

function service(floor: { now?: () => number; alive?: (pid: number) => boolean } = {}, settings: object = {}) {
  const a = audio()
  const logs: string[] = []
  const views: FloorView[] = []
  const speech = new SpeechOut(async () => null, a.play, {}, () => 60_000)
  const svc = new VoiceTalkService(() => ({ a: { name: "A" }, b: { name: "B" } }) as any, new VoiceIntroTracker(), (m) => logs.push(m), {
    speech, stopSpeakers: () => {}, floor, voiceSettings: () => settings, onFloor: (v) => views.push(v),
  })
  return { svc, speech, logs, views, ...a }
}

describe("Floor", () => {
  it("one holder at a time: a second take is refused and told who holds it", () => {
    const floor = new Floor()
    const first = floor.take({ holder: "Product tour", sound: true })
    expect(first.ok).toBe(true)
    expect(floor.view()).toMatchObject({ held: true, holder: "Product tour", sound: true, hide: false })
    const second = floor.take({ holder: "Recording" })
    expect(second).toMatchObject({ ok: false, reason: "held", error: "The floor is held by Product tour" })
  })

  it("the id is the holder's proof and is never in the view", () => {
    const floor = new Floor()
    const took = floor.take({ holder: "Tour" })
    if (!took.ok) throw new Error("refused")
    expect(JSON.stringify(floor.view())).not.toContain(took.id)
    expect(floor.holds(took.id)).toBe(true)
    expect(floor.holds("someone-else")).toBe(false)
    expect(floor.release("someone-else")).toBe(false)
    expect(floor.release(took.id)).toBe(true)
    expect(floor.view()).toMatchObject({ held: false, ended: "released" })
  })

  it("frees itself at the time limit, and a renewal moves the limit", () => {
    let now = 1_000
    const floor = new Floor({ now: () => now })
    const took = floor.take({ holder: "Tour", seconds: 30 })
    if (!took.ok) throw new Error("refused")
    now += 29_000
    expect(floor.view().held).toBe(true)
    expect(floor.renew(took.id, 60)).toMatchObject({ held: true, expiresAt: now + 60_000 })
    now += 59_000
    expect(floor.view().held).toBe(true)
    now += 2_000
    expect(floor.view()).toMatchObject({ held: false, ended: "expired" })
    expect(floor.renew(took.id)).toBeNull()
  })

  it("frees itself when the holder's process is gone", () => {
    vi.useFakeTimers()
    let running = true
    const ends: (string | null)[] = []
    const floor = new Floor({ alive: () => running, onChange: (v) => ends.push(v.ended) })
    expect(floor.take({ holder: "Tour", pid: 4242, seconds: 600 }).ok).toBe(true)
    vi.advanceTimersByTime(5_000)
    expect(floor.view().held).toBe(true)
    running = false
    vi.advanceTimersByTime(2_500)
    expect(floor.view()).toMatchObject({ held: false, ended: "holder gone" })
    expect(ends).toEqual([null, "holder gone"])
  })

  it("refuses a holder with no name, a time over the limit, and a process that does not run", () => {
    const floor = new Floor({ alive: () => false, settings: () => ({ maxSeconds: 60 }) })
    expect(floor.take({ holder: "  " })).toMatchObject({ ok: false, reason: "invalid" })
    expect(floor.take({ holder: "Tour", seconds: 61 })).toMatchObject({ ok: false, reason: "invalid" })
    expect(floor.take({ holder: "Tour", seconds: 0 })).toMatchObject({ ok: false, reason: "invalid" })
    expect(floor.take({ holder: "Tour", pid: 99999 })).toMatchObject({ ok: false, reason: "invalid" })
    expect(floor.view().held).toBe(false)
  })

  it("is off when voice.floor.enabled is false", () => {
    expect(new Floor({ settings: () => ({ enabled: false }) }).take({ holder: "Tour" })).toMatchObject({ ok: false, reason: "off" })
  })

  it("the owner takes it back, whoever holds it", () => {
    const floor = new Floor()
    const took = floor.take({ holder: "Tour" })
    if (!took.ok) throw new Error("refused")
    expect(floor.revoke()).toBe(true)
    expect(floor.view()).toMatchObject({ held: false, ended: "owner" })
    expect(floor.holds(took.id)).toBe(false)
    expect(floor.revoke()).toBe(false)
  })

  it("a waiting client hears of the next change at once", async () => {
    const floor = new Floor()
    const waiting = floor.next(floor.view().seq)
    floor.take({ holder: "Tour" })
    expect(await waiting).toMatchObject({ held: true, holder: "Tour" })
    // Behind the floor: answered at once.
    expect(await floor.next(0)).toMatchObject({ held: true })
  })

  it("says who holds it in one line", () => {
    const floor = new Floor({ now: () => 0 })
    expect(describeFloor(floor.view(), 0)).toBe("The floor is free.")
    floor.take({ holder: "Product tour", seconds: 90, sound: true, hide: true })
    expect(describeFloor(floor.view(), 0)).toBe("The floor is held by Product tour (plays sound, character and bubbles hidden) for up to 90 more seconds: other lines wait until it is free.")
  })
})

describe("the speaking queue under a floor", () => {
  it("an answer that is ready while the floor is held is kept, and said when it is free", async () => {
    const { svc, speech, plays } = service()
    const took = svc.floor.take({ holder: "Tour", sound: true })
    if (!took.ok) throw new Error("refused")
    const answer = speech.say(line("the answer"))
    await sleep(40)
    expect(plays()).toEqual([])
    expect(speech.view()).toMatchObject({ reserved: true, playing: null })
    expect(speech.view().waiting.map((i) => i.text)).toEqual(["the answer"])
    svc.floor.release(took.id)
    expect(await answer).toBe(true)
    expect(plays()).toEqual(["play the answer"])
  })

  it("a line playing when the floor is taken is cut, and plays again from the start after", async () => {
    const { svc, speech, log } = service()
    const answer = speech.say(line("long answer"))
    await sleep(5)
    const took = svc.floor.take({ holder: "Tour" })
    if (!took.ok) throw new Error("refused")
    expect(log).toEqual(["play long answer", "kill long answer"])
    await sleep(30)
    svc.floor.release(took.id)
    expect(await answer).toBe(true)
    expect(log).toEqual(["play long answer", "kill long answer", "play long answer"])
  })

  it("the holder's own lines play while it holds the floor, ahead of the lines that wait", async () => {
    const { svc, speech, plays } = service()
    const took = svc.floor.take({ holder: "Tour" })
    if (!took.ok) throw new Error("refused")
    const other = speech.say(line("someone else"))
    expect(await speech.say(line("the tour speaks", { floor: took.id, kind: "line" }))).toBe(true)
    expect(plays()).toEqual(["play the tour speaks"])
    svc.floor.release(took.id)
    expect(await other).toBe(true)
    expect(plays()).toEqual(["play the tour speaks", "play someone else"])
  })

  it("narration is dropped rather than said late", async () => {
    const { svc, speech, plays } = service()
    const took = svc.floor.take({ holder: "Tour" })
    if (!took.ok) throw new Error("refused")
    expect(await speech.say(line("reading the file", { kind: "narration" }))).toBe(false)
    expect(speech.view().waiting).toEqual([])
    svc.floor.release(took.id)
    await sleep(30)
    expect(plays()).toEqual([])
  })

  it("the listener's pause and resume do not let a waiting line through", async () => {
    const { svc, speech, plays } = service()
    const took = svc.floor.take({ holder: "Tour" })
    if (!took.ok) throw new Error("refused")
    void speech.say(line("the answer"))
    svc.handle("POST", "/voice/hush", {})
    svc.handle("POST", "/voice/door", { text: "what was that" })
    await sleep(30)
    expect(plays()).toEqual([])
    expect(svc.floor.view().held).toBe(true)
  })

  it("the queue says who holds the floor, to a client and to an agent", async () => {
    const { svc, speech } = service()
    svc.floor.take({ holder: "Tour" })
    void speech.say(line("the answer"))
    const reply = await handleQueue(speech, () => voice, "GET", "/voice/queue", {}, svc.floor)
    expect(reply.body).toMatchObject({ reserved: true, floor: { held: true, holder: "Tour" } })
    const said = describeQueue(reply.body as never)
    expect(said).toContain("The floor is held by Tour")
    expect(said).toContain('1. waiting: a (answer): "the answer"')
  })

  it("a line queued over HTTP with the holder's id plays; without it, it waits", async () => {
    const { svc, speech, plays } = service()
    const took = svc.floor.take({ holder: "Tour" })
    if (!took.ok) throw new Error("refused")
    const waits = await handleQueue(speech, () => voice, "POST", "/voice/queue", { text: "agent line", agentId: "a" }, svc.floor)
    expect(waits.status).toBe(202)
    const played = await handleQueue(speech, () => voice, "POST", "/voice/queue", { text: "tour line", agentId: "a", floor: took.id, wait: true }, svc.floor)
    expect(played.body).toMatchObject({ played: true })
    expect(plays()).toEqual(["play tour line"])
  })
})

describe("talks, lessons and the owner's stop under a floor", () => {
  it("a talk or a lesson is refused while the floor is held, and told who holds it", () => {
    const { svc } = service()
    svc.floor.take({ holder: "Tour" })
    const talk = svc.handle("POST", "/talk", { agents: ["a", "b"], topic: "x" })
    expect(talk.status).toBe(409)
    expect(talk.body).toMatchObject({ error: "The floor is held by Tour", floor: { holder: "Tour" } })
    expect(svc.startLesson("a", "show me", "teach").status).toBe(409)
    expect(svc.live).toBeNull()
  })

  it("the floor cannot be taken from a running talk", () => {
    const { svc } = service()
    ;(svc as any).session = { state: "running", stop() {}, hush() {} }
    expect(svc.floor.take({ holder: "Tour" })).toMatchObject({ ok: false, reason: "busy", error: "The floor is taken by a talk" })
  })

  it("the stop hotkey takes the floor back and empties the queue", async () => {
    const { svc, speech, logs } = service()
    const took = svc.floor.take({ holder: "Tour", sound: true, hide: true })
    if (!took.ok) throw new Error("refused")
    const waiting = speech.say(line("the answer"))
    const reply = svc.handle("POST", "/voice/stop", {})
    expect(reply.body).toMatchObject({ floorRevoked: true })
    expect(svc.floor.view()).toMatchObject({ held: false, ended: "owner" })
    expect(svc.floor.holds(took.id)).toBe(false)
    expect(await waiting).toBe(false)
    expect(speech.view()).toMatchObject({ reserved: false, waiting: [] })
    expect(logs.filter((l) => l.startsWith("[floor]"))).toEqual([
      expect.stringMatching(/^\[floor\] held by Tour until .*, plays sound, character and bubbles hidden$/),
      "[floor] free (owner)",
    ])
  })

  it("a renewal is not announced as a new hold", () => {
    const { svc, logs, views } = service()
    const took = svc.floor.take({ holder: "Tour" })
    if (!took.ok) throw new Error("refused")
    svc.floor.renew(took.id, 300)
    expect(logs.filter((l) => l.startsWith("[floor]"))).toHaveLength(1)
    expect(views).toHaveLength(2)
  })

  it("follows voice.floor from the settings", () => {
    const { svc } = service({}, { floor: { enabled: true, defaultSeconds: 10, maxSeconds: 20 } })
    expect(svc.floor.take({ holder: "Tour", seconds: 21 })).toMatchObject({ ok: false, reason: "invalid" })
    const took = svc.floor.take({ holder: "Tour" })
    expect(took.ok && took.view.expiresAt! - took.view.since!).toBe(10_000)
  })
})

describe("the character under a floor", () => {
  const guide = (svc: VoiceTalkService, body: Record<string, unknown>) => handleGuide(svc.guide, true, "POST", none, body, undefined, svc.floor)

  it("goes only where the holder sends it", async () => {
    const { svc } = service()
    void svc.guide.next(0)
    expect((await guide(svc, { rect })).status).toBe(200)
    const took = svc.floor.take({ holder: "Tour" })
    if (!took.ok) throw new Error("refused")
    // Taking the floor sends it home.
    expect(svc.guide.current.rect).toBeNull()
    const refused = await guide(svc, { rect, text: "look here" })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ shown: false, error: "The floor is held by Tour", floor: { holder: "Tour" } })
    expect(svc.guide.current.rect).toBeNull()
    expect((await guide(svc, { rect, floor: took.id })).status).toBe(200)
    expect(svc.guide.current.rect).toEqual(rect)
  })

  it("stays hidden for a recording, even for the holder", async () => {
    const { svc } = service()
    void svc.guide.next(0)
    const took = svc.floor.take({ holder: "Screen recording", hide: true })
    if (!took.ok) throw new Error("refused")
    const refused = await guide(svc, { rect, floor: took.id })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ error: "The character is hidden while Screen recording holds the floor" })
  })
})

describe("the floor over HTTP", () => {
  const call = (floor: Floor, method: string, path: string, body: Record<string, unknown> = {}, query = none) => handleFloor(floor, method, path, query, body)

  it("take, see, renew, release", async () => {
    const floor = new Floor()
    expect((await call(floor, "GET", "/voice/floor")).body).toMatchObject({ held: false })
    const took = await call(floor, "POST", "/voice/floor", { holder: "Tour", seconds: 60, sound: true })
    expect(took.status).toBe(201)
    const id = (took.body as { id: string }).id
    expect(took.body).toMatchObject({ held: true, holder: "Tour", sound: true })
    expect((await call(floor, "GET", "/voice/floor")).body).not.toHaveProperty("id")
    expect((await call(floor, "GET", `/voice/floor/${id}`)).status).toBe(200)
    expect((await call(floor, "POST", `/voice/floor/${id}/renew`, { seconds: 120 })).status).toBe(200)
    expect((await call(floor, "POST", `/voice/floor/${id}/release`)).body).toMatchObject({ released: true, held: false })
    expect((await call(floor, "POST", `/voice/floor/${id}/release`)).body).toMatchObject({ released: false })
  })

  it("409 with the holder for a second take, 400 for a bad one, 403 when off", async () => {
    const floor = new Floor()
    await call(floor, "POST", "/voice/floor", { holder: "Tour" })
    const second = await call(floor, "POST", "/voice/floor", { holder: "Recording" })
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ error: "The floor is held by Tour", floor: { holder: "Tour" } })
    expect((await call(new Floor(), "POST", "/voice/floor", {})).status).toBe(400)
    expect((await call(new Floor({ settings: () => ({ enabled: false }) }), "POST", "/voice/floor", { holder: "Tour" })).status).toBe(403)
  })

  it("410 to a holder whose floor was taken back", async () => {
    const floor = new Floor()
    const id = ((await call(floor, "POST", "/voice/floor", { holder: "Tour" })).body as { id: string }).id
    expect((await call(floor, "DELETE", "/voice/floor")).body).toMatchObject({ revoked: true, held: false, ended: "owner" })
    expect((await call(floor, "POST", `/voice/floor/${id}/renew`)).status).toBe(410)
    expect((await call(floor, "GET", `/voice/floor/${id}`)).status).toBe(410)
  })

  it("DELETE with the id releases it", async () => {
    const floor = new Floor()
    const id = ((await call(floor, "POST", "/voice/floor", { holder: "Tour" })).body as { id: string }).id
    expect((await call(floor, "DELETE", `/voice/floor/${id}`)).body).toMatchObject({ released: true, ended: "released" })
  })

  it("?after waits for the next change", async () => {
    const floor = new Floor()
    const waiting = call(floor, "GET", "/voice/floor", {}, new URLSearchParams(`after=${floor.view().seq}`))
    floor.take({ holder: "Tour" })
    expect((await waiting).body).toMatchObject({ held: true, holder: "Tour" })
  })
})

describe("voice.floor in the config", () => {
  it("is on by default, two minutes a take and half an hour at most", () => {
    expect(daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: {} }).voice.floor).toEqual({ enabled: true, defaultSeconds: 120, maxSeconds: 1800 })
  })
})
