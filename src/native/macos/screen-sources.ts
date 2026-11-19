import { bareAddress, cut, RUN_TIMEOUT_MS, runCommand, signal, TITLE_MAX, type RunCommand } from "@/situations/sources/per-request"
import { UNKNOWN, type SignalSource } from "@/situations/sources/types"

// --- macOS per-request screen sources (#1892 phase 7) ---
//
// The OS half of situations/sources/per-request.ts: what is open on a Mac.
// `open-apps` reads `lsappinfo`, which needs no macOS permission. Tabs need
// the Automation permission for Chrome and Safari, so `browser-tabs` is
// given only a separate reader that alone holds it (see per-request.ts);
// the daemon has none yet. Both are read only for one request, after the
// person's yes, through the registry.

const TABS_MAX = 50
const APPS_MAX = 40

/** An app name as lsappinfo prints it: spaces as "_", sometimes a
 *  direction mark in front. */
function appName(raw: string): string {
  return cut(raw.replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/_/g, " "), 60)
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

