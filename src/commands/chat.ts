import { Command } from "commander"
import chalk from "chalk"
import { randomUUID } from "crypto"
import { createInterface } from "node:readline/promises"
import ora from "ora"
import { resolveConn, sendTask, fetchAgents, type AgentRow } from "@/tui/client"

// `agentx chat @agent` — daemon-mediated REPL.
//
// Multi-turn conversation with a daemon-registered agent over POST /task.
// We synthesize a stable (channel, chatId) per session so the daemon's
// process registry keeps the agent's claude process warm across turns —
// no cold spawn per message, no provider config duplicated in the CLI.
//
// Special commands at the prompt:
//   /exit, /quit            leave the REPL
//   /clear                  start a fresh chatId (drops warm process)
//   /agent <id>             switch the target agent for the next turn
//   /who                    print current target + chatId
//   /agents                 list registered agents

export const chat = new Command()
  .name("chat")
  .description("interactive chat with a daemon-registered agent (multi-turn /task)")
  .argument("[agent]", "agent id to talk to (with or without leading @)")
  .option("-c, --config <path>", "daemon config file")
  .option("--node <url>", "daemon URL (defaults to dashboard.daemonUrl from config)")
  .option("--token <token>", "bearer token (defaults to dashboard.token from config)")
  .option("--channel <name>", "logical channel name passed in context", "chat-cli")
  .option("--chat-id <id>", "resume an existing chatId (otherwise a fresh one is generated)")
  .action(async (agentArg: string | undefined, opts) => {
    const conn = resolveConn({ node: opts.node, token: opts.token, config: opts.config })
    let agentId = (agentArg ?? "").replace(/^@/, "").trim()
    const channel: string = opts.channel
    let chatId: string = opts.chatId || `chat-cli:${randomUUID().slice(0, 12)}`

    // Confirm the daemon is reachable and the requested agent exists. We
    // pull the registry up front to give a useful error before the first
    // turn — and to default to the first available agent if none was given.
    let agents: AgentRow[] = []
    try {
      agents = await fetchAgents(conn)
    } catch (e: any) {
      console.error(chalk.red(`  cannot reach daemon at ${conn.baseUrl}: ${e?.message || e}`))
      console.error(chalk.dim(`  is the daemon running? try: agentx daemon status`))
      process.exit(1)
    }
    if (agents.length === 0) {
      console.error(chalk.red("  no agents registered with the daemon"))
      process.exit(1)
    }
    if (!agentId) {
      agentId = agents[0].id
      console.log(chalk.dim(`  no agent given — defaulting to @${agentId}`))
    } else if (!agents.find((a) => a.id === agentId)) {
      console.error(chalk.red(`  unknown agent: @${agentId}`))
      console.error(chalk.dim(`  registered: ${agents.map((a) => `@${a.id}`).join(", ")}`))
      process.exit(1)
    }

    printBanner(conn.baseUrl, agentId, chatId, channel)

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on("close", () => { console.log(chalk.dim("\n  bye")); process.exit(0) })

    while (true) {
      let line: string
      try {
        line = (await rl.question(chalk.cyan(`you › `))).trim()
      } catch {
        // SIGINT during input — readline rejects.
        rl.close()
        return
      }
      if (!line) continue

      if (line === "/exit" || line === "/quit") { rl.close(); return }
      if (line === "/who") {
        console.log(chalk.dim(`  @${agentId}  chatId=${chatId}  channel=${channel}`))
        continue
      }
      if (line === "/clear") {
        chatId = `chat-cli:${randomUUID().slice(0, 12)}`
        console.log(chalk.dim(`  fresh chatId=${chatId} (warm process dropped)`))
        continue
      }
      if (line === "/agents") {
        try {
          const fresh = await fetchAgents(conn)
          for (const a of fresh) {
            const marker = a.id === agentId ? chalk.green("●") : chalk.dim("○")
            console.log(`  ${marker} @${a.id}  ${chalk.dim(a.tier)}  ${a.model ?? ""}`)
          }
        } catch (e: any) {
          console.error(chalk.red(`  failed to list agents: ${e?.message || e}`))
        }
        continue
      }
      if (line.startsWith("/agent ")) {
        const next = line.slice("/agent ".length).replace(/^@/, "").trim()
        if (!next) { console.log(chalk.red("  usage: /agent <id>")); continue }
        // Re-fetch to validate against the live registry.
        try {
          const fresh = await fetchAgents(conn)
          if (!fresh.find((a) => a.id === next)) {
            console.log(chalk.red(`  unknown agent: @${next}`))
            continue
          }
          agentId = next
          console.log(chalk.dim(`  now talking to @${agentId}`))
        } catch (e: any) {
          console.error(chalk.red(`  failed to switch agent: ${e?.message || e}`))
        }
        continue
      }
      if (line.startsWith("/")) {
        console.log(chalk.red(`  unknown command: ${line.split(/\s+/)[0]}`))
        console.log(chalk.dim(`  available: /exit /quit /clear /agent <id> /who /agents`))
        continue
      }

      const spinner = ora({ text: `@${agentId} thinking…`, color: "cyan" }).start()
      const startedAt = Date.now()
      try {
        const r = await sendTask(conn, agentId, line, { channel, chatId })
        const elapsed = Math.round((Date.now() - startedAt) / 100) / 10
        spinner.stop()
        if (r?.error) {
          console.log(chalk.red(`@${agentId} ✗ ${r.error}`))
        } else {
          const reply = (r?.content ?? "").toString().trim() || "(empty reply)"
          console.log(`${chalk.green(`@${agentId}`)} ${chalk.dim(`· ${elapsed}s`)}`)
          for (const ln of reply.split("\n")) console.log(`  ${ln}`)
        }
      } catch (e: any) {
        spinner.stop()
        console.log(chalk.red(`@${agentId} ✗ ${e?.message || e}`))
      }
    }
  })

function printBanner(baseUrl: string, agentId: string, chatId: string, channel: string) {
  console.log()
  console.log(chalk.bold(`  agentx chat`))
  console.log(chalk.dim(`  daemon: ${baseUrl}  ·  channel: ${channel}  ·  chatId: ${chatId}`))
  console.log(chalk.dim(`  agent: @${agentId}  ·  /exit to quit  ·  /agent <id> to switch`))
  console.log()
}
