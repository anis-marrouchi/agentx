import { Command } from "commander"
import chalk from "chalk"
import { deprecationNotice, CHAT_SURFACE_DEPRECATION } from "./deprecation"

// `agentx tui` — read-only mission-control view over the running daemon.
//
// Mounts an Ink app that polls /agents, /api/processes, /crons and
// streams /events. Intentionally minimal in v0: no chat composer, no
// kill/cancel; those land in v1 once the layout is settled.

export const tui = new Command()
  .name("tui")
  .description("[deprecated — see agentx attach] interactive terminal mission control")
  .option("-c, --config <path>", "daemon config file")
  .option("--node <url>", "daemon URL (defaults to dashboard.daemonUrl from config)")
  .option("--token <token>", "bearer token (defaults to dashboard.token from config)")
  .option("--poll <ms>", "snapshot poll interval in ms", "3000")
  .action(async (opts) => {
    deprecationNotice({ what: "agentx tui", ...CHAT_SURFACE_DEPRECATION })
    if (!process.stdout.isTTY) {
      console.error(chalk.red("agentx tui requires an interactive terminal"))
      process.exit(1)
    }
    // Defer-load Ink + the app so non-TUI commands don't pay the React/Ink
    // import cost.
    const { resolveConn } = await import("@/tui/client")
    const { App } = await import("@/tui/App")
    const { render } = await import("ink")
    const React = (await import("react")).default

    const conn = resolveConn({ node: opts.node, token: opts.token, config: opts.config })
    const pollMs = Math.max(500, Number(opts.poll) || 3000)
    const instance = render(React.createElement(App, { conn, pollMs }))
    await instance.waitUntilExit()
  })
