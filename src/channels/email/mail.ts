import PostalMime from "postal-mime"

// --- Email: parsing, threading and sender checks, without any I/O (#1287) ---
//
// One conversation per customer address, like a WhatsApp chat: the chat id
// is the sender's address. A reply goes into the thread of the customer's
// latest message (In-Reply-To + References), so it lands in the same thread
// in their mail app.

export interface ParsedMail {
  /** Lower-cased sender address. */
  from: string
  fromName?: string
  subject: string
  messageId?: string
  /** Message-IDs of the thread so far, oldest first, ending with this one's parent. */
  references: string[]
  /** The new text only: the quoted earlier mail is cut. */
  text: string
  /** An auto-reply, bounce or list mail: never answered. */
  automatic: boolean
}

/** What a reply needs to land in the customer's thread. */
export interface ThreadState {
  account: string
  to: string
  toName?: string
  subject: string
  /** The customer's latest message, answered by the next reply. */
  messageId?: string
  references: string[]
  updatedAt: string
}

/** Longest new text handed to the agent; the rest is cut with a note. */
export const MAX_TEXT = 8000

export async function parseMail(raw: Buffer | string): Promise<ParsedMail | null> {
  const mail = await PostalMime.parse(raw)
  const box = mail.from && "address" in mail.from ? mail.from : undefined
  const from = box?.address?.trim().toLowerCase()
  if (!from) return null
  const header = (name: string) => mail.headers.find((h) => h.key === name)?.value ?? ""
  const references = idList(mail.references ?? "")
  if (mail.inReplyTo) {
    for (const id of idList(mail.inReplyTo)) if (!references.includes(id)) references.push(id)
  }
  const auto = header("auto-submitted").toLowerCase()
  const precedence = header("precedence").toLowerCase()
  const text = stripQuoted(mail.text ?? htmlToText(mail.html ?? ""))
  return {
    from,
    fromName: box?.name || undefined,
    subject: (mail.subject ?? "").trim(),
    messageId: mail.messageId ? idList(mail.messageId)[0] : undefined,
    references,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[… the rest of the mail was cut]` : text,
    automatic: (auto !== "" && auto !== "no")
      || ["bulk", "junk", "list", "auto_reply"].includes(precedence)
      || header("list-id") !== ""
      || /^(mailer-daemon|postmaster|no-?reply)@/.test(from),
  }
}

/** `<a@b> <c@d>` → ["<a@b>", "<c@d>"]. */
export function idList(value: string): string[] {
  return value.match(/<[^<>\s]+>/g) ?? []
}

/** The customer's new text, without the quoted mail below "On … wrote:" or "> " lines. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^On .{4,200}wrote:\s*$/.test(line)) break
    if (/^On .{4,200}$/.test(line) && /wrote:\s*$/.test(lines[i + 1] ?? "")) break
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break
    if (/^>/.test(line)) continue
    out.push(line)
  }
  return out.join("\n").trim()
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
}

/**
 * May this sender reach the agent? Closed by default, like Telegram and
 * WhatsApp: no list lets nobody in. Entries: an address, `@domain`, or `*`.
 */
export function senderAllowed(address: string, allowFrom: string[] | undefined): boolean {
  if (!allowFrom || allowFrom.length === 0) return false
  const a = address.toLowerCase()
  return allowFrom.some((raw) => {
    const e = raw.trim().toLowerCase()
    if (e === "*") return true
    if (e.startsWith("@")) return a.endsWith(e)
    return a === e
  })
}

/** The thread after the customer's `mail` came in on `account`. */
export function threadAfter(account: string, mail: ParsedMail, prev: ThreadState | undefined, now = new Date()): ThreadState {
  // A new subject from the same customer starts a new thread; a reply keeps
  // the references the mail itself carries.
  const references = [...mail.references]
  if (mail.messageId && !references.includes(mail.messageId)) references.push(mail.messageId)
  return {
    account,
    to: mail.from,
    toName: mail.fromName ?? prev?.toName,
    subject: mail.subject || prev?.subject || "",
    messageId: mail.messageId,
    references: references.slice(-20),
    updatedAt: now.toISOString(),
  }
}

/** Headers of a reply into `thread`. */
export function replyHeaders(thread: ThreadState): { subject: string; inReplyTo?: string; references?: string } {
  const subject = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject || "your message"}`
  return {
    subject,
    ...(thread.messageId ? { inReplyTo: thread.messageId } : {}),
    ...(thread.references.length ? { references: thread.references.join(" ") } : {}),
  }
}

/** The text the agent reads: who wrote, about what, and the new text. */
export function agentText(mail: ParsedMail): string {
  return `Email from ${mail.fromName ? `${mail.fromName} <${mail.from}>` : mail.from}\nSubject: ${mail.subject || "(none)"}\n\n${mail.text || "(no text)"}`
}
