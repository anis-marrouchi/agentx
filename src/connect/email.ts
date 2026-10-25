import chalk from "chalk"
import prompts from "prompts"
import nodemailer from "nodemailer"
import { ImapFlow } from "imapflow"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import { applyConfigMutation, setAtPath } from "@/daemon/config-mutator"
import { setDotEnv } from "@/utils/dotenv-mutator"
import { emailAccountBlock, GMAIL_APP_PASSWORDS_URL, passwordEnvFor, presetFor, type EmailAccountInput } from "@/channels/email/settings"

// --- agentx connect email (#1287) ---
//
// Binds a mailbox to an agent. The password goes to .env as
// EMAIL_<ACCOUNT>_PASSWORD and agentx.json only references it. The IMAP
// and SMTP logins are tried before anything is written. Gmail needs an app
// password (with 2-step verification on), not the account password.

/** Log in to IMAP and SMTP once. Returns what failed, or null. */
export async function checkLogin(i: EmailAccountInput, password: string): Promise<string | null> {
  const user = i.user || i.address
  const imap = new ImapFlow({ host: i.imapHost, port: i.imapPort, secure: i.imapPort === 993, auth: { user, pass: password }, logger: false })
  try {
    await imap.connect()
    await imap.logout()
  } catch (e: any) {
    imap.close()
    return `IMAP ${i.imapHost}:${i.imapPort}: ${e?.responseText || e?.message || e}`
  }
  const smtp = nodemailer.createTransport({ host: i.smtpHost, port: i.smtpPort, secure: i.smtpPort === 465, auth: { user, pass: password }, connectionTimeout: 15_000 })
  try {
    await smtp.verify()
  } catch (e: any) {
    return `SMTP ${i.smtpHost}:${i.smtpPort}: ${e?.response || e?.message || e}`
  } finally {
    smtp.close()
  }
  return null
}

export interface ConnectEmailOpts {
  agent?: string
  account?: string
  address?: string
  imapHost?: string
  imapPort?: string
  smtpHost?: string
  smtpPort?: string
  user?: string
  /** Read the password from this environment variable instead of asking. */
  passwordEnv?: string
  allowFrom?: string[]
  auto?: boolean
  skipCheck?: boolean
  configPath?: string
}

function fail(message: string): never {
  console.log(chalk.red(`  ${message}`))
  process.exit(1)
}

async function ask<T>(q: prompts.PromptObject): Promise<T> {
  const r = await prompts(q, { onCancel: () => fail("Aborted") })
  return r[q.name as string] as T
}

export async function connectEmail(opts: ConnectEmailOpts = {}): Promise<void> {
  console.log()
  console.log(chalk.bold("  Connect email"))
  console.log()

  const cfgPath = opts.configPath || resolve(process.cwd(), "agentx.json")
  if (!existsSync(cfgPath)) fail(`No agentx.json at ${cfgPath}. Run: agentx init`)
  const raw = JSON.parse(readFileSync(cfgPath, "utf-8"))
  const agents = Object.keys(raw.agents || {})
  if (agents.length === 0) fail("No agents configured. Run: agentx agent add")

  const agent = opts.agent ?? await ask<string>({ type: "select", name: "agent", message: "Which agent answers this mailbox?", choices: agents.map((id) => ({ title: id, value: id })) })
  if (!raw.agents?.[agent]) fail(`No agent "${agent}" in ${cfgPath}`)
  const address = (opts.address ?? await ask<string>({ type: "text", name: "address", message: "Email address customers write to:", validate: (s: string) => /^\S+@\S+\.\S+$/.test(s.trim()) || "an email address" })).trim().toLowerCase()
  const account = opts.account || agent
  const preset = presetFor(address)

  const imapHost = opts.imapHost ?? preset?.imapHost ?? await ask<string>({ type: "text", name: "imapHost", message: "IMAP server (incoming mail):" })
  const imapPort = Number(opts.imapPort ?? preset?.imapPort ?? await ask<string>({ type: "text", name: "imapPort", message: "IMAP port:", initial: "993" }))
  const smtpHost = opts.smtpHost ?? preset?.smtpHost ?? await ask<string>({ type: "text", name: "smtpHost", message: "SMTP server (outgoing mail):" })
  const smtpPort = Number(opts.smtpPort ?? preset?.smtpPort ?? await ask<string>({ type: "text", name: "smtpPort", message: "SMTP port:", initial: "465" }))
  if (!Number.isInteger(imapPort) || !Number.isInteger(smtpPort)) fail("Ports must be numbers.")

  const passwordEnv = opts.passwordEnv || passwordEnvFor(account)
  let password = opts.passwordEnv ? process.env[opts.passwordEnv] : undefined
  if (opts.passwordEnv && !password) fail(`${opts.passwordEnv} is not set in the environment.`)
  if (!password) {
    if (preset?.imapHost === "imap.gmail.com") {
      console.log(chalk.dim(`  Gmail needs an app password, not your account password: ${GMAIL_APP_PASSWORDS_URL}`))
      console.log(chalk.dim("  (2-step verification must be on for that page to show.)"))
    }
    password = (await ask<string>({ type: "password", name: "password", message: "Password (an app password for Gmail):" }))?.trim()
  }
  if (!password) fail("Aborted")

  const input: EmailAccountInput = {
    agent, address, imapHost, imapPort, smtpHost, smtpPort,
    user: opts.user,
    passwordEnv,
    allowFrom: opts.allowFrom?.length ? opts.allowFrom : ["*"],
    send: opts.auto ? "auto" : "approve",
  }

  if (!opts.skipCheck) {
    process.stdout.write("  Logging in to IMAP and SMTP... ")
    const problem = await checkLogin(input, password)
    if (problem) {
      console.log(chalk.red("✗"))
      fail(problem)
    }
    console.log(chalk.green("✓"))
  }

  if (!opts.passwordEnv) {
    setDotEnv(passwordEnv, password)
    process.env[passwordEnv] = password
  }
  const result = await applyConfigMutation((cfg) => {
    setAtPath(cfg, "channels.email.enabled", true)
    setAtPath(cfg, `channels.email.accounts.${account}`, emailAccountBlock(input))
  }, { configPath: opts.configPath })
  if (!result.success) fail(`Config save failed: ${result.error}`)

  console.log()
  console.log(chalk.green(`  ✓ ${address} is answered by "${agent}"`))
  if (!opts.passwordEnv) console.log(chalk.dim(`    Password stored in .env as ${passwordEnv}`))
  console.log(chalk.dim(`    Who may write: ${input.allowFrom.join(", ")}${input.allowFrom.includes("*") ? " (anyone)" : ""}`))
  console.log(input.send === "auto"
    ? chalk.yellow("    Replies are sent as soon as the agent writes them.")
    : chalk.dim("    Each reply waits in Approvals until you send it: agentx approvals list"))
  console.log(chalk.dim("    Only mail that arrives from now on is answered."))
  console.log(chalk.dim("    Restart the daemon to start reading the mailbox: agentx daemon restart"))
  console.log()
}
