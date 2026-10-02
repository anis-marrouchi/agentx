import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { ChildProcess } from "child_process"
import { daemonConfigSchema } from "../src/daemon/config"
import { applyVoiceSettings, checkVoiceSettings, previewLine, saveVoiceSettings, voiceSettingsView } from "../src/daemon/voice-settings-api"
import { describeHotkey, parseHotkey } from "../src/voice/hotkey"
import { elevenLabsSpeed, sayArgs, sayRate, type Play, type Utterance } from "../src/voice/speaker"
import { SpeechOut } from "../src/voice/speaking-queue"
import { SIRI_SAY } from "../src/voice/siri"
import { isControlPost } from "../src/daemon/mesh-auth"

// #158: the AgentX Voice settings window saves through the daemon.

const voices = [
  { id: "com.apple.voice.premium.en-US.Ava", name: "Ava", locale: "en-US", quality: "premium" as const, gender: "female" as const },
  { id: "com.apple.voice.compact.en-GB.Daniel", name: "Daniel", locale: "en-GB", quality: "standard" as const, gender: "male" as const },
]

const rawConfig = () => ({
  node: { id: "n", name: "n" },
  agents: {
    writer: { name: "Writer", tier: "claude-code", workspace: "/tmp", voice: { system: "Ava", narrate: "on" } },
    researcher: { name: "Researcher", tier: "claude-code", workspace: "/tmp", presence: { color: "#123456" } },
  },
  channels: { telegram: { enabled: false, token: "${EXAMPLE_TOKEN}" } },
})
const config = () => daemonConfigSchema.parse(rawConfig())

describe("shortcuts", () => {
  it("normalises modifiers and key names", () => {
    expect(parseHotkey("Option+Space")).toEqual({ ok: true, value: "opt+space" })
    expect(parseHotkey("cmd+alt+.")).toEqual({ ok: true, value: "opt+cmd+period" })
    expect(parseHotkey("shift+ctrl+opt+1")).toEqual({ ok: true, value: "ctrl+opt+shift+1" })
    expect(parseHotkey("f5")).toEqual({ ok: true, value: "f5" })
  })

  it("refuses shortcuts that would eat typing or cannot be pressed", () => {
    expect(parseHotkey("a").ok).toBe(false)
    expect(parseHotkey("shift+a").ok).toBe(false)
    expect(parseHotkey("opt+").ok).toBe(false)
    expect(parseHotkey("hyper+a").ok).toBe(false)
    expect(parseHotkey("opt+opt+a").ok).toBe(false)
    expect(parseHotkey("opt+backspace").ok).toBe(false)
  })

  it("shows them as the Mac does", () => {
    expect(describeHotkey("ctrl+opt+1")).toBe("⌃⌥1")
    expect(describeHotkey("opt+cmd+period")).toBe("⌥⌘.")
    expect(describeHotkey("opt+space")).toBe("⌥Space")
  })

  it("the config schema rejects a bad shortcut with a readable message", () => {
    const bad = rawConfig() as any
    bad.agents.writer.voice.hotkey = "shift+w"
    const parsed = daemonConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/needs ctrl, opt or cmd/)
  })
})

describe("checkVoiceSettings", () => {
  it("accepts a normal change", () => {
    expect(checkVoiceSettings({ agents: { writer: { rate: 1.2, priority: "high", hotkey: "ctrl+opt+1", color: "#00AAFF" } } }, config())).toEqual([])
  })

  it("names the agent and the problem", () => {
    const errors = checkVoiceSettings({
      agents: {
        writer: { rate: 3, color: "blue", narrate: "loud" as never },
        nobody: { rate: 1 },
      },
    }, config())
    const text = errors.map((e) => e.message).join("\n")
    expect(text).toMatch(/Writer: speaking speed must be between 0.75 and 1.5/)
    expect(text).toMatch(/Writer: colour must look like #1E90FF/)
    expect(text).toMatch(/Writer: narration must be off, on or all/)
    expect(text).toMatch(/There is no agent "nobody"/)
  })

  it("refuses one shortcut for two actions, counting ones not being changed", () => {
    const errors = checkVoiceSettings({ agents: { writer: { hotkey: "opt+space" } } }, config())
    expect(errors[0].message).toBe("⌥Space is used for both talk and ask Writer; give each its own shortcut")
    const menu = checkVoiceSettings({ general: { hotkeys: { paste: "cmd+opt+a" } } }, config())
    expect(menu[0].message).toMatch(/open the menu/)
    // Moving talk away frees it for the agent in the same save.
    expect(checkVoiceSettings({ general: { hotkeys: { talk: "ctrl+space" } }, agents: { writer: { hotkey: "opt+space" } } }, config())).toEqual([])
  })

  it("accepts the local engine and the end of a turn, and refuses other values", () => {
    expect(checkVoiceSettings({ general: { localStt: "parakeet", endOfTurn: "volume" } }, config())).toEqual([])
    const errors = checkVoiceSettings({ general: { localStt: "whisper.cpp", endOfTurn: "timer" } } as never, config())
    expect(errors.map((e) => e.path)).toEqual(["general.localStt", "general.endOfTurn"])
  })

  it("accepts the orb or the character as the look, and refuses anything else", () => {
    expect(checkVoiceSettings({ general: { look: "character" } }, config())).toEqual([])
    expect(checkVoiceSettings({ general: { look: "orb" } }, config())).toEqual([])
    const errors = checkVoiceSettings({ general: { look: "mascot" } } as never, config())
    expect(errors).toEqual([{ path: "general.look", message: "The assistant is shown as orb or character" }])
  })

  it("refuses unknown settings instead of dropping them", () => {
    const errors = checkVoiceSettings({ agents: { writer: { volume: 3 } as never }, colour: 1 } as never, config())
    expect(errors.map((e) => e.path)).toEqual(expect.arrayContaining(["colour", "agents.writer.volume"]))
  })
})

describe("applyVoiceSettings", () => {
  it("sets, normalises and clears fields, leaving the rest alone", () => {
    const raw: any = rawConfig()
    applyVoiceSettings(raw, {
      general: { stt: "local", hotkeys: { talk: "Control+Space" } },
      agents: {
        writer: { system: null, rate: 1.25, hotkey: "cmd+ctrl+2" },
        researcher: { color: null, priority: "low" },
      },
    })
    expect(raw.voice).toEqual({ stt: "local", hotkeys: { talk: "ctrl+space" } })
    expect(raw.agents.writer.voice).toEqual({ narrate: "on", rate: 1.25, hotkey: "ctrl+cmd+2" })
    expect(raw.agents.researcher.presence).toBeUndefined()
    expect(raw.agents.researcher.voice).toEqual({ priority: "low" })
    expect(raw.channels.telegram.token).toBe("${EXAMPLE_TOKEN}")
  })

  it("writes the local engine and the end of a turn", () => {
    const raw: any = rawConfig()
    applyVoiceSettings(raw, { general: { localStt: "parakeet", endOfTurn: "volume" } })
    expect(raw.voice).toEqual({ localStt: "parakeet", endOfTurn: "volume" })
  })

  it("starts with the full pill unless told to start reduced to the orb", () => {
    expect(voiceSettingsView(config(), []).general.startReduced).toBe(false)
    expect(checkVoiceSettings({ general: { startReduced: true } }, config())).toEqual([])
    expect(checkVoiceSettings({ general: { startReduced: "yes" } } as never, config()))
      .toEqual([{ path: "general.startReduced", message: "Start reduced to the orb must be on or off" }])
    const raw: any = {}
    applyVoiceSettings(raw, { general: { startReduced: true } })
    expect(raw.voice).toEqual({ startReduced: true })
  })

  it("keeps the character where it rests unless told to stroll (#482)", () => {
    expect(voiceSettingsView(config(), []).general.stroll).toBe(false)
    expect(checkVoiceSettings({ general: { stroll: true } }, config())).toEqual([])
    expect(checkVoiceSettings({ general: { stroll: "yes" } } as never, config()))
      .toEqual([{ path: "general.stroll", message: "Character strolls when idle must be on or off" }])
    const raw: any = {}
    applyVoiceSettings(raw, { general: { stroll: true } })
    expect(raw.voice).toEqual({ stroll: true })
  })

  it("writes the look, and the orb is the look when none is written", () => {
    const raw: any = rawConfig()
    expect(voiceSettingsView(config(), []).general.look).toBe("orb")
    applyVoiceSettings(raw, { general: { look: "character" } })
    expect(raw.voice).toEqual({ look: "character" })
  })
})

describe("saveVoiceSettings", () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-voice-settings-"))
    path = join(dir, "agentx.json")
    writeFileSync(path, JSON.stringify(rawConfig(), null, 2) + "\n")
    process.env.EXAMPLE_TOKEN = "t"
  })
  afterEach(() => {
    try { chmodSync(path, 0o644) } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it("writes agentx.json in place: same file, new content", async () => {
    const inode = statSync(path).ino
    const res = await saveVoiceSettings({ agents: { writer: { rate: 1.1, color: "#abcdef" } } }, config(), path)
    expect(res).toEqual({ ok: true, path })
    expect(statSync(path).ino).toBe(inode)
    const saved = JSON.parse(readFileSync(path, "utf8"))
    expect(saved.agents.writer.voice.rate).toBe(1.1)
    expect(saved.agents.writer.presence.color).toBe("#ABCDEF")
    expect(saved.channels.telegram.token).toBe("${EXAMPLE_TOKEN}")
  })

  it("never touches the file for a refused value", async () => {
    const before = readFileSync(path, "utf8")
    const res = await saveVoiceSettings({ agents: { writer: { rate: 9 } } }, config(), path)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(400)
      expect(res.error).toMatch(/speaking speed/)
    }
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("reports the schema's complaint when the whole file would not be valid", async () => {
    const broken: any = rawConfig()
    broken.voice = { locale: 5 }
    writeFileSync(path, JSON.stringify(broken, null, 2))
    const before = readFileSync(path, "utf8")
    const res = await saveVoiceSettings({ agents: { writer: { rate: 1.1 } } }, config(), path)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/agentx.json would not be valid:\nvoice.locale/)
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("leaves the file as it was when it cannot be written", async () => {
    const before = readFileSync(path, "utf8")
    chmodSync(path, 0o444)
    const res = await saveVoiceSettings({ agents: { writer: { rate: 1.1 } } }, config(), path)
    expect(res.ok).toBe(false)
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("runs saves one at a time, so neither is lost", async () => {
    await Promise.all([
      saveVoiceSettings({ agents: { writer: { rate: 1.2 } } }, config(), path),
      saveVoiceSettings({ agents: { researcher: { priority: "high" } } }, config(), path),
    ])
    const saved = JSON.parse(readFileSync(path, "utf8"))
    expect(saved.agents.writer.voice.rate).toBe(1.2)
    expect(saved.agents.researcher.voice.priority).toBe("high")
  })
})

describe("voiceSettingsView", () => {
  it("shows each agent's voice, its colour and where the colour comes from", () => {
    const view = voiceSettingsView(config(), voices)
    const writer = view.agents.find((a) => a.id === "writer")!
    const researcher = view.agents.find((a) => a.id === "researcher")!
    expect(writer.voice).toEqual({ system: "Ava", systemPerLanguage: false, narrate: "on" })
    expect(writer.colorSet).toBe(false)
    expect(writer.color).toMatch(/^#[0-9A-F]{6}$/)
    expect(researcher).toMatchObject({ color: "#123456", colorSet: true })
    expect(view.general).toEqual({ provider: "system", fallback: "system", stt: "auto", localStt: "mlx-whisper", endOfTurn: "vad", hotkeys: { talk: "opt+space", stop: "cmd+opt+period", paste: "cmd+opt+v" }, card: { timeout: 30, maxHeight: 320 }, look: "orb", startReduced: false, stroll: false })
    expect(view.systemVoices.map((v) => v.id)).toEqual(voices.map((v) => v.id))
  })
})

describe("previewLine", () => {
  it("speaks with the unsaved voice on top of the saved one", () => {
    const line = previewLine({ agentId: "writer", voice: { system: "com.apple.voice.compact.en-GB.Daniel", rate: 1.25 } }, config(), voices)
    expect("error" in line).toBe(false)
    if (!("error" in line)) {
      expect(line.voice.system).toBe("com.apple.voice.compact.en-GB.Daniel")
      expect(line.voice.rate).toBe(1.25)
      expect(line.text).toBe("Hello, this is Writer. This is how I sound.")
    }
  })

  it("refuses an unknown agent or a bad value", () => {
    expect(previewLine({ agentId: "nobody" }, config(), voices)).toEqual({ error: 'There is no agent "nobody"' })
    expect(previewLine({ agentId: "writer", voice: { rate: 4 } }, config(), voices)).toMatchObject({ error: expect.stringMatching(/speaking speed/) })
  })
})

describe("speaking speed and queue priority", () => {
  const base = { provider: "system" as const, elevenlabs: "v", system: "Daniel", fallback: true }

  it("passes the speed to say and ElevenLabs", () => {
    expect(sayRate(undefined)).toBeNull()
    expect(sayRate(1.2)).toBe(210)
    expect(sayArgs({ ...base, rate: 0.8 }, "hi")).toEqual(["-v", "Daniel", "-r", "140"])
    expect(sayArgs(base, "hi")).toEqual(["-v", "Daniel"])
    expect(elevenLabsSpeed(1.5)).toBe(1.2)
    expect(elevenLabsSpeed(0.75)).toBe(0.75)
    expect(SIRI_SAY).toContain('rate=${AGENTX_SAY_RATE:-}')
    expect(SIRI_SAY).toContain('say ${rate:+-r "$rate"} -v "$voice" -f "$txt"')
  })

  it("puts a high-priority agent's line ahead of waiting normal and low lines", async () => {
    const played: string[] = []
    const play: Play = (_f, u) => {
      const p = new EventEmitter() as ChildProcess
      played.push(u.text)
      setTimeout(() => p.emit("close", 0), 5)
      ;(p as any).kill = () => p.emit("close", null)
      return p
    }
    const s = new SpeechOut(async () => null, play, {}, () => 60_000)
    const say = (text: string, priority?: "high" | "low"): Utterance => ({ text, agentId: text, kind: "answer", voice: { ...base, ...(priority ? { priority } : {}) } })
    s.pause()
    const done = [
      s.enqueue(say("low one", "low")).done,
      s.enqueue(say("normal one")).done,
      s.enqueue(say("high one", "high")).done,
      s.enqueue(say("normal two")).done,
      s.enqueue(say("high two", "high")).done,
    ]
    expect(s.view().waiting.map((i) => i.text)).toEqual(["high one", "high two", "normal one", "normal two", "low one"])
    s.resume()
    await Promise.all(done)
    expect(played).toEqual(["high one", "high two", "normal one", "normal two", "low one"])
  })
})

describe("the settings endpoints are control POSTs", () => {
  it("needs loopback or a mesh token", () => {
    expect(isControlPost("/voice/settings")).toBe(true)
    expect(isControlPost("/voice/preview")).toBe(true)
  })
})
