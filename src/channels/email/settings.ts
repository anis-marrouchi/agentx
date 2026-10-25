// --- An email account's settings block, shared by `agentx connect email`
// and Settings › Channels › Email (#1287). No mail libraries here: the
// dashboard imports it. ---

export const GMAIL_APP_PASSWORDS_URL = "https://myaccount.google.com/apppasswords"

export interface Preset { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }

/** Servers of a known provider, by the address's domain. Only Gmail: other
 *  hosts are asked for, since many no longer take a password over IMAP. */
export function presetFor(address: string): Preset | undefined {
  const domain = address.split("@")[1]?.toLowerCase() ?? ""
  if (domain === "gmail.com" || domain === "googlemail.com") return { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 }
  return undefined
}

export interface EmailAccountInput {
  agent: string
  address: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  user?: string
  passwordEnv: string
  allowFrom: string[]
  send: "approve" | "auto"
}

/** The channels.email.accounts.<id> block. Port 993/465 use TLS from the
 *  start; any other port (143, 587, local test servers) upgrades with STARTTLS
 *  when the server offers it. */
export function emailAccountBlock(i: EmailAccountInput): Record<string, unknown> {
  const login = i.user && i.user !== i.address ? { user: i.user } : {}
  return {
    agent: i.agent,
    address: i.address,
    imap: { host: i.imapHost, port: i.imapPort, secure: i.imapPort === 993, ...login, password: `\${${i.passwordEnv}}` },
    smtp: { host: i.smtpHost, port: i.smtpPort, secure: i.smtpPort === 465 },
    allowFrom: i.allowFrom,
    send: i.send,
  }
}

export function passwordEnvFor(account: string): string {
  return `EMAIL_${account.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PASSWORD`
}
