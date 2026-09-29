import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { fallbackVoice, parseVoiceList, setMissingVoiceHook, setVoiceLog, type SystemVoice } from "../src/voice/system-voices"
import { parseSiriAssets } from "../src/voice/siri"
import { localSystemVoices, resolveAgentVoice } from "../src/voice/agent-voice"
import { findMissingVoices, missingNotice, readVoiceHealth, VoiceHealth, REINSTALL_HINT } from "../src/voice/voice-health"

// What the Mac had after macOS purged the Siri voices: one Enhanced voice,
// a few compact ones, and the Eloquence family.
const STANDARD = parseVoiceList([
  "com.apple.voice.enhanced.en-US.Allison\tAllison\ten-US\t2\t2",
  "com.apple.voice.compact.en-US.Samantha\tSamantha\ten-US\t1\t2",
  "com.apple.voice.compact.en-GB.Daniel\tDaniel\ten-GB\t1\t1",
  "com.apple.eloquence.en-US.Flo\tFlo\ten-US\t1\t0",
  "com.apple.eloquence.en-US.Eddy\tEddy\ten-US\t1\t0",
  "com.apple.voice.compact.nb-NO.Nora\tNora\tnb-NO\t1\t2",
  "com.apple.voice.compact.fr-FR.Thomas\tThomas\tfr-FR\t1\t1",
].join("\n"))
const ELOQUENCE_ONLY = STANDARD.filter((v) => v.id.startsWith("com.apple.eloquence."))
const NORA_ID = "com.apple.ttsbundle.gryphon-neural_nora_en-US_premium"
const NORA = parseSiriAssets(["com.apple.siri.tts.voice.en_US.nora.neural.premium-en_US-iPhone"])
const PURGED: SystemVoice[] = STANDARD
const RESTORED: SystemVoice[] = [...STANDARD, ...NORA]

const agents = (o: Record<string, any>) =>
  Object.fromEntries(Object.entries(o).map(([id, v]) => [id, { name: id, workspace: "/tmp", voice: v }])) as any
const names = (m: Map<string, SystemVoice | null>) => Object.fromEntries([...m].map(([k, v]) => [k, v?.name ?? null]))

let log: string[] = []
beforeEach(() => { log = []; setVoiceLog((m) => log.push(m)) })
afterEach(() => { setVoiceLog((m) => process.stderr.write(m + "\n")); setMissingVoiceHook(() => {}) })

describe("fallbackVoice", () => {
  it("takes the best quality in the language and gender: Allison (Enhanced), not Flo", () => {
    expect(fallbackVoice(PURGED, "en-US", "female")?.name).toBe("Allison")
  })

  it("never picks Eloquence while a current macOS voice speaks the language", () => {
    expect(fallbackVoice(PURGED, "en-US", "male")?.name).toBe("Daniel")
    expect(fallbackVoice(PURGED, "en", null)?.name).toBe("Allison")
  })

  it("uses Eloquence only when nothing better is installed", () => {
    expect(fallbackVoice(ELOQUENCE_ONLY, "en-US", "female")?.name).toBe("Flo")
  })

  it("prefers a voice no one uses yet, within the best quality only", () => {
    const two = [...PURGED, ...parseVoiceList("com.apple.voice.enhanced.en-US.Ava\tAva\ten-US\t2\t2")]
    expect(fallbackVoice(two, "en-US", "female", new Set(["Allison"]))?.name).toBe("Ava")
    // Only one Enhanced voice: sharing it beats a compact one.
    expect(fallbackVoice(PURGED, "en-US", "female", new Set(["Allison"]))?.name).toBe("Allison")
  })

  it("is null when nothing speaks the language", () => {
    expect(fallbackVoice(PURGED, "ar", "female")).toBeNull()
  })
})

describe("an agent whose configured voice is not installed", () => {
  it("speaks with the ranked fallback, of the missing Siri voice's gender", () => {
    const cast = localSystemVoices(agents({
      secretary: { system: NORA_ID },
      coder: { system: "siri:damon" },
    }), {}, PURGED)
    expect(names(cast)).toEqual({ secretary: "Allison", coder: "Daniel" })
  })

  it("never becomes a same-named voice in another language (siri:nora → not Nora nb-NO)", () => {
    expect(names(localSystemVoices(agents({ s: { system: "siri:nora" } }), {}, PURGED))).toEqual({ s: "Allison" })
  })

  it("many agents missing their voices still get no Eloquence voice", () => {
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`a${i}`, { system: "siri:simone" }]))
    const picked = [...localSystemVoices(agents(many), {}, PURGED).values()].map((v) => v?.name)
    expect(picked.every((n) => n === "Allison")).toBe(true)
  })

  it("tries its own fallbacks first, in order, skipping those not installed", () => {
    const cast = localSystemVoices(agents({ s: { system: NORA_ID, fallbacks: ["Ava (Premium)", "Samantha", "Allison"] } }), {}, PURGED)
    expect(names(cast)).toEqual({ s: "Samantha" })
  })

  it("switches back to its voice as soon as the voice is installed again", () => {
    const a = agents({ secretary: { system: NORA_ID } })
    expect(resolveAgentVoice("secretary", a, {}, PURGED).systemVoice).toBe("com.apple.voice.enhanced.en-US.Allison")
    expect(resolveAgentVoice("secretary", a, {}, RESTORED).systemVoice).toBe(NORA_ID)
  })

  it("reports the missing voice while choosing one to speak with", () => {
    const seen: string[] = []
    setMissingVoiceHook((n) => seen.push(n))
    resolveAgentVoice("secretary", agents({ secretary: { system: NORA_ID } }), {}, PURGED)
    expect(seen).toContain(NORA_ID)
  })
})

describe("finding missing voices", () => {
  const cfg = { agents: agents({ secretary: { system: NORA_ID }, coder: { system: "siri:nora" }, pm: { system: "Samantha" }, os: { system: "system" } }), voice: {} }

  it("lists each missing voice once, with who names it and what speaks now", () => {
    expect(findMissingVoices(cfg, PURGED)).toEqual([
      { voice: NORA_ID, agents: ["secretary"], speaksWith: { secretary: "Allison (Enhanced) en-US" } },
      { voice: "siri:nora", agents: ["coder"], speaksWith: { coder: expect.any(String) } },
    ])
    expect(findMissingVoices(cfg, RESTORED)).toEqual([])
  })

  it("gives no verdict when the voice list could not be read", () => {
    expect(findMissingVoices(cfg, [])).toEqual([])
  })

  it("the notice names the voices and how to reinstall them", () => {
    const n = missingNotice([{ voice: NORA_ID, agents: ["secretary"], speaksWith: { secretary: "Allison (Enhanced) en-US" }, since: "" }])
    expect(n.title).toBe("AgentX: a voice is not installed")
    expect(n.message).toContain("Siri Nora (en-US): secretary (now Allison (Enhanced) en-US)")
    expect(n.message).toContain(REINSTALL_HINT)
  })
})

describe("VoiceHealth", () => {
  let dir: string, file: string, sent: string[], fail: boolean
  const cfg = { agents: agents({ secretary: { system: NORA_ID } }), voice: {} }
  const health = () => new VoiceHealth({
    file, log: (m) => log.push(m),
    notify: async (_t, m) => { if (fail) throw new Error("offline"); sent.push(m) },
  })
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "voice-health-")); file = join(dir, "health.json"); sent = []; fail = false })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("tells the owner once per missing voice, across checks and restarts", async () => {
    const h = health()
    await h.check(cfg, PURGED)
    await h.check(cfg, PURGED)
    await health().check(cfg, PURGED)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("Siri Nora (en-US)")
    expect(h.hasMissing()).toBe(true)
    expect(readVoiceHealth(file)?.missing[0]).toMatchObject({ voice: NORA_ID, agents: ["secretary"], notifiedAt: expect.any(String) })
  })

  it("clears the state when the voice is back, and tells again if it goes missing again", async () => {
    const h = health()
    await h.check(cfg, PURGED)
    await h.check(cfg, RESTORED)
    expect(readVoiceHealth(file)?.missing).toEqual([])
    expect(h.hasMissing()).toBe(false)
    expect(log.some((l) => l.includes("Siri Nora (en-US) is installed again"))).toBe(true)
    await h.check(cfg, PURGED)
    expect(sent).toHaveLength(2)
  })

  it("retries a notice that could not be sent", async () => {
    fail = true
    await health().check(cfg, PURGED)
    expect(sent).toHaveLength(0)
    expect(readVoiceHealth(file)?.missing[0].notifiedAt).toBeUndefined()
    fail = false
    await health().check(cfg, PURGED)
    expect(sent).toHaveLength(1)
  })

  it("does nothing without a voice list", async () => {
    expect(await health().check(cfg, [])).toBeNull()
    expect(readVoiceHealth(file)).toBeNull()
  })
})
