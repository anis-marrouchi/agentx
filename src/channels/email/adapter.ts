import { ImapFlow } from "imapflow"
import type { EmailAccountConfig } from "@/daemon/config"
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types"
import { agentText, parseMail, replyHeaders, senderAllowed, threadAfter } from "./mail"
import { mailServers, sendMail } from "./smtp"
import { createEmailDraft, readCursor, readThread, saveCursor, saveThread, type EmailDraft } from "./store"

// --- Email channel (#1287) ---
//
// Each account's mailbox is polled over IMAP. Mail that arrived before the
// first poll is never answered: the first poll only records where the
// mailbox stands. A new mail from an allowed sender reaches the account's
// agent with the customer's address as the chat. The agent's answer goes
// back into that customer's thread over SMTP, at once with `send: "auto"`,
// or, by default, as a draft in the Approvals inbox (`email:<id>`) that only
// the owner's yes sends (approvals/inbox.ts).
//
// The adapter never changes the mailbox: no flags, no moves. Where it got
// to is kept in .agentx/email/cursors/.

export interface EmailAdapterOptions {
  accounts: Record<string, EmailAccountConfig>
  /** Folder holding .agentx/ (the config's folder). */
  root: string
  /** Display name for replies of `agent`, when the account sets none. */
  agentName?: (agent: string) => string
  /** A reply is waiting for the owner. */
  onDraft?: (draft: EmailDraft) => void
  /** Test seam: the IMAP client. */
  imapClient?: (acc: EmailAccountConfig) => ImapLike
}

/** The part of ImapFlow the adapter uses. */
export interface ImapLike {
  connect(): Promise<void>
  getMailboxLock(path: string): Promise<{ release(): void }>
  mailbox: false | { uidValidity: bigint | number; uidNext: number }
  fetch(range: string, query: { uid: true; source: true }, options: { uid: true }): AsyncIterable<{ uid: number; source?: Buffer }>
  logout(): Promise<void>
  close(): void
}

export class EmailAdapter implements ChannelAdapter {
  readonly name = "email"
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private timers: NodeJS.Timeout[] = []
  private polling = new Set<string>()
  private failures = new Map<string, string>()

  constructor(private opts: EmailAdapterOptions, private log: (msg: string) => void = () => {}) {}

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    for (const [id, acc] of Object.entries(this.opts.accounts)) {
      void this.poll(id)
      const t = setInterval(() => { void this.poll(id) }, acc.pollSeconds * 1000)
      t.unref?.()
      this.timers.push(t)
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  health(): { up: boolean; reason?: string } {
    const down = [...this.failures]
    return down.length ? { up: false, reason: down.map(([id, e]) => `${id}: ${e}`).join("; ") } : { up: true }
  }

  /** Fetch new mail of one account and hand each mail to the agent. */
  async poll(accountId: string): Promise<number> {
    const acc = this.opts.accounts[accountId]
    if (!acc || this.polling.has(accountId)) return 0
    this.polling.add(accountId)
    let handled = 0
    try {
      handled = await this.pollAccount(accountId, acc)
      this.failures.delete(accountId)
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 200)
      if (this.failures.get(accountId) !== reason) this.log(`[email] ${accountId}: ${reason}`)
      this.failures.set(accountId, reason)
    } finally {
      this.polling.delete(accountId)
    }
    return handled
  }

  private client(acc: EmailAccountConfig): ImapLike {
    if (this.opts.imapClient) return this.opts.imapClient(acc)
    const { imap } = mailServers(acc)
    return new ImapFlow({
      host: imap.host, port: imap.port, secure: imap.secure,
      auth: { user: imap.user, pass: imap.password },
      logger: false,
    }) as unknown as ImapLike
  }

  private async pollAccount(accountId: string, acc: EmailAccountConfig): Promise<number> {
    const client = this.client(acc)
    const raws: { uid: number; source: Buffer }[] = []
    let cursor = readCursor(this.opts.root, accountId)
    await client.connect()
    try {
      const lock = await client.getMailboxLock(acc.mailbox)
      try {
        const box = client.mailbox
        if (!box) throw new Error(`cannot open ${acc.mailbox}`)
        const uidValidity = String(box.uidValidity)
        if (!cursor || cursor.uidValidity !== uidValidity) {
          // First poll (or the server renumbered the mailbox): start from here.
          saveCursor(this.opts.root, accountId, { uidValidity, lastUid: box.uidNext - 1 })
          return 0
        }
        if (box.uidNext - 1 > cursor.lastUid) {
          for await (const m of client.fetch(`${cursor.lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
            // `n:*` also returns the last mail when it is older than n.
            if (m.uid > cursor.lastUid && m.source) raws.push({ uid: m.uid, source: m.source })
          }
        }
      } finally {
        lock.release()
      }
    } finally {
      await client.logout().catch(() => client.close())
    }

    let handled = 0
    for (const { uid, source } of raws.sort((a, b) => a.uid - b.uid)) {
      if (await this.handle(accountId, acc, uid, source)) handled++
      cursor = { uidValidity: cursor!.uidValidity, lastUid: uid }
      saveCursor(this.opts.root, accountId, cursor)
    }
    return handled
  }

  private async handle(accountId: string, acc: EmailAccountConfig, uid: number, source: Buffer): Promise<boolean> {
    const mail = await parseMail(source).catch(() => null)
    if (!mail) { this.log(`[email] ${accountId}: mail ${uid} has no sender, skipped`); return false }
    if (mail.from === acc.address.toLowerCase()) return false
    if (mail.automatic) { this.log(`[email] ${accountId}: automatic mail from ${mail.from} skipped`); return false }
    if (!senderAllowed(mail.from, acc.allowFrom)) {
      this.log(`[email] ${accountId}: ${mail.from} is not in allowFrom, dropped`)
      return false
    }
    saveThread(this.opts.root, threadAfter(accountId, mail, readThread(this.opts.root, mail.from)))
    if (!this.handler) return false
    await this.handler({
      id: mail.messageId ?? `${accountId}:${uid}`,
      channel: "email",
      accountId,
      sender: { id: mail.from, name: mail.fromName || mail.from, username: mail.from },
      text: agentText(mail),
      timestamp: new Date(),
      resolvedAgent: acc.agent,
      channelMeta: { channel: "email", facts: [`This is an email to ${acc.address}. Your reply is sent as an email${acc.send === "auto" ? "" : " once the owner approves it"}.`] },
    })
    return true
  }

  /** The agent's reply to a customer, into their latest thread. */
  async send(msg: OutgoingMessage): Promise<string> {
    const thread = readThread(this.opts.root, msg.chatId)
    if (!thread) throw new Error(`no email from ${msg.chatId} to reply to`)
    const acc = this.opts.accounts[thread.account]
    if (!acc) throw new Error(`email account "${thread.account}" is not set up`)
    const head = replyHeaders(thread)
    const agent = msg.agentId ?? acc.agent
    if (acc.send === "auto") {
      return sendMail(acc, acc.name || this.opts.agentName?.(agent) || agent, {
        to: thread.to, toName: thread.toName, subject: head.subject, inReplyTo: head.inReplyTo, references: head.references, text: msg.text,
      })
    }
    const draft = createEmailDraft(this.opts.root, {
      agent,
      account: thread.account,
      to: thread.to,
      to_name: thread.toName,
      subject: head.subject,
      in_reply_to: head.inReplyTo,
      references: head.references,
      text: msg.text,
    })
    this.log(`[email] reply to ${thread.to} waits for approval: email:${draft.id}`)
    this.opts.onDraft?.(draft)
    return `draft:${draft.id}`
  }
}
