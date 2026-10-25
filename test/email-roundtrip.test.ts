import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import nodemailer from "nodemailer"
import { ImapFlow } from "imapflow"
import PostalMime from "postal-mime"
import { emailAccountSchema } from "../src/daemon/config"
import { EmailAdapter } from "../src/channels/email/adapter"
import { draftSender } from "../src/channels/email/smtp"
import { decideEmailDraft, listEmailDrafts } from "../src/channels/email/store"
import type { IncomingMessage } from "../src/channels/types"

// An email round trip against a real IMAP/SMTP server (#1287): GreenMail,
// started by CI as a service, or locally with
//   java -Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap \
//     -Dgreenmail.users=support:secret@example.com,sam:secret@client.test -jar greenmail-standalone.jar
// then EMAIL_TEST_HOST=127.0.0.1 npx vitest run test/email-roundtrip.test.ts
// SMTP on 3025 and IMAP on 3143, plain. Skipped when EMAIL_TEST_HOST is unset.

const HOST = process.env.EMAIL_TEST_HOST
const SMTP_PORT = Number(process.env.EMAIL_TEST_SMTP_PORT || 3025)
const IMAP_PORT = Number(process.env.EMAIL_TEST_IMAP_PORT || 3143)

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-email-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function account(send: "approve" | "auto", allowFrom = ["*"]) {
  return emailAccountSchema.parse({
    agent: "support",
    address: "support@example.com",
    name: "Support",
    imap: { host: HOST, port: IMAP_PORT, secure: false, user: "support", password: "secret" },
    smtp: { host: HOST, port: SMTP_PORT, secure: false },
    allowFrom,
    send,
  })
}

/** The customer writes from their own mail app. Returns the Message-ID. */
async function customerWrites(subject: string, text: string, headers: Record<string, string> = {}): Promise<string> {
  const t = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false, auth: { user: "sam", pass: "secret" } })
  const info = await t.sendMail({ from: "Sam <sam@client.test>", to: "support@example.com", subject, text, headers })
  t.close()
  return info.messageId
}

/** What landed in the customer's inbox. */
async function customerInbox(): Promise<Array<{ from?: string; subject?: string; inReplyTo?: string; references?: string; text?: string }>> {
  const c = new ImapFlow({ host: HOST!, port: IMAP_PORT, secure: false, auth: { user: "sam", pass: "secret" }, logger: false })
  await c.connect()
  const out: any[] = []
  const lock = await c.getMailboxLock("INBOX")
  try {
    if ((c.mailbox as any).exists > 0) {
      for await (const m of c.fetch("1:*", { source: true })) {
        const p = await PostalMime.parse(m.source!)
        out.push({ from: (p.from as any)?.address, subject: p.subject, inReplyTo: p.inReplyTo, references: p.references, text: p.text })
      }
    }
  } finally { lock.release() }
  await c.logout()
  return out
}

describe.skipIf(!HOST)("email round trip on a real IMAP/SMTP server", () => {
  it("a customer's mail reaches the agent; the reply waits for approval, then lands in the same thread", async () => {
    const support = account("approve")
    const got: IncomingMessage[] = []
    const adapter = new EmailAdapter({ accounts: { support }, root })
    adapter.onMessage(async (m) => { got.push(m) })

    // The first poll only marks where the mailbox stands.
    expect(await adapter.poll("support")).toBe(0)
    const before = (await customerInbox()).length

    const asked = await customerWrites("Opening hours?", "Hello, when do you open on Saturday?\n\nSam")
    expect(await adapter.poll("support")).toBe(1)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ channel: "email", accountId: "support", resolvedAgent: "support", sender: { id: "sam@client.test", name: "Sam" } })
    expect(got[0].text).toContain("Subject: Opening hours?")
    expect(got[0].text).toContain("when do you open on Saturday?")
    // Nothing new: nothing handed over twice.
    expect(await adapter.poll("support")).toBe(0)

    // The agent answers: held, nothing sent yet.
    const id = await adapter.send({ channel: "email", chatId: "sam@client.test", text: "We open at 9 on Saturdays.", agentId: "support" })
    expect(id).toMatch(/^draft:/)
    expect((await customerInbox()).length).toBe(before)
    const [draft] = listEmailDrafts(root, "pending")
    expect(draft).toMatchObject({ to: "sam@client.test", subject: "Re: Opening hours?", in_reply_to: asked })

    // The owner's yes sends it, as edited.
    const raw = { agents: { support: { name: "Support" } }, channels: { email: { accounts: { support } } } }
    const r = await decideEmailDraft(root, draft.id, "yes", { text: "We open at 9:00 on Saturdays.", send: draftSender(raw, process.env) })
    expect(r.ok).toBe(true)

    const inbox = await customerInbox()
    expect(inbox.length).toBe(before + 1)
    const reply = inbox[inbox.length - 1]
    expect(reply).toMatchObject({ from: "support@example.com", subject: "Re: Opening hours?", inReplyTo: asked })
    expect(reply.references).toContain(asked)
    expect(reply.text).toContain("We open at 9:00 on Saturdays.")
  })

  it("auto-send replies at once; auto-replies and senders not allowed never reach the agent", async () => {
    const support = account("auto", ["@client.test"])
    const got: IncomingMessage[] = []
    const adapter = new EmailAdapter({ accounts: { support }, root })
    adapter.onMessage(async (m) => { got.push(m) })
    await adapter.poll("support")
    const before = (await customerInbox()).length

    await customerWrites("Out of office", "I am away.", { "Auto-Submitted": "auto-replied" })
    const asked = await customerWrites("Invoice", "Can you resend the invoice?")
    expect(await adapter.poll("support")).toBe(1)
    expect(got.map((m) => m.text)).toEqual([expect.stringContaining("Subject: Invoice")])

    await adapter.send({ channel: "email", chatId: "sam@client.test", text: "Sent again.", agentId: "support" })
    expect(listEmailDrafts(root)).toEqual([])
    const inbox = await customerInbox()
    expect(inbox.length).toBe(before + 1)
    expect(inbox[inbox.length - 1]).toMatchObject({ subject: "Re: Invoice", inReplyTo: asked })
  })
})
