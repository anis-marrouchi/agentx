import { Command } from "commander"
import chalk from "chalk"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"
import { OS_DEFAULT, label, languageVoices, localSystemVoices } from "@/voice/agent-voice"
import { candidates, findVoice, listSystemVoices, type SystemVoice } from "@/voice/system-voices"
import { isSiriId, SIRI_PREFIX } from "@/voice/siri-voices"

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
        const tier = v.quality === "standard" ? chalk.dim("standard") : chalk.green(v.quality)
        const who = users.get(v.id)?.join(", ")
        console.log(`  ${v.name.padEnd(12)} ${v.locale.padEnd(6)} ${tier.padEnd(18)} ${chalk.dim((v.gender ?? "").padEnd(7))} ${who ? chalk.cyan(who) : ""}`)
      }
      const siri = installed.filter((v) => isSiriId(v.id)).sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name))
      if (siri.length) {
        console.log(chalk.bold(`\n  Siri voices: name them as ${SIRI_PREFIX}<name>; the system voice is switched for each line\n`))
        for (const v of siri) {
          const who = users.get(v.id)?.join(", ")
          console.log(`  ${`${SIRI_PREFIX}${v.name.toLowerCase()}`.padEnd(14)} ${v.locale.padEnd(6)} ${chalk.dim((v.gender ?? "").padEnd(7))} ${who ? chalk.cyan(who) : ""}`)
        }
      }
      if (!installed.some((v) => v.quality !== "standard")) {
        console.log(chalk.dim("\n  More natural voices are free: System Settings → Accessibility → Spoken Content →"))
        console.log(chalk.dim("  System Voice → Manage Voices, then download a Premium or Enhanced voice."))
      }
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
        console.log(`  ${id.padEnd(24)} ${what}${a.voice?.gender ? chalk.dim(` (${a.voice.gender})`) : ""}`)
      }
    }
    console.log()
  })

voice
  .command("set <agent> [voice]")
  .description(`pick an agent's voice: a system voice name, "${OS_DEFAULT}" for the OS default (Siri voices), or an ElevenLabs id with --provider elevenlabs`)
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
