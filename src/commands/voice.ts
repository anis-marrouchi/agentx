import { Command } from "commander"
import chalk from "chalk"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"
import { OS_DEFAULT, label, languageVoices, localSystemVoices } from "@/voice/agent-voice"
import { candidates, findVoice, listSystemVoices, type SystemVoice } from "@/voice/system-voices"
import { ORB_PALETTES, ORB_PALETTE_IDS, VOICE_ANIMATIONS, VOICE_LOOKS, agentPalette, type VoiceAnimations, type VoiceLook } from "@/voice/orb-palettes"
import { presenceLook } from "@/voice/presence"
import { findMissingVoices, REINSTALL_HINT, voiceDisplayName } from "@/voice/voice-health"
import { CARD_LIMITS, applyVoiceSettings, checkVoiceSettings, type VoiceSettingsPatch } from "@/daemon/voice-settings-api"
import { formatLesson, gradeLesson, readLessons, type Verdict } from "@/voice/lesson-log"

// --- agentx voice: which voice each agent speaks with ---
//
// `list` shows the macOS voices installed here, best first, and who uses
// which. `set` writes the agent's choice into agentx.json; a running
// daemon reloads that file, so the next line is spoken in the new voice.

export const voice = new Command()
  .name("voice")
  .description("list installed system voices and pick each agent's voice")

type Provider = "system" | "elevenlabs"

/** agentx.json as the operator wrote it, env placeholders and all. */
function configFile(explicit?: string): string {
  const paths = explicit ? [explicit] : [resolve(process.cwd(), "agentx.json"), resolve(process.cwd(), ".agentx/config.json")]
  const found = paths.find((p) => existsSync(p))
  if (!found) throw new Error(`No config found. Searched: ${paths.join(", ")}`)
  return found
}

export interface SetOptions {
  provider?: Provider
  /** Set the voice for this language only ("fr", "ar"). */
  lang?: string
  gender?: "female" | "male" | "neutral"
}

/**
 * The agent's `voice` block after `agentx voice set`. An installed system
 * voice, or "system" for the OS default, is stored by the name typed;
 * anything else is taken as an ElevenLabs voice id only when the provider
 * is elevenlabs, so a typo is an error rather than a silent switch to a
 * paid service. With --lang the voice goes into a per-language list; a
 * plain name already there becomes the entry for the default language.
 */
export function setAgentVoice(
  raw: any, agentId: string, choice: string | undefined, opts: SetOptions, installed: SystemVoice[],
): { raw: any; summary: string } {
  const { provider, gender } = opts
  const lang = opts.lang?.toLowerCase().split(/[-_]/)[0]
  const agent = raw?.agents?.[agentId]
  if (!agent) throw new Error(`No agent "${agentId}" in agentx.json`)
  if (provider && provider !== "system" && provider !== "elevenlabs") throw new Error("--provider must be system or elevenlabs")
  if (gender && !["female", "male", "neutral"].includes(gender)) throw new Error("--gender must be female, male or neutral")
  if (lang && !choice) throw new Error("--lang needs a voice")
  if (!choice && !provider && !gender) throw new Error("Give a voice, a --provider, a --gender, or a mix")
  const block = { ...(agent.voice ?? {}) }
  if (provider) block.provider = provider
  if (gender) block.gender = gender
  const effective: Provider = block.provider ?? raw?.voice?.provider ?? "system"
  const parts = [provider && `provider ${provider}`, gender && `gender ${gender}`]
  const store = (name: string) => {
    if (!lang) { block.system = name; return }
    const list = typeof block.system === "string"
      ? { [String(raw?.voice?.locale ?? "en").toLowerCase().split(/[-_]/)[0]]: block.system }
      : { ...(block.system ?? {}) }
    block.system = { ...list, [lang]: name }
  }
  const where = lang ? ` for ${lang}` : ""
  if (choice) {
    const osDefault = choice.trim().toLowerCase() === OS_DEFAULT
    const found = osDefault ? null : findVoice(choice, installed, lang ?? raw?.voice?.locale)
    const what = found ? `system voice ${label(found)}` : "the OS default voice"
    if ((found || osDefault) && effective === "system") {
      store(osDefault ? OS_DEFAULT : choice)
      parts.push(`${what}${where}`)
    } else if (effective === "elevenlabs" && !found && !osDefault && !lang) {
      block.elevenlabsVoiceId = choice
      parts.push(`ElevenLabs voice ${choice}`)
    } else if (found || osDefault) {
      // A system voice named while the agent speaks through ElevenLabs:
      // keep it as the fallback voice.
      store(osDefault ? OS_DEFAULT : choice)
      parts.push(`fallback ${what}${where}`)
    } else {
      throw new Error(`"${choice}" is not an installed system voice. Run \`agentx voice list\`, or add --provider elevenlabs for an ElevenLabs voice id.`)
    }
  }
  const summary = parts.filter(Boolean).join(", ")
  return { raw: { ...raw, agents: { ...raw.agents, [agentId]: { ...agent, voice: block } } }, summary }
}

voice
  .command("list")
  .alias("ls")
  .description("installed system voices, best first, and which agent uses which")
  .option("--all", "every language, not only the configured one")
  .option("-c, --config <path>", "agentx.json to read")
  .action((opts) => {
    const installed = listSystemVoices()
    let config: ReturnType<typeof loadDaemonConfig> | undefined
    try { config = loadDaemonConfig(opts.config) } catch { /* voices still list */ }
    const locale = config?.voice.locale ?? "en"
    const users = new Map<string, string[]>()
    const voices = config ? localSystemVoices(config.agents, config.voice, installed) : new Map()
    if (config) {
      for (const [id, a] of Object.entries(config.agents)) {
        const own = voices.get(id)
        const langs = Object.values(languageVoices(id, a.voice?.system, a.voice?.gender, config.voice, installed))
        for (const v of new Set([own, ...langs])) if (v) users.set(v.id, [...(users.get(v.id) ?? []), id])
      }
    }
    if (!installed.length) {
      console.log(chalk.yellow("\n  No system voices found (system voices need macOS).\n"))
    } else {
      const shown = opts.all ? candidates(installed, "") : candidates(installed, locale)
      console.log(chalk.bold(`\n  System voices${opts.all ? "" : ` (${locale})`}, best first\n`))
      for (const v of shown) {
        const tier = v.siri ? chalk.magenta("siri") : v.quality === "standard" ? chalk.dim("standard") : chalk.green(v.quality)
        const who = users.get(v.id)?.join(", ")
        console.log(`  ${(v.siri ? `siri:${v.name.toLowerCase()}` : v.name).padEnd(12)} ${v.locale.padEnd(6)} ${tier.padEnd(18)} ${chalk.dim((v.gender ?? "").padEnd(7))} ${who ? chalk.cyan(who) : ""}`)
      }
      if (!installed.some((v) => v.quality !== "standard")) {
        console.log(chalk.dim("\n  More natural voices are free: System Settings → Accessibility → Spoken Content →"))
        console.log(chalk.dim("  System Voice → Manage Voices, then download a Premium or Enhanced voice."))
      }
    }
    const missing = config ? findMissingVoices(config, installed) : []
    if (missing.length) {
      console.log(chalk.bold.yellow("\n  Not installed\n"))
      for (const m of missing) console.log(`  ${voiceDisplayName(m.voice).padEnd(24)} ${chalk.cyan(m.agents.join(", "))}`)
      console.log(chalk.dim(`\n  Reinstall in ${REINSTALL_HINT}.`))
      console.log(chalk.dim("  Until then each agent speaks with the voice shown below; a running daemon switches back on its own."))
    }
    if (config) {
      console.log(chalk.bold("\n  Agents\n"))
      for (const [id, a] of Object.entries(config.agents)) {
        const provider = a.voice?.provider ?? config.voice.provider
        const name = (v: SystemVoice | null | undefined) => (v ? label(v) : chalk.dim("system default"))
        const langs = Object.entries(languageVoices(id, a.voice?.system, a.voice?.gender, config.voice, installed))
          .filter(([, v]) => (v?.id ?? null) !== (voices.get(id)?.id ?? null))
          .map(([l, v]) => `${chalk.dim(`${l}:`)} ${name(v)}`).join(chalk.dim(" · "))
        const what = provider === "elevenlabs"
          ? `elevenlabs ${a.voice?.elevenlabsVoiceId ?? chalk.dim("(default voice)")}`
          : `system     ${name(voices.get(id))}${langs ? chalk.dim(" · ") + langs : ""}`
        const gone = missing.filter((m) => m.agents.includes(id)).map((m) => voiceDisplayName(m.voice))
        const note = gone.length ? chalk.yellow(` — stands in for ${gone.join(", ")} (not installed)`) : ""
        console.log(`  ${id.padEnd(24)} ${what}${a.voice?.gender ? chalk.dim(` (${a.voice.gender})`) : ""}${note}`)
      }
    }
    console.log()
  })

voice
  .command("set <agent> [voice]")
  .description(`pick an agent's voice: a system voice name, a Siri voice as siri:<name>, "${OS_DEFAULT}" for the OS default, or an ElevenLabs id with --provider elevenlabs`)
  .option("--provider <provider>", "system or elevenlabs")
  .option("--lang <lang>", "use this voice for lines in one language only: en, fr, ar")
  .option("--gender <gender>", "female, male or neutral; an assigned voice matches it")
  .option("-c, --config <path>", "agentx.json to change")
  .action((agentId: string, choice: string | undefined, opts) => {
    try {
      const file = configFile(opts.config)
      const { raw, summary } = setAgentVoice(JSON.parse(readFileSync(file, "utf8")), agentId, choice, opts, listSystemVoices())
      // In place, not write-and-rename: the daemon watches this file for
      // "change" events, and a rename would swap the file out from under it.
      writeFileSync(file, JSON.stringify(raw, null, 2) + "\n")
      console.log(chalk.green(`  ${agentId}: ${summary}`))
      console.log(chalk.dim("  A running daemon picks this up on its next line."))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

/** Check a settings patch as the settings window's save does, then write
 *  it into agentx.json in place. */
function saveSettings(file: string, patch: VoiceSettingsPatch): void {
  const errors = checkVoiceSettings(patch, loadDaemonConfig(file))
  if (errors.length) throw new Error(errors.map((e) => e.message).join("\n  "))
  const raw = JSON.parse(readFileSync(file, "utf8"))
  applyVoiceSettings(raw, patch)
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n")
}

voice
  .command("palette [agent] [palette]")
  .description(`the voice orb's colours: list the palettes, or pick one for an agent (${ORB_PALETTE_IDS.join(", ")}; "default" follows the agent's colour, or voice.palette when it has none)`)
  .option("-c, --config <path>", "agentx.json to read or change")
  .action((agentId: string | undefined, choice: string | undefined, opts) => {
    try {
      const file = configFile(opts.config)
      if (agentId && choice) {
        const palette = choice === "default" ? null : choice
        saveSettings(file, { agents: { [agentId]: { palette } } })
        console.log(chalk.green(`  ${agentId}: ${palette ? `palette ${palette}` : "palette follows its colour"}`))
        console.log(chalk.dim("  AgentX Voice picks this up the next time its menu opens."))
        return
      }
      const config = loadDaemonConfig(file)
      if (agentId && !config.agents[agentId]) throw new Error(`No agent "${agentId}" in agentx.json`)
      console.log(chalk.bold("\n  Orb palettes\n"))
      for (const p of ORB_PALETTES) console.log(`  ${p.id.padEnd(10)} ${chalk.dim(p.colors.join(" "))}`)
      console.log(chalk.bold("\n  Agents\n"))
      for (const [id, a] of Object.entries(config.agents)) {
        if (agentId && id !== agentId) continue
        const color = presenceLook(id, a).color
        const p = agentPalette(a.presence, config.voice.palette)
        console.log(`  ${id.padEnd(24)} ${p.id.padEnd(10)} ${chalk.dim(p.set ? "chosen" : a.presence?.color ? `nearest its colour ${color}` : "the default, voice.palette")}`)
      }
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

voice
  .command("look [look]")
  .description(`what shows the assistant's state in AgentX Voice: ${VOICE_LOOKS.join(" or ")}`)
  .option("-c, --config <path>", "agentx.json to read or change")
  .action((look: string | undefined, opts) => {
    try {
      const file = configFile(opts.config)
      if (look !== undefined) saveSettings(file, { general: { look: look as VoiceLook } })
      const now = loadDaemonConfig(file).voice.look
      console.log(`  Shown as: ${now === "character" ? "the character, above the bottom edge of the screen" : "the orb, in the pill"}`)
      if (look !== undefined) console.log(chalk.dim("  AgentX Voice picks this up within a few seconds."))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

voice
  .command("start [form]")
  .description("how the pill is when AgentX Voice starts: full, or reduced to its orb (the character alone, with the character)")
  .option("-c, --config <path>", "agentx.json to read or change")
  .action((form: string | undefined, opts) => {
    try {
      const file = configFile(opts.config)
      if (form !== undefined && form !== "full" && form !== "reduced") throw new Error("The pill starts full or reduced")
      if (form !== undefined) saveSettings(file, { general: { startReduced: form === "reduced" } })
      const now = loadDaemonConfig(file).voice
      const reduced = now.look === "character" ? "the character alone, without its speech bubble" : "the orb alone, reduced"
      console.log(`  Starts as: ${now.startReduced ? reduced : "the full pill"}`)
      if (form !== undefined) console.log(chalk.dim("  AgentX Voice picks this up the next time it starts."))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

voice
  .command("animations [often]")
  .description("how often the character plays a small animation by itself when idle: off, rarely, sometimes or often")
  .option("-c, --config <path>", "agentx.json to read or change")
  .action((often: string | undefined, opts) => {
    try {
      const file = configFile(opts.config)
      if (often !== undefined && !VOICE_ANIMATIONS.includes(often as VoiceAnimations)) throw new Error("Animations are off, rarely, sometimes or often")
      if (often !== undefined) saveSettings(file, { general: { animations: often as VoiceAnimations } })
      const now = loadDaemonConfig(file).voice
      console.log(`  When idle: ${now.animations === "off" ? "the character plays no animation by itself" : `the character plays a small animation ${now.animations}`}`)
      if (now.animations !== "off" && now.look !== "character") console.log(chalk.dim("  No effect while the orb is shown."))
      if (often !== undefined) console.log(chalk.dim("  AgentX Voice picks this up within a few seconds."))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

voice
  .command("stroll [state]")
  .description("whether the character takes a slow stroll when it has nothing to do: on or off")
  .option("-c, --config <path>", "agentx.json to read or change")
  .action((state: string | undefined, opts) => {
    try {
      const file = configFile(opts.config)
      if (state !== undefined && state !== "on" && state !== "off") throw new Error("The stroll is on or off")
      if (state !== undefined) saveSettings(file, { general: { stroll: state === "on" } })
      const now = loadDaemonConfig(file).voice
      console.log(`  When idle: ${now.stroll ? "the character takes a slow stroll now and then" : "the character stays where it rests"}`)
      if (now.stroll && now.look !== "character") console.log(chalk.dim("  No effect while the orb is shown."))
      if (state !== undefined) console.log(chalk.dim("  AgentX Voice picks this up within a few seconds."))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

/** Where the daemon's log is on this Mac: the launchd service writes
 *  ~/.agentx/logs/daemon-stderr.log, `agentx daemon start` /tmp/agentx-daemon.log. */
export function lessonLogCandidates(home = homedir()): string[] {
  return [join(home, ".agentx", "logs", "daemon-stderr.log"), "/tmp/agentx-daemon.log"]
}

voice
  .command("lessons")
  .description("what the last live lessons did, read from the daemon log and graded against the hands-free check")
  .option("--log <path>", "the daemon log to read, or - for standard input (default: the first of ~/.agentx/logs/daemon-stderr.log and /tmp/agentx-daemon.log that exists)")
  .option("-n, --last <n>", "how many lessons to show, oldest first", "3")
  .option("--json", "print the lessons and their checks as JSON")
  .action((opts) => {
    try {
      const file = opts.log === "-" ? 0 : opts.log ? resolve(opts.log) : lessonLogCandidates().find((p) => existsSync(p))
      if (file === undefined) throw new Error(`No daemon log found. Searched: ${lessonLogCandidates().join(", ")}. Give one with --log <path>.`)
      const last = Math.max(1, Number(opts.last) || 3)
      const lessons = readLessons(readFileSync(file, "utf8")).slice(-last)
      if (opts.json) {
        console.log(JSON.stringify(lessons.map((l) => ({ ...l, checks: gradeLesson(l) })), null, 2))
        return
      }
      if (!lessons.length) {
        console.log(chalk.yellow(`  No lesson in ${file === 0 ? "the input" : file}.`))
        console.log(chalk.dim("  A lesson writes [teach] lines there as it runs. Start one by voice (\"show me how…\") or with agentx teach --live."))
        return
      }
      const paint = (v: Verdict, t: string) => (v === "ok" ? chalk.green(t) : v === "not ok" ? chalk.red(t) : v === "by eye" ? chalk.yellow(t) : chalk.dim(t))
      console.log(chalk.bold(`\n  Last ${lessons.length === 1 ? "lesson" : `${lessons.length} lessons`} in ${file === 0 ? "the input" : file}\n`))
      for (const l of lessons) console.log(formatLesson(l, paint) + "\n")
      console.log(chalk.dim("  ok: the log shows it.  not ok: the log shows the opposite.  not seen: the lesson did not reach that point.  by eye: only the screen can tell."))
      console.log()
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

voice
  .command("card")
  .description("the answer shown in the pill: how long it stays open and how tall it grows")
  .option("--timeout <seconds>", `seconds it stays open once spoken, ${CARD_LIMITS.timeout.join("–")}; 0 keeps it open until closed`)
  .option("--max-height <points>", `tallest it grows before it scrolls, ${CARD_LIMITS.maxHeight.join("–")}`)
  .option("-c, --config <path>", "agentx.json to read or change")
  .action((opts) => {
    try {
      const file = configFile(opts.config)
      const card: { timeout?: number; maxHeight?: number } = {}
      if (opts.timeout !== undefined) card.timeout = Number(opts.timeout)
      if (opts.maxHeight !== undefined) card.maxHeight = Number(opts.maxHeight)
      if (Object.keys(card).length) saveSettings(file, { general: { card } })
      const now = loadDaemonConfig(file).voice.card
      const open = now.timeout === 0 ? "until closed" : `${now.timeout} s after it is spoken`
      console.log(`  Answer card: open ${open}, at most ${now.maxHeight} pt tall`)
      if (Object.keys(card).length) console.log(chalk.dim("  AgentX Voice picks this up within a few seconds."))
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })
