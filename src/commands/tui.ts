import { Command } from "commander"
import chalk from "chalk"
import { spawn } from "node:child_process"
import { checkOpenCodeVersion } from "@/tui/opencode-cli"

// OpenCode is the preferred terminal UI. The built-in Ink UI remains a
// functional fallback when OpenCode v2 is unavailable.

export const tui = new Command()
  .name("tui")
  .description("open the AgentX console in OpenCode")
  .option("-c, --config <path>", "daemon config file")
  .option("--node <url>", "daemon URL (defaults to dashboard.daemonUrl from config)")
  .option("--token <token>", "daemon mesh bearer token for remote nodes")
  .option("--agent <id>", "AgentX agent to use as the OpenCode model")
  .option("--legacy", "open the built-in Ink terminal UI")
  .option("--poll <ms>", "legacy UI snapshot poll interval in ms", "3000")
  .action(async (opts) => {
    if (!process.stdout.isTTY) {
      console.error(chalk.red("agentx tui requires an interactive terminal"))
      process.exit(1)
    }
    const { resolveConn } = await import("@/tui/client")
    const conn = resolveConn({ node: opts.node, token: opts.token, config: opts.config })
    const openCode = opts.legacy ? null : checkOpenCodeVersion()
    if (openCode?.ok) {
      const { fetchAgents } = await import("@/tui/client")
      const agents = await fetchAgents(conn)
      if (!agents.length) throw new Error(`No AgentX agents returned by ${conn.baseUrl}`)
      const agentId = opts.agent || agents[0].id
      if (!agents.some(agent => agent.id === agentId)) throw new Error(`Unknown AgentX agent: ${agentId}`)
      let inlineServerConfig: Record<string, any> = {}
      try { inlineServerConfig = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}") } catch { /* ignore invalid override */ }
      const models = Object.fromEntries(agents.map(agent => [agent.id, { name: `AgentX ${agent.name || agent.id}` }]))
      const env = {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...inlineServerConfig,
          model: `agentx/${agentId}`,
          providers: {
            ...inlineServerConfig.providers,
            agentx: {
              name: "AgentX",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: `${conn.baseUrl}/v1` },
              models,
            },
          },
        }),
      }
      console.error(chalk.dim(`Opening ${openCode.version} with AgentX model ${agentId}.`))
      const child = spawn("opencode", ["--standalone"], { stdio: "inherit", env })
      await new Promise<void>((done, reject) => {
        child.once("error", reject)
        child.once("exit", code => code === 0 ? done() : reject(new Error(`OpenCode exited with code ${code ?? "unknown"}`)))
      })
      return
    }
    if (openCode && !openCode.ok) {
      console.error(chalk.yellow(openCode.reason))
      console.error(chalk.dim("Using the built-in AgentX TUI. Install OpenCode v2: https://opencode.ai/v2/docs"))
    }
    // Defer-load Ink + the app so non-TUI commands don't pay the React/Ink import cost.
    const { App } = await import("@/tui/App")
    const { render } = await import("ink")
    const React = (await import("react")).default

    const pollMs = Math.max(500, Number(opts.poll) || 3000)
    const instance = render(React.createElement(App, { conn, pollMs }))
    await instance.waitUntilExit()
  })
