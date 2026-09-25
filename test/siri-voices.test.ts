import { describe, it, expect, afterEach } from "vitest"
import { EventEmitter } from "events"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  acquireLock, isSiriId, listSiriVoices, parseSiriAsset, prefLanguage, selecting, siriSay,
  type PrefValue, type SpokenContentPref,
} from "../src/voice/siri-voices"
import { castVoices, candidates, findVoice, parseVoiceList, setVoiceLog } from "../src/voice/system-voices"
import { label, localSystemVoices } from "../src/voice/agent-voice"
import { sayArgs } from "../src/voice/speaker"
import { VoiceTalkService } from "../src/daemon/voice-talk-api"
import { VoiceIntroTracker } from "../src/voice/agent-voice"

const asset = (name: string, gender = "male") => `<?xml version="1.0"?><plist><dict>
<key>CFBundleName</key><string>com.apple.siri.tts.voice.${name}.neural.premium-iPhone</string>
<key>MobileAssetProperties</key><dict><key>gender</key>
  <string>${gender}</string></dict></dict></plist>`

const AARON = "com.apple.ttsbundle.gryphon-neural_aaron_en-US_premium"
const NORA = "com.apple.ttsbundle.gryphon-neural_nora_en-US_premium"
const MARIE = "com.apple.ttsbundle.gryphon-neural_marie_fr-FR_premium"

const SIRI = [parseSiriAsset(asset("en_US.aaron"))!, parseSiriAsset(asset("en_US.nora", "female"))!, parseSiriAsset(asset("fr_FR.marie", "female"))!, parseSiriAsset(asset("fr_FR.daniel"))!]
const INSTALLED = [...parseVoiceList([
  "com.apple.voice.compact.en-GB.Daniel\tDaniel\ten-GB\t1\t1",
  "com.apple.voice.compact.en-US.Samantha\tSamantha\ten-US\t1\t2",
  "com.apple.voice.compact.fr-FR.Thomas\tThomas\tfr-FR\t1\t1",
].join("\n")), ...SIRI]

const selection = (voiceId: string) => ({ _type: "Speech.VoiceSelection", _version: "0", voiceId })
const USER: PrefValue = { text: "(en, {voiceId = nora;})", entries: ["en", selection(NORA)] }

afterEach(() => setVoiceLog((m) => process.stderr.write(m + "\n")))

describe("Siri voices on disk", () => {
  it("reads a voice asset, and skips resource bundles", () => {
    expect(parseSiriAsset(asset("en_US.aaron"))).toEqual({ id: AARON, name: "Aaron", locale: "en-US", quality: "premium", gender: "male" })
    expect(parseSiriAsset(asset("fr_FR.marie", "female"))?.gender).toBe("female")
    expect(parseSiriAsset("<string>com.apple.siri.tts.resource.en_US-en_US-generic</string>")).toBeNull()
  })

  it.runIf(process.platform === "darwin")("lists the installed voices from the asset folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "siri-"))
    for (const [a, xml] of [["1.asset", asset("en_US.aaron")], ["2.asset", "<plist/>"]]) {
      mkdirSync(join(dir, a))
      writeFileSync(join(dir, a, "Info.plist"), xml)
    }
    mkdirSync(join(dir, "3.asset")) // still downloading: no Info.plist
    expect(listSiriVoices([dir, join(dir, "missing")]).map((v) => v.id)).toEqual([AARON])
  })
})

describe("naming a Siri voice", () => {
  it("siri:<name> finds the Siri voice; a plain name never does", () => {
    expect(findVoice("siri:aaron", INSTALLED)?.id).toBe(AARON)
    expect(findVoice("siri:daniel", INSTALLED, "fr")?.id).toBe("com.apple.ttsbundle.gryphon-neural_daniel_fr-FR_premium")
    expect(findVoice("Daniel", INSTALLED)?.id).toBe("com.apple.voice.compact.en-GB.Daniel")
    expect(label(findVoice("siri:nora", INSTALLED)!)).toBe("Nora (Siri) en-US")
  })

  it("a missing Siri voice falls back to the system voice of that name, in that language only", () => {
    setVoiceLog(() => {})
    const noSiri = INSTALLED.filter((v) => !isSiriId(v.id))
    expect(findVoice("siri:samantha", noSiri)?.name).toBe("Samantha")
    expect(findVoice("siri:daniel", noSiri, "fr")).toBeNull()
    expect(findVoice("siri:nobody", INSTALLED)).toBeNull()
  })

  it("is never assigned: casting and the ranked list leave Siri voices out", () => {
    expect(candidates(INSTALLED, "en").some((v) => isSiriId(v.id))).toBe(false)
    expect([...castVoices([{ id: "a" }, { id: "b" }, { id: "c" }], candidates(INSTALLED, "en")).values()].some((v) => isSiriId(v.id))).toBe(false)
    const agents = { a: { name: "a", voice: { system: "siri:aaron" } }, b: { name: "b" } } as any
    const cast = localSystemVoices(agents, {}, INSTALLED)
    expect(cast.get("a")?.id).toBe(AARON)
    expect(isSiriId(cast.get("b")?.id)).toBe(false)
  })

  it("is spoken with no -v: say follows the system voice", () => {
    expect(sayArgs({ provider: "system", elevenlabs: "x", system: AARON, fallback: true })).toEqual([])
  })
})

describe("the preference", () => {
  it("selects the voice for its language and leaves other languages alone", () => {
    const withFr: PrefValue = { text: "", entries: ["en", selection(NORA), "fr", selection(MARIE)] }
    const next = selecting(AARON, withFr)!
    expect(next).toContain(`"voiceId" = "${AARON}"`)
    expect(next).toContain(`"fr", { "_type" = "Speech.VoiceSelection"; "_version" = "0"; "voiceId" = "${MARIE}"; }`)
    expect(next.startsWith(`("en", {`)).toBe(true)
    expect(selecting(MARIE, USER)).toBe(`("en", { "_type" = "Speech.VoiceSelection"; "_version" = "0"; "voiceId" = "${NORA}"; }, "fr", { "_type" = "Speech.VoiceSelection"; "_version" = "0"; "voiceId" = "${MARIE}"; })`)
    expect(selecting(NORA, USER)).toBeNull()
    expect(selecting(AARON, null)).toContain(AARON)
    expect(prefLanguage(MARIE)).toBe("fr")
  })
})

describe("speaking a line in a Siri voice", () => {
  /** A preference in memory, and a `say` that finishes when told. */
  function rig(initial: PrefValue | null = USER) {
    const log: string[] = []
    let current: PrefValue | null = initial
    const pref: SpokenContentPref = {
      read: async () => current,
      write: async (text) => {
        log.push(text === null ? "delete" : text === initial?.text ? "restore" : `select ${/gryphon-neural_(\w+?)_/.exec(text.split("voiceId").pop()!)?.[1] ?? "?"}`)
        current = text === null ? null : text === initial?.text ? initial : { text, entries: [] }
      },
    }
    const says: Array<EventEmitter & { finish(code?: number): void }> = []
    const spawnSay = () => {
      const p = Object.assign(new EventEmitter(), {
        stdin: { on() {}, end: (t: string) => log.push(`say ${t}`) },
        kill: () => { p.emit("close", null); return true },
        finish: (code = 0) => p.emit("close", code),
      })
      says.push(p)
      return p as any
    }
    const lock = join(mkdtempSync(join(tmpdir(), "siri-lock-")), "siri.lock")
    const closed = (p: any) => new Promise<number | null>((r) => p.on("close", r))
    const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)) }
    return { log, pref, lock, says, closed, until, deps: { pref, lock, spawnSay } }
  }

  it("switches to the voice, speaks, then puts the user's voice back", async () => {
    const r = rig()
    const p = siriSay(AARON, "Deploy is green.", r.deps)
    await r.until(() => r.says.length === 1)
    expect(existsSync(r.lock)).toBe(true)
    r.says[0].finish()
    expect(await r.closed(p)).toBe(0)
    expect(r.log).toEqual(["select aaron", "say Deploy is green.", "restore"])
    expect(existsSync(r.lock)).toBe(false)
  })

  it("puts the user's voice back when cut off, and deletes a preference that was not set", async () => {
    const r = rig(null)
    const p = siriSay(AARON, "Long line", r.deps)
    await r.until(() => r.says.length === 1)
    p.kill()
    expect(await r.closed(p)).toBeNull()
    expect(r.log).toEqual(["select aaron", "say Long line", "delete"])
  })

  it("does not touch the preference when the voice is already selected", async () => {
    const r = rig()
    const p = siriSay(NORA, "Hi", r.deps)
    await r.until(() => r.says.length === 1)
    r.says[0].finish()
    await r.closed(p)
    expect(r.log).toEqual(["say Hi"])
  })

  it("two agents take turns: the second switches only after the first has restored", async () => {
    const r = rig()
    const a = siriSay(AARON, "one", r.deps)
    const b = siriSay(MARIE, "two", r.deps)
    await r.until(() => r.says.length === 1)
    await new Promise((res) => setTimeout(res, 60))
    expect(r.says).toHaveLength(1)
    r.says[0].finish()
    await r.closed(a)
    await r.until(() => r.says.length === 2)
    r.says[1].finish()
    await r.closed(b)
    expect(r.log).toEqual(["select aaron", "say one", "restore", "select marie", "say two", "restore"])
  })

  it("a line hushed while waiting its turn ends at once, without speaking", async () => {
    const r = rig()
    mkdirSync(r.lock, { recursive: true })
    writeFileSync(join(r.lock, "held.json"), JSON.stringify({ pid: process.pid, saved: USER }))
    const p = siriSay(AARON, "later", r.deps)
    await new Promise((res) => setTimeout(res, 30))
    p.kill()
    expect(await r.closed(p)).toBeNull()
    expect(r.log).toEqual([])
    expect(existsSync(r.lock)).toBe(true) // still the other speaker's
  })

  it("a speaker that died mid-line: its saved preference is put back first", async () => {
    const r = rig()
    mkdirSync(r.lock, { recursive: true })
    writeFileSync(join(r.lock, "held.json"), JSON.stringify({ pid: 2 ** 22 + 12345, saved: USER }))
    expect(await acquireLock(r.pref, r.lock, 1_000)).toBe(true)
    expect(r.log).toEqual(["restore"])
  })
})

describe("POST /voice/say", () => {
  const speech = { busy: false, lines: [] as any[], say: async (u: any) => { speech.lines.push(u); return true }, stop() {} } as any
  const svc = new VoiceTalkService(() => ({}), new VoiceIntroTracker(), () => {}, { speech })

  it("speaks an installed Siri voice in the shared queue, and nothing else", async () => {
    expect(await svc.sayLine({ text: "Hello", voice: AARON }, INSTALLED)).toEqual({ status: 200, body: { spoken: true } })
    expect(speech.lines[0]).toMatchObject({ text: "Hello", voice: { provider: "system", system: AARON } })
    expect((await svc.sayLine({ text: "Hello", voice: "com.apple.voice.compact.en-GB.Daniel" }, INSTALLED)).status).toBe(400)
    expect((await svc.sayLine({ text: "Hello", voice: "com.apple.ttsbundle.gryphon-neural_ghost_en-US_premium" }, INSTALLED)).status).toBe(400)
    expect((await svc.sayLine({ text: " ", voice: AARON }, INSTALLED)).status).toBe(400)
    expect(speech.lines).toHaveLength(1)
  })
})
