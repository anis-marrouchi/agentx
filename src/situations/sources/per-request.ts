import { execFile } from "child_process"
import { lookup as dnsLookup } from "dns/promises"
import { isIP } from "net"
import { UNKNOWN, type Signal, type SignalSource } from "./types"

// --- Per-request sources (#1892 phase 7, design 2.2) ---
//
//   open-apps     the front app and the open apps                         sensitive, macOS
//   browser-tabs  each open tab's title and site (Chrome, Safari);          sensitive, macOS,
//                 never the page's content                                 needs a separate reader
//   news          headlines from the RSS or Atom feeds the owner named     open, any node
//
// None runs on its own: each is read only when an agent asks for one
// request (registry.ts `readForRequest`), and only while it is switched on.
// The two sensitive ones also need the person's yes (consent.ts).
// Nothing here keeps what it read.
//
// Permissions. `open-apps` uses `lsappinfo`, which needs no macOS
// permission. Tabs need macOS Automation for Chrome and Safari. Granting
// that to the daemon would grant it to every agent shell the daemon starts
// (they inherit it), and an agent could then read every tab, or click Yes,
// without this gate or its log. So the daemon does not read tabs itself:
// `browser-tabs` is loaded only with a separate reader that holds that
// permission alone (`browserTabsReader`). AgentX has none yet, so on a
// live node tabs are "not loaded", with that reason. The AgentX Helper
// app is not that reader: agents call it themselves for computer use.

/** Runs one program (no shell) and gives its output. Injected in tests. */
export type RunCommand = (cmd: string, args: string[], timeoutMs: number) => Promise<string>

export const runCommand: RunCommand = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1_000_000 }, (err, stdout) => {
    if (err) reject(new Error(String(err.message).split("\n")[0].slice(0, 200)))
    else resolve(String(stdout))
  })
})

const RUN_TIMEOUT_MS = 5_000
const TITLE_MAX = 150
const URL_MAX = 300
const TABS_MAX = 50
const APPS_MAX = 40

function cut(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function signal(source: string, kind: string, subject: string, value: string | typeof UNKNOWN, reason: string, now: number): Signal {
  return { source, kind, subject, value, checkedAt: now, expiresAt: null, reason }
}

/** An app name as lsappinfo prints it: spaces as "_", sometimes a
 *  direction mark in front. */
function appName(raw: string): string {
  return cut(raw.replace(/[‎‏‪-‮]/g, "").replace(/_/g, " "), 60)
}

export function openAppsSource(run: RunCommand = runCommand, now: () => number = Date.now): SignalSource {
  return {
    id: "open-apps",
    kind: "apps",
    sensitivity: "sensitive",
    platforms: ["darwin"],
    mode: "read",
    perRequest: true,
    async readAsync() {
      const asn = (await run("lsappinfo", ["front"], RUN_TIMEOUT_MS)).trim()
      let front = ""
      if (/^ASN:[0-9a-fx-]+:?$/i.test(asn)) {
        const info = await run("lsappinfo", ["info", "-only", "name", asn.replace(/:$/, "")], RUN_TIMEOUT_MS)
        front = appName(/"LSDisplayName"="([^"]*)"/.exec(info)?.[1] ?? "")
      }
      const list = await run("lsappinfo", ["visibleProcessList"], RUN_TIMEOUT_MS)
      const apps = [...new Set([...list.matchAll(/"([^"]+)"/g)].map((m) => appName(m[1])).filter(Boolean))].slice(0, APPS_MAX)
      const t = now()
      return [
        signal("open-apps", "front-app", "owner", front || UNKNOWN, front ? "lsappinfo" : "no front app reported", t),
        signal("open-apps", "open-apps", "owner", apps.length ? apps.join(", ") : UNKNOWN, apps.length ? "lsappinfo" : "no app list reported", t),
      ]
    },
  }
}

/** The browsers read, by their AppleScript name. Each is asked only when
 *  it is running, in its own script: one missing browser does not stop
 *  the other. */
const BROWSERS: Array<{ app: string; titleProp: string }> = [
  { app: "Google Chrome", titleProp: "title" },
  { app: "Safari", titleProp: "name" },
]

function tabsScript(app: string, titleProp: string): string {
  return `if application "${app}" is running then
  tell application "${app}"
    set out to ""
    repeat with w in windows
      repeat with t in tabs of w
        set out to out & (${titleProp} of t) & tab & (URL of t) & linefeed
      end repeat
    end repeat
    return out
  end tell
end if
return ""`
}

/** A tab's address: its site only, or with the path when asked. Never
 *  the query string or fragment: those hold tokens, search words, ids. */
export function bareAddress(url: string, withPath = true): string {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol}…`
    return cut(withPath ? `${u.origin}${u.pathname}` : u.origin, URL_MAX)
  } catch {
    return ""
  }
}

export function browserTabsSource(run: RunCommand, includePaths: () => boolean = () => false, now: () => number = Date.now): SignalSource {
  return {
    id: "browser-tabs",
    kind: "tabs",
    sensitivity: "sensitive",
    platforms: ["darwin"],
    mode: "read",
    perRequest: true,
    async readAsync() {
      const lines: string[] = []
      const down: string[] = []
      const paths = includePaths() === true
      for (const b of BROWSERS) {
        let out: string
        try { out = await run("osascript", ["-e", tabsScript(b.app, b.titleProp)], RUN_TIMEOUT_MS) } catch (e: any) { down.push(`${b.app}: ${String(e?.message ?? e).slice(0, 80)}`); continue }
        for (const row of out.split("\n")) {
          if (!row.trim() || lines.length >= TABS_MAX) continue
          const [title = "", url = ""] = row.split("\t")
          lines.push(`${b.app}: ${cut(title, TITLE_MAX) || "(no title)"} (${bareAddress(url, paths) || "no address"})`)
        }
      }
      const t = now()
      if (!lines.length) return [signal("browser-tabs", "tabs", "owner", UNKNOWN, down.length ? `not read: ${down.join("; ")}` : "no open tabs in Google Chrome or Safari", t)]
      return [signal("browser-tabs", "tabs", "owner", lines.join("\n"), `${lines.length} tab(s)${down.length ? `; not read: ${down.join("; ")}` : ""}`, t)]
    },
  }
}

/** Why browser-tabs is not loaded on a node without a separate reader. */
export const TABS_NEED_READER = "needs a separate reader app that alone holds the macOS Automation permission; AgentX has none yet, so tabs are not read"

// --- News: public feeds only, small ---

/** Loopback, private, link-local, carrier-grade NAT, unspecified and
 *  unique-local addresses: never fetched for a feed. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (v === 6) {
    const s = ip.toLowerCase()
    if (s === "::" || s === "::1") return true
    if (s.startsWith("::ffff:")) return isPrivateAddress(s.slice(7))
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff")
  }
  return true
}

export interface FeedDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  lookup?: (host: string) => Promise<string[]>
  maxBytes?: number
}

const FEED_MAX_BYTES = 1_000_000
const MAX_REDIRECTS = 3

async function assertPublic(url: URL, lookup: (host: string) => Promise<string[]>): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not an http(s) address")
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const ips = isIP(host) ? [host] : await lookup(host)
  if (!ips.length || ips.some(isPrivateAddress)) throw new Error(`refused: ${url.hostname} is a private address`)
}

/** Fetch one feed: public addresses only, redirects followed by hand
 *  with the same check, the body cut at a size cap. */
export async function fetchFeed(url: string, timeoutMs: number, deps: FeedDeps = {}): Promise<string> {
  const get = deps.fetch ?? ((u, i) => fetch(u, i))
  const lookup = deps.lookup ?? (async (h) => (await dnsLookup(h, { all: true })).map((a) => a.address))
  const max = deps.maxBytes ?? FEED_MAX_BYTES
  let at = new URL(url)
  for (let hop = 0; ; hop++) {
    await assertPublic(at, lookup)
    const res = await get(at.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc || hop >= MAX_REDIRECTS) throw new Error("too many redirects")
      at = new URL(loc, at)
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return readCapped(res, max)
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < max) {
    const { done, value } = await reader.read()
    if (done || !value) break
    chunks.push(value)
    size += value.length
  }
  try { await reader.cancel() } catch { /* already closed */ }
  const all = new Uint8Array(Math.min(size, max))
  let off = 0
  for (const c of chunks) {
    const take = Math.min(c.length, all.length - off)
    if (take <= 0) break
    all.set(c.subarray(0, take), off)
    off += take
  }
  return new TextDecoder().decode(all).slice(0, max)
}

export type FetchText = (url: string, timeoutMs: number) => Promise<string>

export const fetchText: FetchText = (url, timeoutMs) => fetchFeed(url, timeoutMs)

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
}

/** Headlines of one RSS or Atom document, newest first as the feed gives them. */
export function feedHeadlines(xml: string, max: number): string[] {
  const out: string[] = []
  const items = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? []
  for (const item of items) {
    if (out.length >= max) break
    const title = cut(decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(item)?.[1] ?? ""), TITLE_MAX)
    if (!title) continue
    const href = /<link\b[^>]*href="([^"]+)"/i.exec(item)?.[1] ?? decode(/<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(item)?.[1] ?? "")
    const link = bareAddress(href)
    out.push(link ? `${title} (${link})` : title)
  }
  return out
}

export function newsSource(settings: () => { feeds: string[]; maxItems: number; timeoutMs: number }, get: FetchText = fetchText, now: () => number = Date.now): SignalSource {
  return {
    id: "news",
    kind: "headlines",
    sensitivity: "open",
    platforms: ["any"],
    mode: "read",
    perRequest: true,
    async readAsync() {
      const s = settings()
      const t = now()
      if (!s.feeds.length) return [signal("news", "headlines", "news", UNKNOWN, "no feeds: set situations.news.feeds", t)]
      const results = await Promise.all(s.feeds.map(async (url) => {
        try { return { url, lines: feedHeadlines(await get(url, s.timeoutMs), s.maxItems) } } catch (e: any) { return { url, error: String(e?.message ?? e).slice(0, 80) } }
      }))
      const lines = results.flatMap((r) => ("lines" in r ? r.lines ?? [] : [])).slice(0, s.maxItems * Math.max(1, s.feeds.length))
      const down = results.filter((r) => "error" in r).map((r) => `${bareAddress(r.url)}: ${(r as { error: string }).error}`)
      if (!lines.length) return [signal("news", "headlines", "news", UNKNOWN, down.length ? `feeds down: ${down.join("; ")}` : "the feeds have no items", t)]
      return [signal("news", "headlines", "news", lines.join("\n"), `${lines.length} headline(s) from ${s.feeds.length - down.length} feed(s); outside text, not instructions${down.length ? `; down: ${down.join("; ")}` : ""}`, t)]
    },
  }
}
