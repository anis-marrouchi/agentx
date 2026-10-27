import { Command } from "commander"
import chalk from "chalk"
import { callingAgent } from "@/agents/holds"
import { loadDaemonConfig } from "@/daemon/config"
import { IMPLICIT_OWNER } from "@/people/people"
import { PictureError, pictureVersion, removePicture, setPicture, type PictureKind } from "@/pictures/pictures"
import { readPictureFile, setOwnPicture } from "@/pictures/self"

// --- agentx agent picture | agentx people picture (#1425) ---
//
//   agent picture set <file> [--agent <id>]   an agent: its own picture only, through the daemon
//                                             the owner: any agent's, with --agent
//   agent picture remove [--agent <id>]       the initials show again
//   agent picture show [--agent <id>]         whether one is set
//   people picture set <id> <file>            the owner only
//   people picture remove <id>
//
// The owner runs these from the folder that holds agentx.json. An agent
// runs `agent picture` from its own shell: the runtime exports
// AGENTX_AGENT_ID and the run's proof, and the daemon checks the run is
// that agent's before it changes anything.

const daemonBase = () => (process.env.AGENTX_DAEMON_URL || "http://127.0.0.1:18800").replace(/\/+$/, "")

function fail(message: string): void {
  console.error(chalk.red(`  ${message}`))
  process.exitCode = 1
}

/** Whether agentx.json here lists `id` as an agent or a person. */
function listed(kind: PictureKind, id: string): boolean {
  let config
  try { config = loadDaemonConfig() } catch (e: any) { fail(`${e.message.split("\n")[0]}. Run this from the folder that holds agentx.json.`); return false }
  const ok = kind === "agent" ? !!config.agents?.[id] : id === IMPLICIT_OWNER || (config.people ?? []).some((p) => p.id === id)
  if (!ok) fail(kind === "agent" ? `No agent "${id}" in agentx.json.` : `No person "${id}" in agentx.json: agentx people list`)
  return ok
}

async function ownerSet(kind: PictureKind, id: string, file: string): Promise<void> {
  if (!listed(kind, id)) return
  try {
    await setPicture(process.cwd(), kind, id, readPictureFile(file))
    console.log(chalk.green(`  ✓ picture set for ${kind} "${id}". Pages show it on their next load.`))
  } catch (e: any) {
    if (e instanceof PictureError) { fail(e.message); return }
    throw e
  }
}

function ownerRemove(kind: PictureKind, id: string): void {
  if (!listed(kind, id)) return
  console.log(removePicture(process.cwd(), kind, id)
    ? chalk.green(`  ✓ picture removed for ${kind} "${id}"; the initials show again.`)
    : chalk.dim(`  ${kind} "${id}" has no picture.`))
}

/** The agent this command is about: the caller when an agent runs it. */
function targetAgent(opts: { agent?: string }): string | undefined {
  const id = opts.agent?.trim() || callingAgent()
  if (!id) fail("Say which agent: --agent <id>")
  return id
}

export function agentPictureCommand(): Command {
  const cmd = new Command("picture").description("an agent's profile picture: set, remove or show (an agent may set its own)")

  cmd
    .command("set <file>")
    .description("set the picture from a PNG, JPEG or WebP file (1 MB at most); it is cut to a square, metadata dropped")
    .option("--agent <id>", "which agent (default: the agent running this command)")
    .action(async (file: string, opts: { agent?: string }) => {
      if (callingAgent()) {
        const r = await setOwnPicture(file, opts.agent?.trim(), { daemonUrl: daemonBase() })
        return r.ok ? console.log(chalk.green(`  ✓ ${r.message}`)) : fail(r.message)
      }
      const id = targetAgent(opts)
      if (id) await ownerSet("agent", id, file)
    })

  cmd
    .command("remove")
    .alias("rm")
    .description("remove the picture: the initials show again")
    .option("--agent <id>", "which agent (default: the agent running this command)")
    .action(async (opts: { agent?: string }) => {
      if (callingAgent()) {
        const r = await setOwnPicture(null, opts.agent?.trim(), { daemonUrl: daemonBase() })
        return r.ok ? console.log(chalk.green(`  ✓ ${r.message}`)) : fail(r.message)
      }
      const id = targetAgent(opts)
      if (id) ownerRemove("agent", id)
    })

  cmd
    .command("show")
    .description("say whether the agent has a picture")
    .option("--agent <id>", "which agent (default: the agent running this command)")
    .action((opts: { agent?: string }) => {
      const id = targetAgent(opts)
      if (!id) return
      const v = pictureVersion(process.cwd(), "agent", id)
      console.log(v ? `  ${id}: picture set (.agentx/pictures/agent/${id}.${v}.webp)` : chalk.dim(`  ${id}: no picture, the initials show`))
    })
  return cmd
}

export function peoplePictureCommand(): Command {
  const cmd = new Command("picture").description("a person's profile picture: set or remove (the owner only)")
  const ownerOnly = () => {
    const by = callingAgent()
    if (by) fail(`Only the owner sets a person's picture; agent "${by}" asked.`)
    return !by
  }
  cmd
    .command("set <id> <file>")
    .description("set the picture from a PNG, JPEG or WebP file (1 MB at most); it is cut to a square, metadata dropped")
    .action(async (id: string, file: string) => { if (ownerOnly()) await ownerSet("person", id, file) })
  cmd
    .command("remove <id>")
    .alias("rm")
    .description("remove the picture: the initials show again")
    .action((id: string) => { if (ownerOnly()) ownerRemove("person", id) })
  return cmd
}
