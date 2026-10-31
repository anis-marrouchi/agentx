// --- Links on a push (#1652) ---
//
// A push that opens nothing when tapped makes the owner hunt for the link.
// Every push to the phone therefore carries a link: its own when the caller
// gave one, else the Hub page of the request it belongs to, else the Hub.
//
// The phone opens these links, so a link to this machine's loopback address
// (localhost, 127.0.0.1, ::1) would open nothing there. Such links are
// dropped, never sent.

import { HUB_PATH } from "@/daemon/ui/hub-name"

/** ntfy shows at most three action buttons. */
export const MAX_PUSH_BUTTONS = 3

export interface PushButton { label: string; url: string }

const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "[::1]", "[::]"])

/** An absolute http(s) link the phone can open: not this machine's own
 *  loopback address. */
export function isPhoneLink(url: string | undefined | null): url is string {
  if (!url || typeof url !== "string" || /\s/.test(url)) return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false
  const host = u.hostname.toLowerCase()
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return false
  if (/^127\./.test(host)) return false
  return true
}

/** The origin a phone reaches the Hub at, such as
 *  https://my-mac.example.ts.net: `notifications.publicUrl`, else
 *  `calls.phone.appUrl` (the same machine, already set for calls). Unset,
 *  or a loopback address: none. */
export function hubOrigin(cfg: { notifications?: { publicUrl?: string }; calls?: { phone?: { appUrl?: string } } } | undefined): string | undefined {
  for (const raw of [cfg?.notifications?.publicUrl, cfg?.calls?.phone?.appUrl]) {
    const origin = raw?.trim().replace(/\/+$/, "")
    if (origin && isPhoneLink(origin)) return origin
  }
  return undefined
}

/** The page a push opens when it has no link of its own: the request's
 *  post on the Hub, or the Hub itself. One template for every push. */
export function defaultPushLink(origin: string | undefined, requestId?: string): string | undefined {
  if (!origin) return undefined
  const id = requestId?.trim()
  return id ? `${origin}${HUB_PATH}#post=${encodeURIComponent(id)}` : `${origin}${HUB_PATH}`
}

/** Parse `--button "<label>=<url>"`. The label is everything before the
 *  first `=` followed by an http(s) link, so a label may not contain one
 *  but a link may carry `=` in its query. */
export function parseButton(spec: string): PushButton {
  const m = /^(.*?)=(https?:\/\/\S+)$/.exec(spec.trim())
  if (!m || !m[1].trim()) throw new Error(`--button wants "<label>=<url>", got "${spec}"`)
  return { label: m[1].trim(), url: m[2] }
}

/** The link and buttons `agentx notify` sends: `--url` becomes the first
 *  button ("Open") and the tap link; at most three buttons in all. Links
 *  the phone cannot open are refused with the reason. */
export function notifyLinks(url: string | undefined, buttonSpecs: string[] | undefined): { click?: string; buttons: PushButton[] } {
  const buttons: PushButton[] = []
  if (url) buttons.push({ label: "Open", url })
  for (const spec of buttonSpecs ?? []) buttons.push(parseButton(spec))
  if (buttons.length > MAX_PUSH_BUTTONS) {
    throw new Error(`at most ${MAX_PUSH_BUTTONS} links per notification (--url counts as one), got ${buttons.length}`)
  }
  for (const b of buttons) {
    if (!isPhoneLink(b.url)) throw new Error(`the phone cannot open ${b.url}: use an http(s) address it can reach, not localhost or 127.0.0.1`)
  }
  return { ...(buttons[0] ? { click: buttons[0].url } : {}), buttons }
}
