import chalk from "chalk"
import prompts from "prompts"
import { spawn } from "child_process"
import { applyConfigMutation, setAtPath } from "@/daemon/config-mutator"
import { setDotEnv } from "@/utils/dotenv-mutator"

// --- agentx connect discord ---
//
// Discord's flow is 2-step: create an application (with bot token) in the
// Developer Portal, then install it to a server via an OAuth URL. We can't
// automate step 1 (Discord has no API to create apps), but we can verify
// the bot token, save it to .env, and compose the install URL for the user.

const DEV_PORTAL = "https://discord.com/developers/applications"

// Default bot permissions: View Channels + Send Messages + Read Message History + Use Slash Commands
// Integer is a bitfield. 274877991936 = send + view + read history + manage webhooks. Plain chatty bots use 67584.
const DEFAULT_PERMISSIONS = "67584"

async function fetchMe(token: string): Promise<{ id: string; username: string; discriminator?: string } | null> {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return (await res.json()) as any
  } catch { return null }
}

export interface ConnectDiscordOpts {
  agent?: string
  configPath?: string
}

function openInBrowser(url: string): void {
  try {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref()
  } catch { /* non-fatal */ }
}

export async function connectDiscord(opts: ConnectDiscordOpts = {}): Promise<void> {
  console.log()
  console.log(chalk.bold("  Connect Discord"))
  console.log()
  console.log(chalk.dim("  1. Open the Discord Developer Portal"))
  console.log(chalk.dim(`     ${DEV_PORTAL}`))
  console.log(chalk.dim("  2. New Application → Bot → Reset Token → copy the token"))
  console.log(chalk.dim("  3. Under Bot → Privileged Gateway Intents,"))
  console.log(chalk.dim("     enable 'MESSAGE CONTENT INTENT'"))
  console.log()

  const { openBrowser } = await prompts({
    type: "confirm",
    name: "openBrowser",
    message: "Open the Developer Portal in your browser?",
    initial: true,
  })
  if (openBrowser) openInBrowser(DEV_PORTAL)

  const { token } = await prompts({
    type: "password",
    name: "token",
    message: "Paste the bot token:",
    validate: (t: string) => t.trim().length > 20 || "that looks too short for a Discord token",
  })
  if (!token) { console.log(chalk.red("  Aborted")); process.exit(1) }

  process.stdout.write("  Verifying token... ")
  const me = await fetchMe(token.trim())
  if (!me) {
    console.log(chalk.red("✗ invalid or revoked — did you enable MESSAGE CONTENT INTENT and copy the right token?"))
    process.exit(1)
  }
  const displayName = me.discriminator && me.discriminator !== "0" ? `${me.username}#${me.discriminator}` : me.username
  console.log(chalk.green(`✓ ${displayName} (bot id ${me.id})`))

  // --- Agent binding ---
  const { readFileSync, existsSync } = await import("fs")
  const { resolve } = await import("path")
  const cfgPath = opts.configPath || resolve(process.cwd(), "agentx.json")
  if (!existsSync(cfgPath)) {
    console.log(chalk.red(`  No agentx.json at ${cfgPath}. Run: agentx init`))
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(cfgPath, "utf-8"))
  const agents = Object.keys(raw.agents || {})
  if (agents.length === 0) {
    console.log(chalk.red("  No agents configured. Run: agentx agent add"))
    process.exit(1)
  }

  let agent = opts.agent
  if (!agent) {
    const r = await prompts({
      type: "select",
      name: "agent",
      message: "Bind this bot to which agent?",
      choices: agents.map((id) => ({ title: id, value: id })),
      initial: 0,
    })
    agent = r.agent
  }
  if (!agent) { console.log(chalk.red("  Aborted")); process.exit(1) }

  // --- Persist token + config ---
  const envVar = "DISCORD_BOT_TOKEN"
  setDotEnv(envVar, token.trim())
  process.env[envVar] = token.trim()

  const result = await applyConfigMutation((cfg) => {
    setAtPath(cfg, "channels.discord.enabled", true)
    setAtPath(cfg, "channels.discord.token", `\${${envVar}}`)
    setAtPath(cfg, "channels.discord.agentBinding", agent)
  }, { configPath: opts.configPath })

  if (!result.success) {
    console.log(chalk.red(`  ✗ ${result.error}`))
    process.exit(1)
  }

  console.log()
  console.log(chalk.green(`  ✓ Discord bot ${displayName} bound to agent "${agent}"`))
  console.log(chalk.dim(`    Token stored in .env as ${envVar}`))
  if (result.reloaded) console.log(chalk.dim("    Daemon hot-reloaded."))
  else console.log(chalk.dim("    Restart the daemon to start Discord polling."))

  // --- Install URL (bot id = application id for a bot user) ---
  console.log()
  console.log(chalk.bold("  Install the bot to a server"))
  console.log()
  const installUrl = `https://discord.com/oauth2/authorize?client_id=${me.id}&scope=bot&permissions=${DEFAULT_PERMISSIONS}`
  console.log(`  ${chalk.cyan(installUrl)}`)
  console.log()
  const { openInstall } = await prompts({
    type: "confirm",
    name: "openInstall",
    message: "Open the install URL in your browser now?",
    initial: true,
  })
  if (openInstall) openInBrowser(installUrl)

  console.log()
  console.log(chalk.dim("  After you pick a server, the bot will come online on the next daemon restart."))
  console.log(chalk.dim("  Mention the bot in any channel to route messages to the agent."))
}
