import { describe, it, expect } from "vitest"
import { EventEmitter } from "events"
import { existsSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { ChildProcess } from "child_process"
import type { Play, Synth, Utterance } from "../src/voice/speaker"
import { SpeechOut, type QueueView } from "../src/voice/speaking-queue"
import { describeQueue, handleQueue } from "../src/daemon/voice-queue-api"
import { VoiceTalkService } from "../src/daemon/voice-talk-api"
import { VoiceIntroTracker } from "../src/voice/agent-voice"

// #155: one speaking queue for everything said on the host.

const voice = { provider: "system" as const, elevenlabs: "v", system: null, fallback: true }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const line = (text: string, agentId = "a", kind: Utterance["kind"] = "answer"): Utterance => ({ voice, text, agentId, kind })

/** A player that "plays" for `ms` and can be killed, like afplay. */
function fakeAudio(ms = 20) {
  const log: string[] = []
  const play: Play = (_file, u) => {
    const p = new EventEmitter() as ChildProcess
    log.push(`play ${u.text}`)
    const timer = setTimeout(() => p.emit("close", 0), ms)
    ;(p as any).kill = () => { clearTimeout(timer); log.push(`kill ${u.text}`); p.emit("close", null) }
    return p
  }
  const synth: Synth = async () => null
  return { play, synth, log }
}

function queue(ms = 20, holdMs = 60_000) {
  const { play, synth, log } = fakeAudio(ms)
  const views: QueueView[] = []
  const s = new SpeechOut(synth, play, { onChange: (v) => views.push(v) }, () => 60_000, holdMs)
  return { s, log, views, plays: () => log.filter((l) => l.startsWith("play")) }
}

describe("SpeechOut as the speaking queue", () => {
  it("an answer that arrives while another agent speaks waits and plays right after", async () => {
    const { s, plays } = queue()
    const a = s.say(line("A speaks", "agent-a"))
    await sleep(5)
    const b = s.say(line("B answers", "agent-b"))
    expect(s.view().playing).toMatchObject({ agentId: "agent-a", text: "A speaks" })
    expect(s.view().waiting.map((i) => i.agentId)).toEqual(["agent-b"])
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(plays()).toEqual(["play A speaks", "play B answers"])
    expect(s.view().recent.map((i) => i.text)).toEqual(["B answers", "A speaks"])
  })

  it("pause cuts the line and holds the queue; resume plays it again, then the rest", async () => {
    const { s, log, plays } = queue()
    const a = s.say(line("one"))
    const b = s.say(line("two"))
    await sleep(5)
    s.pause()
    expect(log).toContain("kill one")
    expect(s.view()).toMatchObject({ paused: true, playing: null })
    expect(s.view().waiting.map((i) => i.text)).toEqual(["one", "two"])
    await sleep(40)
    expect(plays()).toEqual(["play one"])
    s.resume()
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(plays()).toEqual(["play one", "play one", "play two"])
  })

  it("a held queue resumes by itself when the listener never comes back", async () => {
    const { s, plays } = queue(10, 30)
    s.pause()
    const a = s.say(line("later"))
    await sleep(10)
    expect(plays()).toEqual([])
    expect(await a).toBe(true)
    expect(s.paused).toBe(false)
  })

  it("skipping one of three drops it and keeps the order of the rest", async () => {
    const { s, plays } = queue()
    const [a, b, c] = ["first", "second", "third"].map((t) => s.say(line(t)))
    const second = s.view().waiting.find((i) => i.text === "second")!
    expect(s.skip(second.id)).toBe(true)
    expect(s.skip("nope")).toBe(false)
    expect(await Promise.all([a, b, c])).toEqual([true, false, true])
    expect(plays()).toEqual(["play first", "play third"])
  })

  it("skipping the line that is playing moves on to the next", async () => {
    const { s, log } = queue()
    const a = s.say(line("long"))
    const b = s.say(line("next"))
    await sleep(5)
    expect(s.skip(s.view().playing!.id)).toBe(true)
    expect(await a).toBe(false)
    expect(await b).toBe(true)
    expect(log).toEqual(["play long", "kill long", "play next"])
  })

  it("stop drops everything and stops holding", async () => {
    const { s, plays } = queue()
    const a = s.say(line("one"))
    const b = s.say(line("two"))
    await sleep(5)
    s.pause()
    s.stop()
    expect(await a).toBe(false)
    expect(await b).toBe(false)
    expect(s.view()).toEqual({ paused: false, playing: null, waiting: [], recent: [] })
    expect(await s.say(line("after"))).toBe(true)
    expect(plays()).toEqual(["play one", "play after"])
  })

  it("front moves a waiting line next; replay says a line again, next", async () => {
    const { s, plays } = queue()
    s.say(line("one"))
    s.say(line("two"))
    const three = s.say(line("three"))
    const id3 = s.view().waiting.at(-1)!.id
    expect(s.front(id3)).toBe(true)
    await three
    await sleep(30)
    expect(plays()).toEqual(["play one", "play three", "play two"])
    const again = s.replay(id3)
    expect(again).toMatchObject({ text: "three", kind: "answer" })
    expect(again!.id).not.toBe(id3)
    await sleep(30)
    expect(plays().at(-1)).toBe("play three")
    expect(s.replay("nope")).toBeNull()
  })

  it("cancel drops one kind — a talk silencing itself — and leaves answers queued", async () => {
    const { s, plays } = queue()
    const t = s.say(line("talk line", "a", "talk"))
    const ans = s.say(line("an answer", "b", "answer"))
    const t2 = s.say(line("talk again", "a", "talk"))
    await sleep(5)
    s.cancel("talk")
    expect(await t).toBe(false)
    expect(await t2).toBe(false)
    expect(await ans).toBe(true)
    expect(plays()).toEqual(["play talk line", "play an answer"])
  })

  it("reports every change", async () => {
    const { s, views } = queue()
    await s.say(line("hi"))
    expect(views.some((v) => v.waiting.length === 1)).toBe(true)
    expect(views.some((v) => v.playing?.text === "hi")).toBe(true)
    expect(views.at(-1)).toMatchObject({ playing: null, waiting: [], recent: [{ text: "hi" }] })
  })

  it("keeps a cut line's audio for the replay after a pause, and deletes it once done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-"))
    const file = join(dir, "a.mp3")
    const { play } = fakeAudio(20)
    const s = new SpeechOut(async () => { writeFileSync(file, "x"); return file }, play)
    const a = s.say(line("one"))
    await sleep(5)
    s.pause()
    await sleep(5)
    expect(existsSync(file)).toBe(true)
    s.resume()
    expect(await a).toBe(true)
    await sleep(1)
    expect(existsSync(file)).toBe(false)
  })
})

describe("the queue over HTTP", () => {
  const voiceOf = (id: string) => (id === "a" || id === "b" ? voice : null)

  it("queues a line in the agent's voice, lists it, and validates", async () => {
    const { s } = queue()
    expect((await handleQueue(s, voiceOf, "POST", "/voice/queue", { text: "" })).status).toBe(400)
    expect((await handleQueue(s, voiceOf, "POST", "/voice/queue", { text: "x", agentId: "a", kind: "talk" })).status).toBe(400)
    expect((await handleQueue(s, voiceOf, "POST", "/voice/queue", { text: "x", agentId: "nobody" })).status).toBe(404)
    expect((await handleQueue(s, voiceOf, "POST", "/voice/queue", { text: "x".repeat(5_001), agentId: "a" })).status).toBe(413)
    const r = await handleQueue(s, voiceOf, "POST", "/voice/queue", { text: "Hello.", agentId: "a", kind: "answer" })
    expect(r.status).toBe(202)
    expect((r.body as any).item).toMatchObject({ agentId: "a", kind: "answer", text: "Hello." })
    expect(((await handleQueue(s, voiceOf, "GET", "/voice/queue", {})).body as QueueView).playing?.text).toBe("Hello.")
  })

  it("with wait, answers once the line has played", async () => {
    const { s } = queue()
    const r = await handleQueue(s, voiceOf, "POST", "/voice/queue", { text: "Done.", agentId: "b", wait: true })
    expect(r).toMatchObject({ status: 200, body: { played: true, item: { text: "Done." } } })
  })

  it("skip, front and replay by id; 404 for an unknown id or action", async () => {
    const { s } = queue()
    s.say(line("one")); s.say(line("two")); s.say(line("three"))
    const [two, three] = s.view().waiting
    expect((await handleQueue(s, voiceOf, "POST", `/voice/queue/${three.id}/front`, {})).status).toBe(200)
    expect(s.view().waiting.map((i) => i.text)).toEqual(["three", "two"])
    expect((await handleQueue(s, voiceOf, "POST", `/voice/queue/${two.id}/skip`, {})).status).toBe(200)
    expect(s.view().waiting.map((i) => i.text)).toEqual(["three"])
    expect((await handleQueue(s, voiceOf, "POST", `/voice/queue/${three.id}/replay`, {})).status).toBe(202)
    expect(s.view().waiting.map((i) => i.text)).toEqual(["three", "three"])
    expect((await handleQueue(s, voiceOf, "POST", "/voice/queue/nope/skip", {})).status).toBe(404)
    expect((await handleQueue(s, voiceOf, "POST", `/voice/queue/${three.id}/shout`, {})).status).toBe(404)
    s.stop()
  })

  it("describes the queue in plain lines for an agent", async () => {
    const { s } = queue()
    expect(describeQueue(s.view())).toBe("Nothing is speaking.")
    s.say(line("one", "coder-agent")); s.say(line("two", "secretary-agent", "narration"))
    const text = describeQueue(s.view())
    expect(text).toMatch(/^Speaking: coder-agent \(answer\): "one" \[s/)
    expect(text).toMatch(/\n1\. waiting: secretary-agent \(narration\): "two"/)
    s.pause()
    expect(describeQueue(s.view())).toMatch(/^Paused: the listener is speaking; the queue plays on after\.\n1\. waiting: coder-agent/)
    s.stop()
  })

  it("pause and resume hold and release the queue", async () => {
    const { s } = queue()
    expect(((await handleQueue(s, voiceOf, "POST", "/voice/queue/pause", {})).body as QueueView).paused).toBe(true)
    expect(((await handleQueue(s, voiceOf, "POST", "/voice/queue/resume", {})).body as QueueView).paused).toBe(false)
  })
})

describe("the door and the queue", () => {
  function service() {
    const q = queue()
    const svc = new VoiceTalkService(() => ({}) as any, new VoiceIntroTracker(), () => {}, { speech: q.s, stopSpeakers: () => {} })
    return { svc, ...q }
  }

  it("hush pauses a queued answer and names it; the listener's words resume it", async () => {
    const { svc, s, plays } = service()
    const a = s.say(line("Your build is green.", "coder-agent"))
    await sleep(5)
    expect(svc.handle("POST", "/voice/hush", {}).body).toEqual({ active: false, kind: "queue", agentId: "coder-agent" })
    expect(s.paused).toBe(true)
    expect(svc.handle("POST", "/voice/door", { text: "and the tests?" }).status).toBe(409)
    expect(s.paused).toBe(false)
    expect(await a).toBe(true)
    expect(plays()).toEqual(["play Your build is green.", "play Your build is green."])
  })

  it("a bare stop through the door empties the held queue", async () => {
    const { svc, s } = service()
    const a = s.say(line("one", "coder-agent"))
    s.say(line("two", "coder-agent"))
    await sleep(5)
    svc.handle("POST", "/voice/hush", {})
    expect(svc.handle("POST", "/voice/door", { text: "stop" }).body).toEqual({ active: false, kind: "queue", handled: true })
    expect(await a).toBe(false)
    expect(s.view()).toMatchObject({ paused: false, playing: null, waiting: [] })
  })

  it("/voice/stop empties the queue, nothing waits for the door", async () => {
    const { svc, s } = service()
    const a = s.say(line("one", "coder-agent"))
    await sleep(5)
    svc.handle("POST", "/voice/stop", {})
    expect(await a).toBe(false)
    expect(s.view()).toMatchObject({ paused: false, playing: null, waiting: [] })
  })
})
