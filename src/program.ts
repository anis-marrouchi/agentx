import { monitor as monitorCmd } from "@/commands/monitor"
import { Command } from "commander"
import { daemon } from "@/commands/daemon"
import { init } from "@/commands/init"
import { setup } from "@/commands/setup"
import { token } from "@/commands/token"
import { doctor } from "@/commands/doctor"
import { agent, channel, cron, mesh, skillCmd, references, hook, migrate, configCmd } from "@/commands/manage"
import { db as dbCmd } from "@/commands/db"
import { ledger as ledgerCmd } from "@/commands/ledger"
import { trace as traceCmd } from "@/commands/trace"
import { guard as guardCmd } from "@/commands/guard"
import { attach as attachCmd } from "@/commands/attach"
import { process_ as processCmd } from "@/commands/process"
import { rag as ragCmd } from "@/commands/rag"
import { backlog } from "@/commands/backlog"
import { schedule } from "@/commands/schedule"
import { connect } from "@/commands/connect"
import { usage } from "@/commands/usage"
import { board } from "@/commands/board"
import { wiki } from "@/commands/wiki"
import { graph } from "@/commands/graph"
import { procedure } from "@/commands/procedure"
import { workflow } from "@/commands/workflow"
import { webhook } from "@/commands/webhook"
import { business } from "@/commands/business"
import { plan } from "@/commands/plan"
import { notifications } from "@/commands/notifications"
import { retention } from "@/commands/retention"
import { actions as actionsCmd } from "@/commands/actions"
import { watch } from "@/commands/watch"
import { tui } from "@/commands/tui"
import { chat } from "@/commands/chat"
import { memory as memoryCmd } from "@/commands/memory"
import { serve } from "@/commands/serve"
import { demo } from "@/commands/demo"
import { whatsapp } from "@/commands/whatsapp"
import { plugin as pluginCmd } from "@/commands/plugin"
import { completion } from "@/commands/completion"
import { getPackageInfo } from "@/utils/get-package-info"
import { commandPath, recordSurfaceUse, shouldRecordCommand } from "@/observability/surface-usage"

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

  // Count which commands operators actually run. Names only — never args.
  // The 46-command surface has no usage data behind it, so decisions about
  // what to keep are currently opinion; this makes them evidence.
  // See docs/architecture/surface-reduction.md.
  program.hook("preAction", (_thisCommand, actionCommand) => {
    const path = commandPath(actionCommand as any)
    if (shouldRecordCommand(path)) recordSurfaceUse("cli", path)
  })

  // --- Core: what `agentx --help` shows -----------------------------------
  //
  // Getting set up, running the daemon, and the handful of things an operator
  // reaches for while the fleet is live.
  for (const cmd of [
    setup, init, connect,        // get running
    daemon, doctor,              // operate
    agent, channel, schedule,    // configure the things that carry work
    attachCmd, monitorCmd,       // connect editor sessions
    guardCmd,                    // safety
    usage,                       // what it cost, what gets used
    serve,                       // MCP
    token, configCmd, completion,
  ]) program.addCommand(cmd)

  // --- Advanced: registered, documented, hidden from the default help ------
  //
  // 268 commands and subcommands accumulated here. The evidence for cutting
  // the list down is unusually direct: on clawd — the node carrying 95% of
  // fleet traffic — `~/.bash_history` contains ZERO `agentx <subcommand>`
  // invocations. Production is operated with systemctl, journalctl, a text
  // editor and the dashboard. The CLI is a development surface.
  //
  // So these are hidden, NOT removed. Every one still runs, still has its own
  // `--help`, and still completes in the shell; they just stop competing for
  // attention with the fifteen commands above. Hiding is reversible in a line
  // and costs nobody anything, which is the right trade while the usage soak
  // is still young — see docs/architecture/surface-reduction.md.
  //
  // The help footer below names them all, so nothing here is secret.
  for (const cmd of ADVANCED) program.addCommand(cmd, { hidden: true })

  program.addHelpText("after", () => {
    const names = ADVANCED.map((c) => c.name()).sort()
    return [
      "",
      `Advanced (${names.length}, hidden — run \`agentx <command> --help\` for any of them):`,
      wrapNames(names, 74, "  "),
      "",
    ].join("\n")
  })

  return program
}

/** Registered and fully functional, just not in the default help listing. */
const ADVANCED = [
  // Knowledge + memory
  wiki, graph, memoryCmd, procedure, references, ragCmd,
  // Workflow / BPM
  workflow, webhook, board, backlog, business, plan,
  // Observability + forensics
  ledgerCmd, traceCmd, processCmd, watch, dbCmd,
  // Fleet + extension
  mesh, skillCmd, pluginCmd, hook, actionsCmd,
  // Scheduling internals (`schedule` is the friendly front door)
  cron,
  // Housekeeping
  migrate, retention, notifications,
  // Channel-specific + demo
  whatsapp, demo,
  // Deprecated — superseded by `agentx attach`
  chat, tui,
]

/** Pack names into indented lines of at most `width` characters. */
function wrapNames(names: string[], width: number, indent: string): string {
  const lines: string[] = []
  let line = ""
  for (const n of names) {
    if (line && (line.length + n.length + 2) > width) {
      lines.push(indent + line)
      line = ""
    }
    line += (line ? ", " : "") + n
  }
  if (line) lines.push(indent + line)
  return lines.join("\n")
}
