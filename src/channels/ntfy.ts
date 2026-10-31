import type { CallRing, ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"
import { HUB_PATH } from "@/daemon/ui/hub-name"
import { isPhoneLink } from "@/notify/phone-link"

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
  /** The origin a tap opens the Hub at (#1652): notifications.publicUrl,
   *  else calls.phone.appUrl. A function, so a config reload takes effect
   *  without a restart (#1655). */
  publicUrl?: string | (() => string | undefined)
  /** Test hook, not in the config schema: waits between attempts when a
   *  publish is safe to repeat. One attempt more than there are entries. */
  retryDelaysMs?: number[]
  /** Test hook, not in the config schema: time limit for one send, all
   *  attempts and waits included. */
  sendTimeoutMs?: number
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 8000]
const DEFAULT_SEND_TIMEOUT_MS = 20_000

/** `fetch failed` hides the reason in `cause`; surface its code so a log
 *  line says ETIMEDOUT or ECONNREFUSED rather than nothing useful (#930). */
export function describeFetchError(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } }
  const message = err?.message ?? String(e)
  const cause = err?.cause
  if (cause?.code) return `${message} code=${cause.code}`
  if (cause?.message && cause.message !== message) return `${message} (${cause.message})`
  return message
}

// A publish is retried only when the server cannot have stored it: ntfy has
// no key to drop a repeat, so re-posting after a 500 or a reset mid-response
// could put the same notification on the phone twice.

/** The connection never opened, so the request never reached the server.
 *  ETIMEDOUT can also, rarely, mean an open connection went silent; then a
 *  repeat is possible. Telling the two apart would need to know whether the
 *  body was written, which fetch does not expose. */
const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL",
  "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
])

function isRetryableFetchError(e: unknown): boolean {
  const code = (e as { cause?: { code?: string } })?.cause?.code
  return !!code && CONNECT_FAILURE_CODES.has(code)
}

/** 429 and 503 say the server turned the request away without handling it. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503
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
export function splitTitle(text: string): { title?: string; body: string } {
  const lines = text.split("\n")
  const first = (lines[0] ?? "").trim()
  const rest = lines.slice(1).join("\n").trim()
  if (!rest) return { body: text.trim() }
  if (first.length === 0 || first.length > 80) return { body: text.trim() }
  return { title: first, body: rest }
}

/** A ringing call (#1605) goes out as a call: priority 5 when urgent, so
 *  the ntfy app's "max priority" channel (set to a ringtone that overrides
 *  Do Not Disturb) rings through; 4 otherwise, which follows Do Not
 *  Disturb. The phone tag shows a receiver, and a tap opens the call in
 *  the phone app. A missed call is an ordinary notice. */
export function ringHeaders(ring: CallRing | undefined): Record<string, string> {
  if (!ring || ring.state !== "ringing") return {}
  const out: Record<string, string> = { "Priority": ring.urgent ? "5" : "4", "Tags": "telephone_receiver" }
  if (ring.url && /^https?:\/\/\S+$/.test(ring.url)) out["Click"] = ring.url
  return out
}

/** What a tap on the notification body opens (#1652): the message's own
 *  first link, else its `open` path (a request on the Hub), else the Hub,
 *  both on the public address. Nothing when there is no public address. */
export function clickUrl(link: string | undefined, open: string | undefined, publicUrl: string | undefined): string | undefined {
  if (isPhoneLink(link)) return link
  if (!isPhoneLink(publicUrl)) return undefined
  const path = open?.startsWith("/") ? open : HUB_PATH
  return publicUrl.replace(/\/+$/, "") + path
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
    Object.assign(headers, ringHeaders(msg.ring))

    // URL buttons map onto ntfy's view actions, so an alert can carry
    // "open the MR" without the operator hunting for it. A loopback link
    // would open the phone itself, so it is left out (#1652).
    const buttons = (msg.buttons ?? []).filter(b => isPhoneLink(b.url)).slice(0, 3)  // ntfy caps at 3
    if (buttons.length) {
      const actions = buttons
        .map(b => `view, ${b.label.replace(/[,;]/g, " ")}, ${b.url}`)
        .join("; ")
      headers["Actions"] = encodeHeader(actions)
    }
    const publicUrl = typeof this.config.publicUrl === "function" ? this.config.publicUrl() : this.config.publicUrl
    const click = clickUrl(buttons[0]?.url, msg.open, publicUrl)
    if (click && !headers["Click"]) headers["Click"] = click

    const url = `${this.serverUrl()}/${encodeURIComponent(topic)}`
    const body = split.body || msg.text || ""
    const delays = this.config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    const attempts = delays.length + 1
    // Each try can spend several seconds per address on a dead link, so the
    // whole send gets one time limit and callers never wait much past it.
    const limitMs = this.config.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
    const deadline = Date.now() + limitMs

    // A slow or flapping link loses pushes that a few seconds later would
    // go through. Retry only what cannot have been stored (see above).
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined
      let failure!: Error
      let retryable = false
      try {
        const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
        res = await fetch(url, { method: "POST", headers, body, signal })
      } catch (e) {
        // The abort only says "aborted due to timeout"; name the send limit.
        failure = (e as { name?: string })?.name === "TimeoutError"
          ? new Error(`ntfy: send time limit of ${limitMs} ms reached`, { cause: e })
          : new Error(`ntfy: ${describeFetchError(e)}`, { cause: e })
        retryable = isRetryableFetchError(e)
      }
      if (res) {
        if (res.ok) {
          const json = await res.json().catch(() => null) as { id?: string } | null
          return json?.id
        }
        const detail = await res.text().catch(() => "")
        failure = new Error(`ntfy: ${res.status} ${detail.slice(0, 200)}`)
        retryable = isRetryableStatus(res.status)
      }
      const wait = delays[attempt - 1]
      if (!retryable || attempt >= attempts || Date.now() + wait >= deadline) {
        this.log(`ntfy: send failed after ${attempt} attempt(s): ${failure.message}`)
        throw failure
      }
      this.log(`ntfy: attempt ${attempt}/${attempts} failed (${failure.message}); retrying in ${wait} ms`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
}
