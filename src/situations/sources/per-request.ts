import { execFile } from "child_process"
import { UNKNOWN, type Signal, type SignalSource } from "./types"

// --- Per-request sources (#1892 phase 7, design 2.2) ---
//
//   open-apps     the front app, its front window's title, the open apps   sensitive, macOS
//   browser-tabs  each open tab's title and address (no query string),    sensitive, macOS
//                 in Google Chrome and Safari; never the page's content
//   news          headlines from the RSS or Atom feeds the owner named     open, any node
//
// None runs on its own: each is read only when an agent asks for one
// request (registry.ts `readForRequest`), and only while it is switched on.
// The two sensitive ones also need the person's yes (consent.ts).
// Nothing here keeps what it read.

/** Runs one AppleScript and gives its output. Injected in tests. */
export type RunScript = (script: string, timeoutMs: number) => Promise<string>

export const runOsascript: RunScript = (script, timeoutMs) => new Promise((resolve, reject) => {
  execFile("osascript", ["-e", script], { timeout: timeoutMs, maxBuffer: 1_000_000 }, (err, stdout) => {
    if (err) reject(new Error(String(err.message).split("\n")[0].slice(0, 200)))
    else resolve(String(stdout))
  })
})

const SCRIPT_TIMEOUT_MS = 5_000
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

const APPS_SCRIPT = `tell application "System Events"
  set fa to first application process whose frontmost is true
  set fname to name of fa
  set wt to ""
  try
    set wt to name of front window of fa
  end try
  set names to name of every application process whose background only is false
end tell
set AppleScript's text item delimiters to linefeed
return fname & linefeed & wt & linefeed & (names as text)`

export function openAppsSource(run: RunScript = runOsascript, now: () => number = Date.now): SignalSource {
  return {
    id: "open-apps",
    kind: "apps",
    sensitivity: "sensitive",
    platforms: ["darwin"],
    mode: "read",
    perRequest: true,
    async readAsync() {
      const out = (await run(APPS_SCRIPT, SCRIPT_TIMEOUT_MS)).split("\n")
      const t = now()
      const front = cut(out[0] ?? "", TITLE_MAX)
      const window = cut(out[1] ?? "", TITLE_MAX)
      const apps = out.slice(2).map((a) => cut(a, 60)).filter(Boolean).slice(0, APPS_MAX)
      return [
        signal("open-apps", "front-app", "owner", front || UNKNOWN, front ? "System Events" : "no front app reported", t),
        signal("open-apps", "front-window", "owner", window || UNKNOWN, window ? "System Events" : "no window title (none open, or no Accessibility permission)", t),
        signal("open-apps", "open-apps", "owner", apps.length ? apps.join(", ") : UNKNOWN, apps.length ? "System Events" : "no app list reported", t),
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

/** A tab's address without its query string or fragment: those can hold
 *  tokens, search words or ids the person did not mean to share. */
export function bareAddress(url: string): string {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol}…`
    return cut(`${u.origin}${u.pathname}`, URL_MAX)
  } catch {
    return ""
  }
}

export function browserTabsSource(run: RunScript = runOsascript, now: () => number = Date.now): SignalSource {
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
      for (const b of BROWSERS) {
        let out: string
        try { out = await run(tabsScript(b.app, b.titleProp), SCRIPT_TIMEOUT_MS) } catch (e: any) { down.push(`${b.app}: ${String(e?.message ?? e).slice(0, 80)}`); continue }
        for (const row of out.split("\n")) {
          if (!row.trim() || lines.length >= TABS_MAX) continue
          const [title = "", url = ""] = row.split("\t")
          lines.push(`${b.app}: ${cut(title, TITLE_MAX) || "(no title)"} (${bareAddress(url) || "no address"})`)
        }
      }
      const t = now()
      if (!lines.length) return [signal("browser-tabs", "tabs", "owner", UNKNOWN, down.length ? `not read: ${down.join("; ")}` : "no open tabs in Google Chrome or Safari", t)]
      return [signal("browser-tabs", "tabs", "owner", lines.join("\n"), `${lines.length} tab(s)${down.length ? `; not read: ${down.join("; ")}` : ""}`, t)]
    },
  }
}

export type FetchText = (url: string, timeoutMs: number) => Promise<string>

export const fetchText: FetchText = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return text.slice(0, 2_000_000)
}

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
      return [signal("news", "headlines", "news", lines.join("\n"), `${lines.length} headline(s) from ${s.feeds.length - down.length} feed(s)${down.length ? `; down: ${down.join("; ")}` : ""}`, t)]
    },
  }
}
