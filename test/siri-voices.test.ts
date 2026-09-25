import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { spawn } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ensureSiriSay, listSiriVoices, parseSiriAssets, siriSayPath } from "../src/voice/siri"
import { findVoice, parseVoiceList, setVoiceLog, type SystemVoice } from "../src/voice/system-voices"
import { localSystemVoices, resolveAgentVoice, voiceRef } from "../src/voice/agent-voice"
import { sayArgs, sayCommand } from "../src/voice/speaker"
import { setAgentVoice } from "../src/commands/voice"

const spec = (locale: string, name: string) => `com.apple.siri.tts.voice.${locale}.${name}.neural.premium-${locale}-iPhone`
const SIRI = parseSiriAssets([
  spec("en_US", "aaron"), spec("en_US", "nora"), spec("fr_FR", "marie"), spec("fr_FR", "fr-FR-D"),
  "com.apple.siri.tts.resource.en_US-en_US-generic",
])
const STANDARD = parseVoiceList([
  "com.apple.voice.compact.en-GB.Daniel\tDaniel\ten-GB\t1\t1",
  "com.apple.voice.compact.en-US.Samantha\tSamantha\ten-US\t1\t2",
  "com.apple.voice.compact.fr-FR.Thomas\tThomas\tfr-FR\t1\t1",
].join("\n"))
const INSTALLED: SystemVoice[] = [...STANDARD, ...SIRI]
const AARON = "com.apple.ttsbundle.gryphon-neural_aaron_en-US_premium"
const MARIE = "com.apple.ttsbundle.gryphon-neural_marie_fr-FR_premium"

const agents = (o: Record<string, any>) =>
  Object.fromEntries(Object.entries(o).map(([id, v]) => [id, { name: id, voice: v }])) as any

let log: string[] = []
beforeEach(() => { log = []; setVoiceLog((m) => log.push(m)) })
afterEach(() => setVoiceLog((m) => process.stderr.write(m + "\n")))

describe("Siri voice assets", () => {
  it("names each downloaded voice, skipping codenames and shared resources", () => {
    expect(SIRI.map((v) => [v.id, v.name, v.locale, v.gender])).toEqual([
      [AARON, "Aaron", "en-US", "male"],
      ["com.apple.ttsbundle.gryphon-neural_nora_en-US_premium", "Nora", "en-US", "female"],
      [MARIE, "Marie", "fr-FR", "female"],
    ])
    expect(SIRI.every((v) => v.siri && v.quality === "premium")).toBe(true)
  })

  it("reads the asset Info.plists, once per voice", () => {
    const dir = mkdtempSync(join(tmpdir(), "siri-assets-"))
    for (const [a, s] of [["1.asset", spec("en_US", "aaron")], ["2.asset", spec("en_US", "aaron")], ["3.asset", spec("ar_SA", "soha")]]) {
      mkdirSync(join(dir, a))
      writeFileSync(join(dir, a, "Info.plist"), `bplist00\u0000${s}\u0000`)
    }
    mkdirSync(join(dir, "empty.asset"))
    expect(listSiriVoices([dir, join(dir, "missing")]).map((v) => v.name)).toEqual(["Aaron", "Soha"])
    rmSync(dir, { recursive: true })
  })
})

describe("naming a Siri voice", () => {
  it("siri:<name> finds the Siri voice; a plain name never does", () => {
    expect(findVoice("siri:aaron", INSTALLED)?.id).toBe(AARON)
    expect(findVoice("SIRI:Marie", INSTALLED, "fr")?.id).toBe(MARIE)
    expect(findVoice("Aaron", INSTALLED)).toBeNull()
  })

  it("a missing Siri voice falls back to the system voice of that name, once warned", () => {
    expect(findVoice("siri:daniel", INSTALLED)?.id).toBe("com.apple.voice.compact.en-GB.Daniel")
    findVoice("siri:daniel", INSTALLED)
    expect(log.filter((m) => m.includes('"daniel" is not installed'))).toHaveLength(1)
    expect(findVoice("siri:nobody", INSTALLED)).toBeNull()
  })

  it("is never cast automatically, only used when named", () => {
    const cast = localSystemVoices(agents({ a: {}, b: {}, c: { system: "siri:aaron" } }), {}, INSTALLED)
    expect(cast.get("a")?.siri).toBeFalsy()
    expect(cast.get("b")?.siri).toBeFalsy()
    expect(cast.get("c")?.id).toBe(AARON)
  })

  it("fits the per-language map", () => {
    const a = agents({ devops: { system: { en: "siri:aaron", fr: "siri:marie" } } })
    const v = resolveAgentVoice("devops", a, {}, INSTALLED)
    expect(v.systemVoiceName).toBe("Aaron (Siri) en-US")
    expect(voiceRef(v).languages).toEqual({ en: AARON, fr: MARIE })
  })

  it("agentx voice set stores the name as typed", () => {
    const raw = { agents: { "devops-agent": { name: "DevOps" } } }
    const { raw: out, summary } = setAgentVoice(raw, "devops-agent", "siri:aaron", {}, INSTALLED)
    expect(out.agents["devops-agent"].voice).toEqual({ system: "siri:aaron" })
    expect(summary).toContain("Aaron (Siri)")
  })
})

describe("speaking a Siri voice", () => {
  const ref = (system: string | null) => ({ provider: "system" as const, elevenlabs: "x", system, fallback: true })

  it("runs the shared script for a Siri voice or the OS default, say -v otherwise", () => {
    expect(sayArgs(ref(AARON))).toEqual([])
    expect(sayCommand(ref(AARON), "hi", "/s.sh")).toEqual(["/bin/sh", ["/s.sh", AARON]])
    expect(sayCommand(ref(null), "hi", "/s.sh")).toEqual(["/bin/sh", ["/s.sh"]])
    expect(sayCommand(ref("com.apple.voice.compact.en-GB.Daniel"), "hi", "/s.sh")).toEqual(["say", ["-v", "com.apple.voice.compact.en-GB.Daniel"]])
    expect(sayCommand(ref(AARON), "hi", null)).toEqual(["say", []])
  })
})

// --- The script itself, against stand-ins for defaults, plutil and say ---

describe.skipIf(process.platform === "win32")("siri-say.sh", () => {
  let home: string, stub: string, script: string
  const ORIGINAL = "<plist><array><string>en</string><dict>nora</dict></array></plist>"
  const pref = () => (existsSync(join(stub, "pref")) ? readFileSync(join(stub, "pref"), "utf8") : null)
  const sayLog = () => (existsSync(join(stub, "log")) ? readFileSync(join(stub, "log"), "utf8").trim().split("\n") : [])
  const lock = () => join(home, ".agentx", "voice", "siri.lock")

  /** Scripts start slowly on a busy Mac; wait for the state, not a guess. */
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50))
    expect(ok()).toBe(true)
  }
  const bin = (name: string, body: string) => writeFileSync(join(stub, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siri-home-"))
    stub = mkdtempSync(join(tmpdir(), "siri-stub-"))
    mkdirSync(join(stub, "bin"))
    script = ensureSiriSay(home)
    bin("defaults", `S="${stub}/pref"
case "$1" in
  read) [ "$2" = -g ] && printf '(\\n    "fr-FR",\\n    en\\n)\\n' ;;
  export) cat "$S" 2>/dev/null ;;
  write) shift 3; if [ "$1" = -array ]; then shift; printf 'ARRAY %s' "$*" > "$S"; else printf '%s' "$1" > "$S"; fi ;;
  delete) rm -f "$S" ;;
esac`)
    bin("plutil", `cat > "$5"; [ -s "$5" ] || { rm -f "$5"; exit 1; }`)
    bin("say", `echo "start $(cat "${stub}/pref" 2>/dev/null)" >> "${stub}/log"; cat > /dev/null; sleep "\${SAY_SLEEP:-0}"; echo end >> "${stub}/log"`)
    writeFileSync(join(stub, "pref"), ORIGINAL)
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(stub, { recursive: true, force: true }) })

  const run = (args: string[], env: Record<string, string> = {}) => {
    const p = spawn("/bin/sh", [script, ...args], {
      env: { ...process.env, HOME: home, PATH: `${join(stub, "bin")}:/usr/bin:/bin`, ...env },
      stdio: ["pipe", "ignore", "pipe"],
    })
    p.stdin!.end("hello")
    const done = new Promise<number | null>((r) => p.on("exit", (code) => r(code)))
    return { p, done }
  }

  it("is written once to ~/.agentx/voice", () => {
    expect(script).toBe(siriSayPath(home))
    expect(ensureSiriSay(home)).toBe(script)
  })

  it("speaks with the Siri voice under the system language, then restores the user's choice", async () => {
    expect(await run([AARON]).done).toBe(0)
    expect(sayLog()).toEqual([`start ARRAY fr { _type = "Speech.VoiceSelection"; _version = 0; voiceId = "${AARON}"; }`, "end"])
    expect(pref()).toBe(ORIGINAL)
    expect(existsSync(lock())).toBe(false)
  })

  it("restores an unset selection as unset", async () => {
    rmSync(join(stub, "pref"))
    expect(await run([AARON]).done).toBe(0)
    expect(pref()).toBeNull()
  })

  it("leaves the OS default alone when no voice is named", async () => {
    expect(await run([]).done).toBe(0)
    expect(sayLog()).toEqual([`start ${ORIGINAL}`, "end"])
  })

  it("lets one speaker at a time switch the voice", async () => {
    const a = run([AARON], { SAY_SLEEP: "0.4" })
    await until(() => sayLog().length > 0)
    const b = run([MARIE], { SAY_SLEEP: "0.1" })
    expect(await a.done).toBe(0)
    expect(await b.done).toBe(0)
    const lines = sayLog()
    expect(lines.map((l) => l.split(" ")[0])).toEqual(["start", "end", "start", "end"])
    expect(lines[0]).toContain("aaron")
    expect(lines[2]).toContain("marie")
    expect(pref()).toBe(ORIGINAL)
  })

  it("restores the user's choice when stopped mid-line", async () => {
    const a = run([AARON], { SAY_SLEEP: "5" })
    await until(() => sayLog().length > 0)
    expect(pref()).toContain("aaron")
    a.p.kill()
    expect(await a.done).toBe(143)
    expect(pref()).toBe(ORIGINAL)
    expect(existsSync(lock())).toBe(false)
  })

  it("after a crash, takes over the lock and restores the saved choice first", async () => {
    mkdirSync(lock(), { recursive: true })
    writeFileSync(join(lock(), "pid"), "999999")
    writeFileSync(join(home, ".agentx", "voice", "siri-saved.plist"), ORIGINAL)
    writeFileSync(join(stub, "pref"), "ARRAY en stuck-on-aaron")
    expect(await run([MARIE]).done).toBe(0)
    expect(sayLog()[0]).toContain("marie")
    expect(pref()).toBe(ORIGINAL)
  })

  it("refuses an id that could break out of the plist", async () => {
    expect(await run(['x"; evil = "1']).done).toBe(2)
    expect(sayLog()).toEqual([])
  })
})
