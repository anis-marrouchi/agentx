import type { MailSenderConfig } from "@/daemon/config"
import { smtpSend, type OutgoingMail } from "@/channels/email/smtp"

// --- The system mail sender (#1478) ---
//
// Mail AgentX sends itself, such as sign-in links, goes through
// `mail.sender` in agentx.json. It is not an agent's mailbox, and nothing in
// it is written for one provider: any provider that takes SMTP works.
// `user` and `password` come from .env (literalSecretProblems in config.ts),
// so the config passed here is already expanded.

/** What may be shown of the sender: never the login or the password. */
export function senderSummary(s: MailSenderConfig): string {
  return `${s.name} <${s.from}> via ${s.host}:${s.port}`
}

/** Send one mail through the sender. Returns its Message-ID. */
export async function sendSystemMail(s: MailSenderConfig, mail: OutgoingMail): Promise<string> {
  return smtpSend(
    { host: s.host, port: s.port, secure: s.secure, user: s.user, password: s.password },
    { name: s.name, address: s.from },
    mail,
    { "Auto-Submitted": "auto-generated" },
  )
}

/** The mail `agentx mail test` sends. */
export function testMail(to: string, s: MailSenderConfig): OutgoingMail {
  return {
    to,
    subject: `${s.name}: test mail`,
    text: [
      `This is a test mail from ${s.name}.`,
      "",
      "If it reached you, AgentX can send mail through this sender.",
      "You can ignore it.",
    ].join("\n"),
  }
}
