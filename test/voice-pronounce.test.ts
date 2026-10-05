import { describe, it, expect } from "vitest"
import { EventEmitter } from "events"
import { createServer } from "http"
import type { ChildProcess } from "child_process"
import { pronounce, pronouncer, pronunciationRules } from "../src/voice/pronounce"
import type { Play, Synth, Utterance } from "../src/voice/speaker"
import { SpeechOut } from "../src/voice/speaking-queue"
import { daemonConfigSchema } from "../src/daemon/config"
import { applyVoiceSettings, checkVoiceSettings, voiceSettingsView } from "../src/daemon/voice-settings-api"
import { handleVoiceIo, type VoiceIoDeps } from "../src/daemon/voice-io-api"
import { setPronunciation } from "../src/commands/voice"

// #433: a word said the way its owner says it, written the way it is spelt.

const say = (text: string, pairs: any[] = [], people: any[] = []) => pronounce(text, pronunciationRules(pairs, people))

describe("pronounce", () => {
  it("says the spoken form for a whole word, without case", () => {
    const pairs = [{ written: "Okafor", spoken: "Oh-kah-for" }]
    expect(say("Thanks, Okafor. okafor said OKAFOR!", pairs)).toBe("Thanks, Oh-kah-for. Oh-kah-for said Oh-kah-for!")
  })

  it("leaves a word that only contains the written form alone", () => {
    const pairs = [{ written: "Ana", spoken: "Ah-na" }]
    expect(say("Banana, Anabel and Ana.", pairs)).toBe("Banana, Anabel and Ah-na.")
    // Letters of any script count as part of a word.
    expect(say("Anaé", pairs)).toBe("Anaé")
  })

  it("changes nothing with no pairs", () => {
    expect(say("Hello Okafor")).toBe("Hello Okafor")
  })

  it("takes the longest written form first and reads each word once", () => {
    const pairs = [
      { written: "Siobhan", spoken: "Shiv-awn" },
      { written: "Siobhan Okafor", spoken: "Shiv-awn Oh-kah-for" },
      // A spoken form that holds another written form is not swapped again.
      { written: "SQL", spoken: "sequel Siobhan" },
    ]
    expect(say("Siobhan  Okafor ran SQL.", pairs)).toBe("Shiv-awn Oh-kah-for ran sequel Siobhan.")
  })

  it("applies a pair limited to languages only to lines in those languages", () => {
    const pairs = [{ written: "Okafor", spoken: "Oh-kah-for", languages: ["en"] }]
    expect(say("This is for Okafor.", pairs)).toBe("This is for Oh-kah-for.")
    expect(say("C'est pour Okafor, merci.", pairs)).toBe("C'est pour Okafor, merci.")
  })

  it("covers a person's full name and each capitalised name word", () => {
    const people = [{ name: "Will Okafor", say: "Wil Oh-kah-for" }]
    expect(say("Will Okafor called. Will said hi; Okafor will call back.", [], people))
      .toBe("Wil Oh-kah-for called. Wil said hi; Oh-kah-for will call back.")
  })

  it("lets an explicit pair win over a person's", () => {
    const people = [{ name: "Okafor", say: "Oh-kah-for" }]
    expect(say("Okafor", [{ written: "okafor", spoken: "Oh-KAH-for" }], people)).toBe("Oh-KAH-for")
  })

  it("rebuilds its rules only when the setting changes", () => {
    let cfg: any = { pairs: [{ written: "Okafor", spoken: "A" }], people: [] }
    const p = pronouncer(() => cfg)
    expect(p("Okafor")).toBe("A")
    cfg = { pairs: [{ written: "Okafor", spoken: "B" }], people: [] }
    expect(p("Okafor")).toBe("B")
  })
})

describe("the speaking queue", () => {
  it("speaks the spoken form while the queue and its events keep the written one", async () => {
    const synthed: string[] = [], played: string[] = [], started: string[] = []
    const synth: Synth = async (u) => { synthed.push(u.text); return null }
    const play: Play = (_f, u) => {
      played.push(u.text)
      const p = new EventEmitter() as ChildProcess
      setTimeout(() => p.emit("close", 0), 5)
      ;(p as any).kill = () => p.emit("close", null)
      return p
    }
    const s = new SpeechOut(synth, play, { onStart: (u) => started.push(u.text) }, () => 60_000)
    s.pronounce = (t) => say(t, [{ written: "Okafor", spoken: "Oh-kah-for" }])
    const line: Utterance = { voice: { provider: "system", elevenlabs: "", system: null, fallback: true }, text: "Hi Okafor", agentId: "a", kind: "answer" }
    const { item, done } = s.enqueue(line)
    expect(item.text).toBe("Hi Okafor")
    expect(await done).toBe(true)
    expect(synthed).toEqual(["Hi Oh-kah-for"])
    expect(played).toEqual(["Hi Oh-kah-for"])
    expect(started).toEqual(["Hi Okafor"])
    expect(s.view().recent[0].text).toBe("Hi Okafor")
  })
})

const rawConfig = () => ({
  node: { id: "n", name: "n" },
  agents: { writer: { name: "Writer", tier: "claude-code", workspace: "/tmp" } },
})

describe("the setting", () => {
  it("defaults to no pairs and takes a person's say", () => {
    const c = daemonConfigSchema.parse({ ...rawConfig(), people: [{ id: "sam", name: "Sam Okafor", say: "Sam Oh-kah-for" }] })
    expect(c.voice.pronunciations).toEqual([])
    expect(c.people[0].say).toBe("Sam Oh-kah-for")
  })

  it("is in the settings view and saved whole, or cleared", () => {
    const raw: any = rawConfig()
    applyVoiceSettings(raw, { general: { pronunciations: [{ written: " Okafor ", spoken: "Oh-kah-for", languages: [] }] } })
    expect(raw.voice.pronunciations).toEqual([{ written: "Okafor", spoken: "Oh-kah-for" }])
    const c = daemonConfigSchema.parse(raw)
    expect(voiceSettingsView(c, []).general.pronunciations).toEqual([{ written: "Okafor", spoken: "Oh-kah-for" }])
    applyVoiceSettings(raw, { general: { pronunciations: null } })
    expect(raw.voice.pronunciations).toBeUndefined()
  })

  it("refuses an empty form, an unknown language, a stray field and a word set twice", () => {
    const c = daemonConfigSchema.parse(rawConfig())
    const check = (pronunciations: any) => checkVoiceSettings({ general: { pronunciations } }, c).map((e) => e.path)
    expect(check([{ written: "", spoken: "x" }])).toEqual(["general.pronunciations.0.written"])
    expect(check([{ written: "x", spoken: "y", languages: ["de"] }])).toEqual(["general.pronunciations.0.languages"])
    expect(check([{ written: "x", spoken: "y", note: 1 }])).toEqual(["general.pronunciations.0.note"])
    expect(check([{ written: "Okafor", spoken: "a" }, { written: "okafor", spoken: "b" }])).toEqual(["general.pronunciations.1.written"])
    expect(check("Okafor")).toEqual(["general.pronunciations"])
    expect(check([{ written: "Okafor", spoken: "Oh-kah-for", languages: ["fr"] }])).toEqual([])
  })

  it("is set and removed by the CLI's list edit", () => {
    const one = setPronunciation([], "Okafor", "Oh-kah-for", ["en"])
    expect(one).toEqual([{ written: "Okafor", spoken: "Oh-kah-for", languages: ["en"] }])
    expect(setPronunciation(one, "OKAFOR", "Oh-KAH-for")).toEqual([{ written: "OKAFOR", spoken: "Oh-KAH-for" }])
    expect(setPronunciation(one, "okafor", null)).toEqual([])
    expect(() => setPronunciation(one, "Nobody", null)).toThrow(/No pronunciation/)
  })
})

describe("the phone's answer", () => {
  it("is synthesised and handed back in the spoken form", async () => {
    const spoken: string[] = []
    let provider: "elevenlabs" | "system" = "elevenlabs"
    const deps: VoiceIoDeps = {
      stt: () => "auto",
      host: () => ({ key: "k", mlx: null, whisper: null, ffmpeg: null }),
      voiceOf: () => ({ provider, elevenlabs: "v", system: null, fallback: true }),
      elevenLabsKey: () => "k",
      log: () => {},
      synth: async (_k, _v, text) => { spoken.push(text); return Buffer.from("ID3") },
      pronounce: (t) => say(t, [{ written: "Okafor", spoken: "Oh-kah-for" }]),
    }
    const server = createServer((req, res) => { void handleVoiceIo(req, res, "/voice/speak", deps) })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(server.address() as any).port}/voice/speak`
    const post = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "a", text: "Hi **Okafor**." }) })
    try {
      expect((await post()).status).toBe(200)
      expect(spoken).toEqual(["Hi Oh-kah-for."])
      provider = "system"
      expect(await (await post()).json()).toMatchObject({ fallback: "browser", text: "Hi Oh-kah-for." })
    } finally {
      server.close()
    }
  })
})
