import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { fallbackVoice, parseVoiceList, setMissingVoiceHook, setVoiceLog, type SystemVoice } from "../src/voice/system-voices"
import { parseSiriAssets } from "../src/voice/siri"
import { localSystemVoices, resolveAgentVoice } from "../src/voice/agent-voice"
import { dataVolumeFreeBytes, findMissingVoices, lowDiskNotice, missingNotice, nextLowDisk, purgeableVoices, readVoiceHealth, VoiceHealth, REINSTALL_HINT } from "../src/voice/voice-health"

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

  it("warns about the Siri stand-in again after the voice came back and went missing again", async () => {
    // Samantha, not Nora: only a same-language voice of that name stands in (and warns).
    const siri = { agents: agents({ secretary: { system: "siri:samantha" } }), voice: {} }
    const samantha = parseSiriAssets(["com.apple.siri.tts.voice.en_US.samantha.neural.premium-en_US-iPhone"])
    const standIn = () => log.filter((l) => l.includes('Siri voice "samantha" is not installed')).length
    const h = health()
    await h.check(siri, PURGED)
    const first = standIn()
    await h.check(siri, [...PURGED, ...samantha])
    await h.check(siri, PURGED)
    expect(standIn()).toBe(first + 1)
  })

  it("rewrites the state file only when it changed", async () => {
    const h = health()
    await h.check(cfg, PURGED, new Date("2026-09-29T10:00:00Z"))
    await h.check(cfg, PURGED, new Date("2026-09-29T10:01:00Z"))
    expect(readVoiceHealth(file)?.checkedAt).toBe("2026-09-29T10:00:00.000Z")
    await h.check(cfg, RESTORED, new Date("2026-09-29T10:02:00Z"))
    expect(readVoiceHealth(file)).toMatchObject({ checkedAt: "2026-09-29T10:02:00.000Z", missing: [] })
  })

  it("does nothing without a voice list", async () => {
    expect(await health().check(cfg, [])).toBeNull()
    expect(readVoiceHealth(file)).toBeNull()
  })
})

describe("low disk before macOS purges voices (#791)", () => {
  const GB = 1e9
  const now = new Date("2026-10-07T11:00:00Z")
  const siri = { agents: agents({ secretary: { system: "siri:nora" } }), voice: {} }
  const plain = { agents: agents({ pm: { system: "Samantha" } }), voice: { system: "Samantha" } }

  it("counts Siri and Premium voices as purgeable, not compact or Enhanced ones", () => {
    expect(purgeableVoices(siri, RESTORED)).toEqual(["siri:nora"])
    expect(purgeableVoices({ agents: agents({ s: { system: NORA_ID } }), voice: {} }, PURGED)).toEqual([NORA_ID])
    expect(purgeableVoices({ agents: agents({ s: { system: "Ava (Premium)" } }), voice: {} }, PURGED)).toContain("Ava (Premium)")
    expect(purgeableVoices(plain, PURGED)).toEqual([])
    expect(purgeableVoices({ agents: agents({ s: { system: "Allison" } }), voice: { system: "Allison" } }, PURGED)).toEqual([])
  })

  it("counts a Premium voice an agent is assigned without naming one", () => {
    const ava = parseVoiceList("com.apple.voice.premium.en-US.Ava\tAva\ten-US\t3\t2")
    expect(purgeableVoices({ agents: agents({ s: {} }), voice: {} }, [...STANDARD, ...ava])).toEqual(["com.apple.voice.premium.en-US.Ava"])
  })

  it("is low under the threshold, and clears only once space is back above it by 1 GB", () => {
    const low = nextLowDisk(undefined, 5.4 * GB, 10, ["siri:nora"], now)
    expect(low).toMatchObject({ freeBytes: 5.4 * GB, thresholdBytes: 10 * GB, voices: ["siri:nora"], since: now.toISOString() })
    expect(nextLowDisk(undefined, 10.5 * GB, 10, ["siri:nora"], now)).toBeUndefined()
    expect(nextLowDisk(low, 10.5 * GB, 10, ["siri:nora"], now)?.since).toBe(low!.since)
    expect(nextLowDisk(low, 11.2 * GB, 10, ["siri:nora"], now)).toBeUndefined()
  })

  it("is never low with no purgeable voice, the warning off, or an unknown reading", () => {
    expect(nextLowDisk(undefined, 1 * GB, 10, [], now)).toBeUndefined()
    expect(nextLowDisk(undefined, 1 * GB, 0, ["siri:nora"], now)).toBeUndefined()
    expect(nextLowDisk(undefined, null, 10, ["siri:nora"], now)).toBeUndefined()
    const low = nextLowDisk(undefined, 1 * GB, 10, ["siri:nora"], now)
    expect(nextLowDisk(low, null, 10, ["siri:nora"], now)).toBe(low)
  })

  it("the notice says how much is free and which voices are at risk", () => {
    const n = lowDiskNotice(5.4 * GB, { freeBytes: 5.4 * GB, thresholdBytes: 10 * GB, voices: ["siri:nora", NORA_ID], since: "" })
    expect(n.title).toBe("AgentX: disk almost full, voices at risk")
    expect(n.message).toContain("Only 5.4 GB is free")
    expect(n.message).toContain("Siri Nora, Siri Nora (en-US)")
  })

  it("reads no free space off macOS", () => {
    if (process.platform !== "darwin") expect(dataVolumeFreeBytes()).toBeNull()
  })

  describe("VoiceHealth", () => {
    let dir: string, file: string, sent: string[], free: number | null, fail: boolean
    const health = () => new VoiceHealth({
      file, log: (m) => log.push(m), freeBytes: () => free,
      notify: async (_t, m) => { if (fail) throw new Error("offline"); sent.push(m) },
    })
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "voice-disk-")); file = join(dir, "health.json"); sent = []; free = 5.4 * GB; fail = false })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it("tells the owner once, across checks and restarts, and again after space recovers and drops", async () => {
      const h = health()
      await h.check(siri, RESTORED)
      await h.check(siri, RESTORED)
      await health().check(siri, RESTORED)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("Only 5.4 GB is free")
      expect(readVoiceHealth(file)?.lowDisk).toMatchObject({ voices: ["siri:nora"], notifiedAt: expect.any(String) })
      free = 9.5 * GB // under the threshold plus the margin: still low
      await h.check(siri, RESTORED)
      expect(readVoiceHealth(file)?.lowDisk).toBeDefined()
      free = 20 * GB
      await h.check(siri, RESTORED)
      expect(readVoiceHealth(file)?.lowDisk).toBeUndefined()
      expect(sent).toHaveLength(1)
      free = 4 * GB
      await h.check(siri, RESTORED)
      expect(sent).toHaveLength(2)
    })

    it("sends nothing when no Siri or Premium voice is configured", async () => {
      await health().check(plain, PURGED)
      expect(sent).toHaveLength(0)
      expect(readVoiceHealth(file)?.lowDisk).toBeUndefined()
    })

    it("sends nothing off macOS, where free space is not read", async () => {
      free = null
      await health().check(siri, RESTORED)
      expect(sent).toHaveLength(0)
    })

    it("sends nothing above the threshold, or with voice.lowDiskGB set to 0", async () => {
      free = 50 * GB
      await health().check(siri, RESTORED)
      free = 1 * GB
      await health().check({ ...siri, voice: { lowDiskGB: 0 } }, RESTORED)
      expect(sent).toHaveLength(0)
    })

    it("follows voice.lowDiskGB", async () => {
      free = 15 * GB
      await health().check({ ...siri, voice: { lowDiskGB: 20 } }, RESTORED)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("warning below 20.0 GB")
    })

    it("retries a notice that could not be sent", async () => {
      fail = true
      await health().check(siri, RESTORED)
      expect(readVoiceHealth(file)?.lowDisk?.notifiedAt).toBeUndefined()
      fail = false
      await health().check(siri, RESTORED)
      expect(sent).toHaveLength(1)
    })

    it("keeps the missing-voice notice separate", async () => {
      await health().check(siri, PURGED)
      expect(sent).toHaveLength(2)
      expect(readVoiceHealth(file)).toMatchObject({ missing: [{ voice: "siri:nora" }], lowDisk: { voices: ["siri:nora"] } })
    })
  })
})
