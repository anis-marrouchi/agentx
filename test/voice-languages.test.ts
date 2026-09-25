import { describe, it, expect, afterEach } from "vitest"
import { castVoices, candidates, parseVoiceList, setVoiceLog } from "../src/voice/system-voices"
import { localSystemVoices, resolveAgentVoice, voiceForText, voiceRef } from "../src/voice/agent-voice"
import { detectLanguage } from "../src/voice/language"
import { sayArgs } from "../src/voice/speaker"
import { daemonConfigSchema } from "../src/daemon/config"

const INSTALLED = parseVoiceList([
  "com.apple.voice.compact.en-GB.Daniel\tDaniel\ten-GB\t1\t1",
  "com.apple.voice.compact.en-US.Samantha\tSamantha\ten-US\t1\t2",
  "com.apple.voice.compact.en-AU.Karen\tKaren\ten-AU\t1\t2",
  "com.apple.voice.compact.en-IN.Rishi\tRishi\ten-IN\t1\t1",
  "com.apple.voice.compact.fr-FR.Thomas\tThomas\tfr-FR\t1\t1",
  "com.apple.voice.compact.fr-CA.Amelie\tAmélie\tfr-CA\t1\t2",
  "com.apple.voice.compact.ar-001.Maged\tMajed\tar-001\t1\t1",
].join("\n"))
const id = (name: string) => INSTALLED.find((v) => v.name === name)!.id

const agents = (o: Record<string, Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { name: k, voice: v }])) as any

const EN = "Sure, I have sent the invoice to the client and it should arrive today."
const FR = "Oui, j'ai envoyé la facture au client, elle devrait arriver aujourd'hui."
const AR = "نعم، لقد أرسلت الفاتورة إلى العميل."

afterEach(() => setVoiceLog((m) => process.stderr.write(m + "\n")))

describe("detectLanguage", () => {
  it("tells English, French and Arabic apart", () => {
    expect(detectLanguage(EN)).toBe("en")
    expect(detectLanguage(FR)).toBe("fr")
    expect(detectLanguage(AR)).toBe("ar")
    expect(detectLanguage("Très bien, c'est noté.")).toBe("fr")
  })

  it("says nothing when the line gives no clue", () => {
    expect(detectLanguage("")).toBeNull()
    expect(detectLanguage("OK 42")).toBeNull()
  })
})

describe('"system": the OS default voice', () => {
  it("speaks with no -v, is not warned about, and leaves the agent out of casting", () => {
    const log: string[] = []
    setVoiceLog((m) => log.push(m))
    const cfg = agents({ secretary: { system: "system" }, coder: {} })
    const v = resolveAgentVoice("secretary", cfg, {}, INSTALLED)
    expect(v.systemVoice).toBeNull()
    expect(sayArgs(voiceRef(v), EN)).toEqual([])
    expect(localSystemVoices(cfg, {}, INSTALLED).get("coder")).not.toBeNull()
    expect(log).toEqual([])
  })

  it("as the global default, covers every agent without its own", () => {
    const voices = localSystemVoices(agents({ a: {}, b: { system: "Daniel" } }), { system: "System" }, INSTALLED)
    expect(voices.get("a")).toBeNull()
    expect(voices.get("b")?.name).toBe("Daniel")
  })
})

describe("per-language voices", () => {
  const cfg = agents({ cx: { system: { en: "Samantha", fr: "Amélie", ar: "system" } }, coder: { system: "Daniel" } })

  it("speaks each line in its language's voice, the default voice otherwise", () => {
    const v = resolveAgentVoice("cx", cfg, {}, INSTALLED)
    expect(v.systemVoice).toBe(id("Samantha"))
    const ref = voiceRef(v)
    expect(sayArgs(ref, FR)).toEqual(["-v", id("Amélie")])
    expect(sayArgs(ref, AR)).toEqual([])
    expect(sayArgs(ref, EN)).toEqual(["-v", id("Samantha")])
    expect(sayArgs(ref, "OK")).toEqual(["-v", id("Samantha")])
    expect(voiceForText(v, FR).systemVoiceName).toBe("Amélie fr-CA")
    expect(voiceForText(v, "OK")).toBe(v)
  })

  it("a plain name speaks every language", () => {
    const v = resolveAgentVoice("coder", cfg, {}, INSTALLED)
    expect(v.systemByLanguage).toEqual({})
    expect(sayArgs(voiceRef(v), FR)).toEqual(["-v", id("Daniel")])
  })

  it("the agent's list overrides the global one language by language", () => {
    const v = resolveAgentVoice("cx", agents({ cx: { system: { fr: "Amélie" } } }), { system: { en: "Karen", fr: "Thomas", ar: "Majed" } }, INSTALLED)
    expect(v.systemVoice).toBe(id("Karen"))
    expect(Object.fromEntries(Object.entries(v.systemByLanguage).map(([l, s]) => [l, s?.name]))).toEqual({ en: "Karen", fr: "Amélie", ar: "Majed" })
  })

  it("a list without the default language still gets a default voice", () => {
    const v = resolveAgentVoice("cx", agents({ cx: { system: { fr: "Thomas" } } }), {}, INSTALLED)
    expect(v.systemVoice).not.toBeNull()
    expect(sayArgs(voiceRef(v), FR)).toEqual(["-v", id("Thomas")])
  })

  it("is valid config next to plain names", () => {
    const parsed = daemonConfigSchema.parse({
      node: { id: "n", name: "n" },
      voice: { system: { en: "Karen" } },
      agents: { cx: { name: "CX", workspace: ".", voice: { system: { en: "Samantha", fr: "Thomas" } } } },
    })
    expect(parsed.agents.cx.voice?.system).toEqual({ en: "Samantha", fr: "Thomas" })
    expect(parsed.voice.system).toEqual({ en: "Karen" })
  })
})

describe("gender-aware auto-assign", () => {
  const pool = candidates(INSTALLED, "en")

  it("repeats a voice of the agent's gender rather than give it the other one", () => {
    const cast = castVoices([{ id: "a", gender: "female" }, { id: "b", gender: "female" }, { id: "c", gender: "female" }], pool)
    expect([...cast.values()].map((v) => v.gender)).toEqual(["female", "female", "female"])
    expect(castVoices([{ id: "m", gender: "male" }], pool, new Set(["Daniel", "Rishi"])).get("m")?.gender).toBe("male")
  })

  it("skips a global default of the other gender", () => {
    const voices = localSystemVoices(agents({ nadia: { gender: "female" }, hakim: { gender: "male" }, x: {} }), { system: "Samantha" }, INSTALLED)
    expect(voices.get("nadia")?.name).toBe("Samantha")
    expect(voices.get("x")?.name).toBe("Samantha")
    expect(voices.get("hakim")?.gender).toBe("male")
  })
})

describe("agentx voice set", () => {
  const raw = () => ({ voice: { locale: "en-US" }, agents: { cx: { name: "CX", workspace: ".", voice: { system: "Samantha" } } } })
  const load = () => import("../src/commands/voice").then((m) => m.setAgentVoice)

  it('stores "system" for the OS default', async () => {
    const set = await load()
    const { raw: out, summary } = set(raw(), "cx", "system", {}, INSTALLED)
    expect(out.agents.cx.voice.system).toBe("system")
    expect(summary).toContain("OS default")
  })

  it("--lang turns a plain name into a list for the default language", async () => {
    const set = await load()
    const out = set(raw(), "cx", "Thomas", { lang: "fr" }, INSTALLED).raw
    expect(out.agents.cx.voice.system).toEqual({ en: "Samantha", fr: "Thomas" })
    expect(set(out, "cx", "system", { lang: "ar" }, INSTALLED).raw.agents.cx.voice.system).toEqual({ en: "Samantha", fr: "Thomas", ar: "system" })
    expect(() => set(raw(), "cx", "Nobody", { lang: "fr" }, INSTALLED)).toThrow(/not an installed/)
  })

  it("--gender is stored on its own", async () => {
    const set = await load()
    expect(set(raw(), "cx", undefined, { gender: "female" }, INSTALLED).raw.agents.cx.voice).toEqual({ system: "Samantha", gender: "female" })
    expect(() => set(raw(), "cx", undefined, { gender: "other" as any }, INSTALLED)).toThrow(/--gender/)
  })
})
