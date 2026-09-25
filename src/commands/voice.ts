import { Command } from "commander"
import chalk from "chalk"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"
import { label, localSystemVoices } from "@/voice/agent-voice"
import { candidates, findVoice, listSystemVoices, type SystemVoice } from "@/voice/system-voices"

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

/**
 * The agent's `voice` block after `agentx voice set`. An installed system
 * voice is stored by the name typed; anything else is taken as an
 * ElevenLabs voice id only when the provider is elevenlabs, so a typo is
 * an error rather than a silent switch to a paid service.
 */
export function setAgentVoice(
  raw: any, agentId: string, choice: string | undefined, provider: Provider | undefined, installed: SystemVoice[],
): { raw: any; summary: string } {
  const agent = raw?.agents?.[agentId]
  if (!agent) throw new Error(`No agent "${agentId}" in agentx.json`)
  if (provider && provider !== "system" && provider !== "elevenlabs") throw new Error("--provider must be system or elevenlabs")
  if (!choice && !provider) throw new Error("Give a voice, a --provider, or both")
  const block = { ...(agent.voice ?? {}) }
  if (provider) block.provider = provider
  const effective: Provider = block.provider ?? raw?.voice?.provider ?? "system"
  let summary = provider ? `provider ${provider}` : ""
  if (choice) {
    const found = findVoice(choice, installed, raw?.voice?.locale)
    if (found && effective === "system") {
      block.system = choice
      summary = [summary, `system voice ${label(found)}`].filter(Boolean).join(", ")
    } else if (effective === "elevenlabs" && !found) {
      block.elevenlabsVoiceId = choice
      summary = [summary, `ElevenLabs voice ${choice}`].filter(Boolean).join(", ")
    } else if (found) {
      // A system voice named while the agent speaks through ElevenLabs:
      // keep it as the fallback voice.
      block.system = choice
      summary = [summary, `fallback system voice ${label(found)}`].filter(Boolean).join(", ")
    } else {
      throw new Error(`"${choice}" is not an installed system voice. Run \`agentx voice list\`, or add --provider elevenlabs for an ElevenLabs voice id.`)
    }
  }
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
    if (config) {
      for (const [id, v] of localSystemVoices(config.agents, config.voice, installed)) {
        users.set(v.id, [...(users.get(v.id) ?? []), id])
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
      if (!installed.some((v) => v.quality !== "standard")) {
        console.log(chalk.dim("\n  More natural voices are free: System Settings → Accessibility → Spoken Content →"))
        console.log(chalk.dim("  System Voice → Manage Voices, then download a Premium or Enhanced voice."))
      }
    }
    if (config) {
      console.log(chalk.bold("\n  Agents\n"))
      const voices = localSystemVoices(config.agents, config.voice, installed)
      for (const [id, a] of Object.entries(config.agents)) {
        const provider = a.voice?.provider ?? config.voice.provider
        const sys = voices.get(id)
        const what = provider === "elevenlabs"
          ? `elevenlabs ${a.voice?.elevenlabsVoiceId ?? chalk.dim("(default voice)")}`
          : `system     ${sys ? label(sys) : chalk.dim("(OS default)")}`
        console.log(`  ${id.padEnd(24)} ${what}`)
      }
    }
    console.log()
  })

voice
  .command("set <agent> [voice]")
  .description("pick an agent's voice: a system voice name, or an ElevenLabs id with --provider elevenlabs")
  .option("--provider <provider>", "system or elevenlabs")
  .option("-c, --config <path>", "agentx.json to change")
  .action((agentId: string, choice: string | undefined, opts) => {
    try {
      const file = configFile(opts.config)
      const { raw, summary } = setAgentVoice(JSON.parse(readFileSync(file, "utf8")), agentId, choice, opts.provider, listSystemVoices())
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
