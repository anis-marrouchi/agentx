import { describe, it, expect } from "vitest"
import { EventEmitter } from "events"
import type { ChildProcess } from "child_process"
import { SentenceCutter, speakable } from "../src/voice/sentences"
import { SpeechOut, speakLimitMs, type Play, type Synth } from "../src/voice/speaker"
import { Channel, type LineModel } from "../src/voice/talk-model"
import { Talk, type TalkEvent, type TalkSpeaker } from "../src/voice/talk"

const ref = (elevenlabs: string) => ({ provider: "system" as const, elevenlabs, system: null, fallback: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A player that "plays" for `ms` and can be killed, like afplay. */
function fakeAudio(ms: number, log: string[]) {
  const play: Play = (_file, u) => {
    const p = new EventEmitter() as ChildProcess
    log.push(`play ${u.text}`)
    const timer = setTimeout(() => p.emit("close", 0), ms)
    ;(p as any).kill = () => { clearTimeout(timer); log.push(`kill ${u.text}`); p.emit("close", null) }
    return p
  }
  const synth: Synth = async () => null
  return { play, synth }
}

/** A model that answers from a script, a few characters at a time. */
class ScriptModel implements LineModel {
  messages: string[] = []
  calls: number[] = []
  closed = false
  constructor(private lines: string[]) {}
  reply(message: string, signal?: AbortSignal): AsyncIterable<string> {
    this.messages.push(message)
    this.calls.push(Date.now())
    const text = this.lines.shift() ?? "Nothing more. DONE"
    const out = new Channel<string>()
    void (async () => {
      for (let i = 0; i < text.length; i += 12) { await sleep(2); out.push(text.slice(i, i + 12)) }
      out.end()
    })()
    return out.read(signal)
  }
  close() { this.closed = true }
}

const speakers: [TalkSpeaker, TalkSpeaker] = [
  { agentId: "secretary-agent", name: "Secretary", voice: ref("v1"), persona: "You are the Secretary." },
  { agentId: "marketing-agent", name: "Nadia", voice: ref("v2"), persona: "You are Nadia." },
]

function setup(scripts: [string[], string[]], playMs = 30) {
  const log: string[] = []
  const { play, synth } = fakeAudio(playMs, log)
  const speech = new SpeechOut(synth, play)
  const models = [new ScriptModel(scripts[0]), new ScriptModel(scripts[1])]
  let k = 0
  const talk = new Talk({ topic: "the launch", speakers, speech, model: () => models[k++], holdMs: 200 })
  const events: TalkEvent[] = []
  talk.on((e) => events.push(e))
  return { talk, models, log, events }
}

describe("SentenceCutter", () => {
  it("emits sentences as they complete and the rest on flush", () => {
    const c = new SentenceCutter()
    expect(c.push("Hello the")).toEqual([])
    expect(c.push("re. How are")).toEqual(["Hello there."])
    expect(c.push(" you? Fine")).toEqual(["How are you?"])
    expect(c.flush()).toEqual(["Fine"])
  })

  it("strips what cannot be spoken", () => {
    expect(speakable("**Done** — see [the MR](https://x.y/1) 🚀")).toBe("Done — see the MR")
  })
})

describe("SpeechOut", () => {
  it("plays in order even when later audio is ready first, and stop drops the queue", async () => {
    const log: string[] = []
    const { play } = fakeAudio(20, log)
    const synth: Synth = async (u) => { await sleep(u.text === "one" ? 30 : 1); return null }
    const s = new SpeechOut(synth, play)
    const a = s.say({ voice: ref("v"), text: "one" })
    const b = s.say({ voice: ref("v"), text: "two" })
    expect(await a).toBe(true)
    const c = s.say({ voice: ref("v"), text: "three" })
    await sleep(5)
    s.stop()
    expect(await b).toBe(false)
    expect(await c).toBe(false)
    expect(log[0]).toBe("play one")
    expect(log).not.toContain("play three")
  })

  it("kills a player that runs past its line's bound, and the next line plays", async () => {
    const log: string[] = []
    const { play, synth } = fakeAudio(60_000, log)
    const s = new SpeechOut(synth, play, {}, (text) => (text === "hung" ? 30 : 60_000))
    const hung = s.say({ voice: ref("v"), text: "hung" })
    const next = s.say({ voice: ref("v"), text: "next" })
    expect(await hung).toBe(false)
    await sleep(5)
    expect(log.slice(0, 3)).toEqual(["play hung", "kill hung", "play next"])
    s.stop()
    expect(await next).toBe(false)
  })

  it("bounds a line by its length, with a hard cap", () => {
    expect(speakLimitMs("")).toBe(5_000)
    expect(speakLimitMs("one two three four five six seven eight nine ten")).toBe(11_000)
    expect(speakLimitMs("word ".repeat(2_000))).toBe(300_000)
  })
})

describe("Talk", () => {
  it("alternates speakers, speaks sentence by sentence, and ends when settled", async () => {
    const { talk, models, log, events } = setup([
      ["Launch is Monday. Nadia, copy ready?", "Great, we're set. DONE"],
      ["Copy is ready. Visuals too."],
    ])
    await talk.run()
    expect(talk.transcript.map((l) => l.name)).toEqual(["Secretary", "Nadia", "Secretary"])
    expect(log.filter((l) => l.startsWith("play"))).toEqual([
      "play Launch is Monday.", "play Nadia, copy ready?", "play Copy is ready.", "play Visuals too.", "play Great, we're set.",
    ])
    expect(models[1].messages[0]).toContain("Secretary said: Launch is Monday. Nadia, copy ready?")
    expect(events.at(-1)).toEqual({ type: "end", reason: "settled" })
    expect(models.every((m) => m.closed)).toBe(true)
    expect(talk.gaps.length).toBe(2)
  })

  it("writes the next reply while the current one is still being spoken", async () => {
    const { talk, models, log } = setup([["One. Two. Three.", "Bye. DONE"], ["Four."]], 40)
    let lastPlayOfFirst = 0
    const orig = log.push.bind(log)
    log.push = (...xs: string[]) => { if (xs[0] === "play Three.") lastPlayOfFirst = Date.now(); return orig(...xs) }
    await talk.run()
    expect(models[1].calls[0]).toBeLessThan(lastPlayOfFirst)
    // Measured from the end of the previous speaker's LAST line: well under
    // one 40 ms line, since the reply was ready before that line ended.
    expect(talk.gaps.length).toBe(2)
    expect(Math.max(...talk.gaps)).toBeLessThan(40)
  })

  it("cuts in through the door: silence now, the named agent answers the listener first", async () => {
    const { talk, models, log, events } = setup([
      ["First point. Second point. Third point.", "Sure. DONE"],
      ["Something unheard.", "Pricing stays as is. DONE"],
    ], 60)
    const done = talk.run()
    await sleep(80)
    talk.door("Nadia, what about pricing?")
    await done
    expect(log.some((l) => l.startsWith("kill"))).toBe(true)
    const nadia = models[1].messages.at(-1)!
    expect(nadia).toContain('Anis just said: "Nadia, what about pricing?"')
    expect(nadia).toContain("Secretary was cut off after saying")
    // Nadia's pre-written line was never heard, so the Secretary never gets it.
    expect(models[0].messages.join("\n")).not.toContain("Something unheard")
    expect(talk.transcript.map((l) => l.text).join(" ")).not.toContain("Something unheard")
    expect(events.some((e) => e.type === "door")).toBe(true)
    expect(log).toContain("play Pricing stays as is.")
  })

  it("hush holds everyone until the listener speaks; stop ends the talk", async () => {
    const { talk, models, events } = setup([["A long line. And more. And more still."], ["Reply."]], 60)
    const done = talk.run()
    await sleep(50)
    talk.hush()
    expect(talk.state).toBe("held")
    await sleep(20)
    talk.door("stop")
    await done
    expect(talk.state).toBe("ended")
    expect(events.at(-1)).toEqual({ type: "end", reason: "stopped by the listener" })
    expect(models.every((m) => m.closed)).toBe(true)
  })
})

describe("CliLineModel", () => {
  const fake = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname

  it("streams a reply, and an abort interrupts the turn so the next starts cleanly", async () => {
    const { CliLineModel } = await import("../src/voice/talk-model")
    const m = new CliLineModel({ system: "x" }, fake)
    let text = ""
    for await (const d of m.reply("hello")) text += d
    expect(text).toBe("You said hello. That is all.")

    const ac = new AbortController()
    let cut = ""
    const t0 = Date.now()
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")
    for await (const d of m.reply(long, ac.signal)) { cut += d; if (cut.split(" ").length >= 2) ac.abort() }
    expect(cut.split(" ").length).toBeLessThan(4)

    let next = ""
    for await (const d of m.reply("again")) next += d
    expect(next).toBe("You said again. That is all.")
    // Interrupted, not drained: draining the long reply would take ~900 ms.
    expect(Date.now() - t0).toBeLessThan(400)
    m.close()
  })
})
