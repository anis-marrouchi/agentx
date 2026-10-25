import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { agentText, parseMail, replyHeaders, senderAllowed, stripQuoted, threadAfter } from "../src/channels/email/mail"
import { createEmailDraft, decideEmailDraft, emailDir, listEmailDrafts, readEmailDraft } from "../src/channels/email/store"
import { mailServers } from "../src/channels/email/smtp"
import { emailAccountSchema } from "../src/daemon/config"

// Email channel (#1287): parsing, threading, who may write, and the drafts
// the owner approves. The round trip on a real server is in
// email-roundtrip.test.ts.

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-email-unit-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const mail = (headers: string, body: string) => `${headers.trim()}\r\n\r\n${body}`

describe("reading a customer's mail", () => {
  it("keeps the sender, the subject, the thread and only the new text", async () => {
    const m = await parseMail(mail(`
From: "Sam Lee" <Sam@Client.test>
To: support@example.com
Subject: Re: Opening hours
Message-ID: <m2@client.test>
In-Reply-To: <r1@example.com>
References: <m1@client.test> <r1@example.com>
Content-Type: text/plain; charset=utf-8`, "And on Sunday?\n\nOn Sat, 24 Oct 2026 at 10:00, Support <support@example.com> wrote:\n> We open at 9."))
    expect(m).toMatchObject({
      from: "sam@client.test",
      fromName: "Sam Lee",
      subject: "Re: Opening hours",
      messageId: "<m2@client.test>",
      references: ["<m1@client.test>", "<r1@example.com>"],
      text: "And on Sunday?",
      automatic: false,
    })
    expect(agentText(m!)).toBe("Email from Sam Lee <sam@client.test>\nSubject: Re: Opening hours\n\nAnd on Sunday?")
  })

  it("marks auto-replies, bounces and list mail so they are never answered", async () => {
    const base = "From: a@b.test\nSubject: x\nMessage-ID: <x@b.test>"
    expect((await parseMail(mail(`${base}\nAuto-Submitted: auto-replied`, "away")))!.automatic).toBe(true)
    expect((await parseMail(mail(`${base}\nPrecedence: bulk`, "news")))!.automatic).toBe(true)
    expect((await parseMail(mail(`${base}\nList-Id: <news.b.test>`, "news")))!.automatic).toBe(true)
    expect((await parseMail(mail("From: MAILER-DAEMON@b.test\nSubject: failed", "bounce")))!.automatic).toBe(true)
    expect((await parseMail(mail(`${base}\nAuto-Submitted: no`, "hi")))!.automatic).toBe(false)
  })

  it("reads HTML-only mail as text, and gives up on mail with no sender", async () => {
    const m = await parseMail(mail("From: a@b.test\nSubject: x\nContent-Type: text/html", "<p>Hello&nbsp;there</p><p>Second</p>"))
    expect(m!.text).toBe("Hello there\nSecond")
    expect(await parseMail(mail("Subject: x", "no sender"))).toBeNull()
  })

  it("cuts quoted mail in the usual forms", () => {
    expect(stripQuoted("Yes please.\n\nOn Mon, 1 Jan 2026,\nSam <s@x.test> wrote:\n> old")).toBe("Yes please.")
    expect(stripQuoted("Thanks\n-----Original Message-----\nFrom: x")).toBe("Thanks")
    expect(stripQuoted("Inline\n> quoted\nanswer")).toBe("Inline\nanswer")
  })
})

describe("who may write", () => {
  it("is closed by default, and takes addresses, @domain and *", () => {
    expect(senderAllowed("sam@client.test", undefined)).toBe(false)
    expect(senderAllowed("sam@client.test", [])).toBe(false)
    expect(senderAllowed("Sam@Client.test", ["sam@client.test"])).toBe(true)
    expect(senderAllowed("sam@client.test", ["@client.test"])).toBe(true)
    expect(senderAllowed("sam@evilclient.test", ["@client.test"])).toBe(false)
    expect(senderAllowed("anyone@x.test", ["*"])).toBe(true)
  })
})

describe("threads", () => {
  it("replies into the customer's latest mail, with the whole chain", async () => {
    const m = (await parseMail(mail("From: s@c.test\nSubject: Invoice\nMessage-ID: <2@c.test>\nReferences: <1@c.test>", "again?")))!
    const t = threadAfter("support", m, undefined, new Date("2026-10-25T10:00:00Z"))
    expect(t).toMatchObject({ account: "support", to: "s@c.test", subject: "Invoice", messageId: "<2@c.test>", references: ["<1@c.test>", "<2@c.test>"] })
    expect(replyHeaders(t)).toEqual({ subject: "Re: Invoice", inReplyTo: "<2@c.test>", references: "<1@c.test> <2@c.test>" })
    expect(replyHeaders({ ...t, subject: "RE: Invoice" }).subject).toBe("RE: Invoice")
    expect(replyHeaders({ ...t, subject: "", messageId: undefined, references: [] })).toEqual({ subject: "Re: your message" })
  })
})

describe("account settings", () => {
  it("fills ports and logins, and reads passwords from the environment", () => {
    const acc = emailAccountSchema.parse({
      agent: "inbox", address: "hello@shop.test",
      imap: { host: "imap.gmail.com", password: "${MAIL_PW}" },
      smtp: { host: "smtp.gmail.com" },
    })
    expect(acc).toMatchObject({ send: "approve", mailbox: "INBOX", pollSeconds: 60, imap: { port: 993, secure: true }, smtp: { port: 465, secure: true } })
    expect(acc.allowFrom).toBeUndefined()
    const { imap, smtp } = mailServers(acc, { MAIL_PW: "app-password" })
    expect(imap).toMatchObject({ user: "hello@shop.test", password: "app-password" })
    expect(smtp).toMatchObject({ host: "smtp.gmail.com", user: "hello@shop.test", password: "app-password" })
  })
})

describe("reply drafts", () => {
  const input = { agent: "inbox", account: "shop", to: "s@c.test", subject: "Re: Invoice", in_reply_to: "<2@c.test>", text: "Sent again." }

  it("sends only on yes, once, with the owner's edit", async () => {
    const d = createEmailDraft(root, input)
    const sent: string[] = []
    const send = async (x: any) => { sent.push(x.text); return { ok: true as const } }
    const [a, b] = await Promise.all([
      decideEmailDraft(root, d.id, "yes", { send, text: "Sent again, sorry for the wait." }),
      decideEmailDraft(root, d.id, "yes", { send }),
    ])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect(sent).toEqual(["Sent again, sorry for the wait."])
    expect(readEmailDraft(root, d.id)).toMatchObject({ status: "sent", edited: true })
    expect(listEmailDrafts(root, "pending")).toEqual([])
  })

  it("no drops it, and a failed send keeps it waiting with the reason", async () => {
    const dropped = createEmailDraft(root, input)
    expect(await decideEmailDraft(root, dropped.id, "no", { send: async () => { throw new Error("must not send") } })).toMatchObject({ ok: true, draft: { status: "rejected" } })

    const d = createEmailDraft(root, input, Date.now() + 1)
    const r = await decideEmailDraft(root, d.id, "yes", { send: async () => ({ ok: false as const, error: "535 bad login" }) })
    expect(r).toEqual({ ok: false, error: "not sent: 535 bad login" })
    expect(readEmailDraft(root, d.id)).toMatchObject({ status: "pending", error: "535 bad login" })
    expect(readdirSync(join(emailDir(root), "drafts")).filter((f) => f.endsWith(".claim"))).toEqual([])
    expect((await decideEmailDraft(root, d.id, "yes", { send: async () => ({ ok: true as const }) })).ok).toBe(true)
  })

  it("refuses an empty reply and an unknown id", async () => {
    expect(() => createEmailDraft(root, { ...input, text: "  " })).toThrow(/empty/)
    expect(await decideEmailDraft(root, "../../etc", "yes", { send: async () => ({ ok: true as const }) })).toMatchObject({ ok: false })
  })
})
