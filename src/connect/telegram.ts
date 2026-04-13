import chalk from "chalk"
import prompts from "prompts"
import { applyConfigMutation, setAtPath, getAtPath } from "@/daemon/config-mutator"
import { setDotEnv } from "@/utils/dotenv-mutator"

// --- agentx connect telegram ---
//
// Replaces the channel-add path for Telegram. The improvements over the old
// prompt-for-everything flow:
//   1. Token is persisted to .env under TG_<ACCOUNT>_BOT_TOKEN, never inline
//      in agentx.json. The config holds only `${TG_<ACCOUNT>_BOT_TOKEN}`.
//   2. After pairing, the CLI polls getUpdates until the user sends a message
//      from the chat they want to be "me". The first inbound message's chatId
//      is captured and written to notifications.destination so `--notify me`
//      just works.
//   3. A quick getMe verifies the token before anything is written. Invalid
//      tokens never reach the config.

const BOTFATHER_URL = "https://t.me/BotFather"

async function getMe(token: string): Promise<{ username: string; first_name: string; id: number } | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const j: any = await res.json()
    return j?.ok ? j.result : null
  } catch { return null }
}

async function pollFirstMessage(token: string, timeoutMs: number): Promise<{ chatId: number; chatTitle?: string; from: string } | null> {
  const deadline = Date.now() + timeoutMs
  let offset = 0
  // Learn the current offset so we only catch fresh messages.
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`, { signal: AbortSignal.timeout(5000) })
    const j: any = await r.json()
    if (j?.result?.length) offset = j.result[0].update_id + 1
  } catch { /* start from 0 */ }

  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=10`,
        { signal: AbortSignal.timeout(15000) },
      )
      const j: any = await res.json()
      for (const u of j?.result || []) {
        offset = Math.max(offset, u.update_id + 1)
        const msg = u.message || u.edited_message || u.channel_post
        if (msg?.chat?.id) {
          return {
            chatId: msg.chat.id,
            chatTitle: msg.chat.title || msg.chat.username || msg.chat.first_name,
            from: msg.from?.first_name || msg.from?.username || "unknown",
          }
        }
      }
    } catch { /* transient; retry */ }
  }
  return null
}

export interface ConnectTelegramOpts {
  agent?: string
  account?: string
  configPath?: string
  skipChatCapture?: boolean
}

export async function connectTelegram(opts: ConnectTelegramOpts = {}): Promise<void> {
  console.log()
  console.log(chalk.bold("  Connect Telegram"))
  console.log()
  console.log(chalk.dim(`  1. Open ${BOTFATHER_URL}`))
  console.log(chalk.dim(`     /newbot   (or /mybots → pick existing → API Token)`))
  console.log(chalk.dim(`  2. Copy the HTTP API token — looks like 123456789:ABCdef...`))
  console.log()

  const { openBrowser } = await prompts({
    type: "confirm",
    name: "openBrowser",
    message: "Open BotFather in your browser?",
    initial: true,
  })
  if (openBrowser) {
    try {
      const { spawn } = await import("child_process")
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
      spawn(opener, [BOTFATHER_URL], { stdio: "ignore", detached: true }).unref()
    } catch { /* non-fatal */ }
  }

  const { token } = await prompts({
    type: "password",
    name: "token",
    message: "Paste the bot token from BotFather:",
    validate: (t: string) => /^\d+:[A-Za-z0-9_-]{20,}$/.test(t.trim()) || "That doesn't look like a Telegram token",
  })
  if (!token) { console.log(chalk.red("  Aborted")); process.exit(1) }

  // --- Verify token ---
  process.stdout.write("  Verifying token... ")
  const me = await getMe(token.trim())
  if (!me) {
    console.log(chalk.red("✗ invalid or revoked"))
    process.exit(1)
  }
  console.log(chalk.green(`✓ ${me.first_name} (@${me.username})`))

  // --- Existing config ---
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
    console.log(chalk.red(`  No agents configured. Run: agentx agent add`))
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

  // Account name — default to the agent id (one bot per agent is the common case).
  // If that collides with an existing account, prompt.
  const accounts = raw.channels?.telegram?.accounts || {}
  let account = opts.account || agent
  if (accounts[account] && accounts[account].agentBinding !== agent) {
    const r = await prompts({
      type: "text",
      name: "account",
      message: `Account "${account}" is already in use. Pick a different label:`,
      initial: `${agent}-2`,
      validate: (s: string) => /^[a-z0-9-]+$/i.test(s) || "lowercase letters, digits, hyphens only",
    })
    account = r.account
  }
  if (!account) { console.log(chalk.red("  Aborted")); process.exit(1) }

  // --- Persist token to .env, reference it from config ---
  const envVar = `TG_${account.toUpperCase().replace(/-/g, "_")}_BOT_TOKEN`
  setDotEnv(envVar, token.trim())
  process.env[envVar] = token.trim() // so validation downstream sees it

  const result = await applyConfigMutation((cfg) => {
    setAtPath(cfg, "channels.telegram.enabled", true)
    setAtPath(cfg, `channels.telegram.accounts.${account}`, {
      token: `\${${envVar}}`,
      agentBinding: agent,
    })
    // Nudge agent.mentions to include the bot handle, if not already there.
    const mentions: string[] = getAtPath(cfg, `agents.${agent}.mentions`) as any || []
    const handle = `@${me.username}`
    if (!mentions.includes(handle)) {
      mentions.push(handle)
      setAtPath(cfg, `agents.${agent}.mentions`, mentions)
    }
  }, { configPath: opts.configPath })

  if (!result.success) {
    console.log(chalk.red(`  ✗ ${result.error}`))
    process.exit(1)
  }

  console.log()
  console.log(chalk.green(`  ✓ Bot @${me.username} bound to agent "${agent}"`))
  console.log(chalk.dim(`    Token stored in .env as ${envVar}`))
  console.log(chalk.dim(`    Mentions updated to include @${me.username}`))
  if (result.reloaded) console.log(chalk.dim("    Daemon hot-reloaded."))
  else console.log(chalk.dim("    Start the daemon to begin polling (agentx daemon start)"))

  // --- Auto-detect chatId for notifications.destination ---
  if (opts.skipChatCapture) return

  console.log()
  const { capture } = await prompts({
    type: "confirm",
    name: "capture",
    message: `Listen for a message so we can set this as your default --notify target?`,
    initial: true,
  })
  if (!capture) return

  console.log()
  console.log(chalk.dim(`  Send any message to @${me.username} from the chat you want to use.`))
  console.log(chalk.dim(`  Waiting up to 90s...`))
  const first = await pollFirstMessage(token.trim(), 90_000)
  if (!first) {
    console.log(chalk.yellow(`  No message received — skipping. You can set it later with:`))
    console.log(chalk.dim(`    agentx config set notifications.destination.channel telegram`))
    console.log(chalk.dim(`    agentx config set notifications.destination.chatId <chatId>`))
    console.log(chalk.dim(`    agentx config set notifications.destination.accountId ${account}`))
    return
  }

  const destResult = await applyConfigMutation((cfg) => {
    setAtPath(cfg, "notifications.destination", {
      channel: "telegram",
      chatId: String(first.chatId),
      accountId: account,
    })
  }, { configPath: opts.configPath })

  if (!destResult.success) {
    console.log(chalk.red(`  ✗ failed to save destination: ${destResult.error}`))
    return
  }

  console.log(chalk.green(`  ✓ Default --notify target set`))
  console.log(chalk.dim(`    Chat: ${first.chatTitle || first.chatId} (from ${first.from})`))
  console.log(chalk.dim(`    From now on, --notify me resolves to this chat.`))
  if (destResult.reloaded) console.log(chalk.dim("    Daemon hot-reloaded."))
}
