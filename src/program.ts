import { Command } from "commander"
import { daemon } from "@/commands/daemon"
import { init } from "@/commands/init"
import { setup } from "@/commands/setup"
import { token } from "@/commands/token"
import { doctor } from "@/commands/doctor"
import { agent, channel, cron, mesh, skillCmd, hook, migrate, configCmd } from "@/commands/manage"
import { schedule } from "@/commands/schedule"
import { connect } from "@/commands/connect"
import { usage } from "@/commands/usage"
import { board } from "@/commands/board"
import { wiki } from "@/commands/wiki"
import { graph } from "@/commands/graph"
import { procedure } from "@/commands/procedure"
import { workflow } from "@/commands/workflow"
import { serve } from "@/commands/serve"
import { bench } from "@/commands/bench"
import { whatsapp } from "@/commands/whatsapp"
import { completion } from "@/commands/completion"
import { getPackageInfo } from "@/utils/get-package-info"

/**
 * Build the full commander tree. Shared between the CLI entrypoint and the
 * `completion` command (which walks the tree to emit a shell completion script).
 */
export async function buildProgram(): Promise<Command> {
  const packageInfo = await getPackageInfo()

  const program = new Command()
    .name("agentx")
    .description(
      "self-hosted multi-agent orchestrator — Telegram, WhatsApp, crons, A2A mesh, wiki knowledge"
    )
    .version(
      packageInfo.version || "1.0.0",
      "-v, --version",
      "display the version number"
    )

  program
    .addCommand(daemon)
    .addCommand(setup)
    .addCommand(init)
    .addCommand(agent)
    .addCommand(channel)
    .addCommand(connect)
    .addCommand(cron)
    .addCommand(schedule)
    .addCommand(mesh)
    .addCommand(skillCmd)
    .addCommand(hook)
    .addCommand(migrate)
    .addCommand(configCmd)
    .addCommand(usage)
    .addCommand(board)
    .addCommand(wiki)
    .addCommand(graph)
    .addCommand(procedure)
    .addCommand(workflow)
    .addCommand(token)
    .addCommand(doctor)
    .addCommand(serve)
    .addCommand(bench)
    .addCommand(whatsapp)
    .addCommand(completion)

  return program
}
