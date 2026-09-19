import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"

// --- ntfy channel — push notifications to the operator's phone ---
//
// Outbound only. ntfy has an inbound side (SSE subscribe), but nothing here
// wants it: a push notification is a one-way tap on the shoulder, and replies
// come back through the channels that already carry conversation (Telegram,
// WhatsApp) or through POST /ask when Siri asks a follow-up.
//
// Registering it as a ChannelAdapter rather than a bespoke notifier is what
// makes it free everywhere: notifications.destination, POST /send, cron
// failure pings, and the agent-facing `channel` action all funnel through
// router.sendOutbound() and already know how to address a channel + chatId.
//
// Addressing: `chatId` is the ntfy topic. The literal `"default"` (and an
// empty string) resolve to the configured topic instead. That indirection
// exists so agents never have to carry the topic in their prompts — on the
// public ntfy.sh the topic IS the credential, and every caller that funnels
// through the router (POST /send, channel.reply) requires a non-empty chatId.

export interface NtfyConfig {
  /** Base URL of the ntfy server. Default is the public ntfy.sh. */
  server?: string
  /** Default topic when an OutgoingMessage carries no chatId. */
  topic: string
  /** Access token for protected topics (ntfy `Authorization: Bearer`). */
  token?: string
  /** 1 (min) .. 5 (max). ntfy's default is 3. */
  defaultPriority?: number
  /** Notification title. Per-message titles override it. */
  defaultTitle?: string
}

/**
 * ntfy requires header values to be ASCII. Titles and tags routinely aren't
 * (French accents, Arabic), so non-ASCII values go out as RFC 2047 encoded
 * words, which ntfy decodes. Pure-ASCII values are passed through untouched
 * so the common case stays readable in logs.
 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
}

/** First line of the body, when it reads like a title (short, no trailing
 *  punctuation that implies a sentence continues). Lets an agent write a
 *  single blob and still get a well-formed notification. */
function splitTitle(text: string): { title?: string; body: string } {
  const lines = text.split("\n")
  const first = (lines[0] ?? "").trim()
  const rest = lines.slice(1).join("\n").trim()
  if (!rest) return { body: text.trim() }
  if (first.length === 0 || first.length > 80) return { body: text.trim() }
  return { title: first, body: rest }
}

export class NtfyAdapter implements ChannelAdapter {
  readonly name = "ntfy"
  private config: NtfyConfig
  private log: (...args: unknown[]) => void

  constructor(config: NtfyConfig, log: (...args: unknown[]) => void = console.error.bind(console, "[ntfy]")) {
    this.config = config
    this.log = log
  }

  async start(): Promise<void> {
    this.log(`ntfy: ready (${this.serverUrl()}/${this.config.topic})`)
  }

  async stop(): Promise<void> {}

  /** No inbound side — the handler is accepted and never invoked, which
   *  satisfies router.addChannel() without pretending to poll. */
  onMessage(_handler: (msg: IncomingMessage) => Promise<void>): void {}

  private serverUrl(): string {
    return (this.config.server || "https://ntfy.sh").replace(/\/+$/, "")
  }

  async send(msg: OutgoingMessage): Promise<string | void> {
    const requested = (msg.chatId || "").trim()
    const topic = requested && requested !== "default" ? requested : this.config.topic
    if (!topic) throw new Error("ntfy: no topic (pass chatId, or set channels.ntfy.topic)")

    const split = splitTitle(msg.text || "")
    const title = split.title || this.config.defaultTitle || "AgentX"

    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      "Title": encodeHeader(title),
      "Priority": String(this.config.defaultPriority ?? 3),
    }
    if (this.config.token) headers["Authorization"] = `Bearer ${this.config.token}`
    if (msg.parseMode === "markdown") headers["Markdown"] = "yes"

    // URL buttons map onto ntfy's view actions, so an alert can carry
    // "open the MR" without the operator hunting for it.
    if (msg.buttons?.length) {
      const actions = msg.buttons
        .slice(0, 3)  // ntfy caps at 3
        .map(b => `view, ${b.label.replace(/[,;]/g, " ")}, ${b.url}`)
        .join("; ")
      headers["Actions"] = encodeHeader(actions)
    }

    const res = await fetch(`${this.serverUrl()}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body: split.body || msg.text || "",
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(`ntfy: ${res.status} ${detail.slice(0, 200)}`)
    }

    const json = await res.json().catch(() => null) as { id?: string } | null
    return json?.id
  }
}
