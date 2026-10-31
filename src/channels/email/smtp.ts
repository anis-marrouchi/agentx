import { emailAccountSchema, type EmailAccountConfig } from "@/daemon/config"
import type { EmailDraft, SendEmailDraft } from "./store"

// --- Sending mail and reading an account's servers (#1287) ---

export interface MailServer { host: string; port: number; secure: boolean; user: string; password: string }

/** `${VAR}` → env.VAR. The daemon's config is already expanded; the CLI's is not. */
function expand(value: string | undefined, env: NodeJS.ProcessEnv): string {
  return (value ?? "").replace(/\$\{(\w+)\}/g, (_m, name) => env[name] ?? "")
}

/** IMAP and SMTP of an account, with defaults filled in: the login is the
 *  address, and SMTP uses the IMAP login and password unless it has its own. */
export function mailServers(acc: EmailAccountConfig, env: NodeJS.ProcessEnv = process.env): { imap: MailServer; smtp: MailServer } {
  const imap: MailServer = {
    host: acc.imap.host,
    port: acc.imap.port,
    secure: acc.imap.secure,
    user: expand(acc.imap.user, env) || acc.address,
    password: expand(acc.imap.password, env),
  }
  const smtp: MailServer = {
    host: acc.smtp.host,
    port: acc.smtp.port,
    secure: acc.smtp.secure,
    user: expand(acc.smtp.user, env) || imap.user,
    password: expand(acc.smtp.password, env) || imap.password,
  }
  return { imap, smtp }
}

export interface OutgoingMail {
  to: string
  toName?: string
  subject: string
  inReplyTo?: string
  references?: string
  text: string
}

/** Send one reply through the account's SMTP server. Returns its Message-ID. */
export async function sendMail(acc: EmailAccountConfig, fromName: string, mail: OutgoingMail, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { smtp } = mailServers(acc, env)
  if (!smtp.password) throw new Error(`no SMTP password for ${acc.address}: set it in .env`)
  return smtpSend(smtp, { name: fromName, address: acc.address }, mail, { "Auto-Submitted": "auto-replied" })
}

/** One mail through one SMTP server: the send that agents' mailboxes and the
 *  system sender (src/mail/sender.ts) share. Returns its Message-ID. */
export async function smtpSend(smtp: MailServer, from: { name: string; address: string }, mail: OutgoingMail, headers: Record<string, string>): Promise<string> {
  // Loaded on first send: the dashboard and the CLI import this file for the inbox.
  const { default: nodemailer } = await import("nodemailer")
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.password },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  })
  try {
    const info = await transport.sendMail({
      from,
      to: mail.toName ? { name: mail.toName, address: mail.to } : mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
      ...(mail.references ? { references: mail.references } : {}),
      headers,
    })
    return info.messageId
  } finally {
    transport.close()
  }
}

/** The send a yes in the Approvals inbox uses: the draft's account from the
 *  raw agentx.json, secrets from `env` (the process's own over .env). */
export function draftSender(rawConfig: any, env: NodeJS.ProcessEnv): SendEmailDraft {
  return async (d: EmailDraft) => {
    const raw = rawConfig?.channels?.email?.accounts?.[d.account]
    if (!raw) return { ok: false, error: `no email account "${d.account}" in agentx.json` }
    const parsed = emailAccountSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: `email account "${d.account}": ${parsed.error.issues[0]?.message}` }
    const acc = parsed.data
    const fromName = acc.name || rawConfig?.agents?.[d.agent]?.name || d.agent
    await sendMail(acc, fromName, {
      to: d.to, toName: d.to_name, subject: d.subject, inReplyTo: d.in_reply_to, references: d.references, text: d.text,
    }, env)
    return { ok: true }
  }
}
