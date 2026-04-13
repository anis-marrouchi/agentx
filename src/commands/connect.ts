import { Command } from "commander"
import chalk from "chalk"
import { connectTelegram } from "@/connect/telegram"
import { connectDiscord } from "@/connect/discord"
import { connectWhatsApp } from "@/connect/whatsapp"
import { invite as meshInvite, join as meshJoin } from "@/connect/mesh"

// --- agentx connect <channel> ---
//
// Unified browser-cooperating pairing flow. Replaces manual "paste token
// into .env, edit agentx.json, restart daemon" onboarding.
//
// V1 surfaces two channels: telegram (highest-pain) and mesh (only remaining
// manual .env step in Journey 8). WhatsApp / Discord / GitLab follow.

export const connect = new Command()
  .name("connect")
  .description("connect a channel or mesh peer — no manual file editing required")

connect
  .command("telegram")
  .description("pair a Telegram bot — persists token in .env, binds to an agent, auto-detects default chat")
  .option("--agent <id>", "agent to bind the bot to (skips the prompt)")
  .option("--account <name>", "account label in channels.telegram.accounts (defaults to agent id)")
  .option("--skip-chat-capture", "don't listen for the first message after pairing")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (opts) => {
    await connectTelegram({
      agent: opts.agent,
      account: opts.account,
      configPath: opts.config,
      skipChatCapture: !!opts.skipChatCapture,
    })
  })

connect
  .command("discord")
  .description("pair a Discord bot — verify token, emit install URL, save to .env")
  .option("--agent <id>", "agent to bind the bot to")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (opts) => {
    await connectDiscord({ agent: opts.agent, configPath: opts.config })
  })

connect
  .command("whatsapp")
  .description("pair WhatsApp via QR (prints in terminal), then writes channels.whatsapp config")
  .option("--agent <id>", "default agent for inbound messages")
  .option("--session-dir <path>", "session directory (default: .agentx/whatsapp-sessions)")
  .option("--skip-pair", "skip QR pairing (use when session already exists)")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (opts) => {
    await connectWhatsApp({
      agent: opts.agent,
      sessionDir: opts.sessionDir,
      skipPair: !!opts.skipPair,
      configPath: opts.config,
    })
  })

const mesh = connect
  .command("mesh")
  .description("mesh invite + join — replaces manual MESH_TOKEN copy-paste")

mesh
  .command("invite")
  .description("emit a single-use join link for another AgentX node")
  .option("--url <url>", "this node's URL as peers should reach it (Tailscale IP etc.)")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (opts) => {
    await meshInvite({ url: opts.url, configPath: opts.config })
  })

mesh
  .command("join <link>")
  .description("accept an invite link from another AgentX node")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (link: string, opts) => {
    await meshJoin(link, { configPath: opts.config })
  })

// Default help: when the user types `agentx connect` with no subcommand, nudge.
connect.action(() => {
  console.log()
  console.log(chalk.bold("  agentx connect — which channel?"))
  console.log()
  console.log(`    ${chalk.cyan("agentx connect telegram")}        — pair a Telegram bot`)
  console.log(`    ${chalk.cyan("agentx connect discord")}         — pair a Discord bot, emit install URL`)
  console.log(`    ${chalk.cyan("agentx connect whatsapp")}        — pair WhatsApp via QR`)
  console.log(`    ${chalk.cyan("agentx connect mesh invite")}     — emit a mesh join link for another node`)
  console.log(`    ${chalk.cyan("agentx connect mesh join <link>")} — accept a mesh invite`)
  console.log()
  console.log(chalk.dim("  GitLab connect is the next slice."))
  console.log()
})
