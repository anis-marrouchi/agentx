import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "fs"
import { join, relative } from "path"

// #1062 step 1: OS work belongs in src/native/ (and computer-use, which is
// macOS by nature). Every other file under src/ stays OS-free, so a Windows
// adapter later only has to fill in src/native/. Files that name the OS
// today are listed in os-allowlist.json; the list may only shrink.

const ROOT = join(__dirname, "..", "..")
const SRC = join(ROOT, "src")
const SKIP = new Set(["native", "computer-use"].map((d) => join(SRC, d)))
// Whole words only, so names like `darwinism` or `win32api` do not count.
const OS_WORDS = /\b(darwin|win32|osascript|afplay|remindctl)\b|\/System\/Library/

/** The allowlist as it was made on 2026-10-19 (main at 6612b35). Never add to it.
 * CI checks out the PR without main's history, so "may only shrink" is held
 * against this frozen copy rather than a diff against main. */
const BASELINE = [
  "src/approvals/card-window.ts",
  "src/approvals/origin.ts",
  "src/approvals/popup-runner.ts",
  "src/approvals/popup.ts",
  "src/commands/approvals-card.ts",
  "src/commands/doctor.ts",
  "src/daemon/config.ts",
  "src/daemon/index.ts",
  "src/daemon/restart-host.ts",
  "src/daemon/screen-buffer.ts",
  "src/daemon/ui/pages/admin.ts",
  "src/decisions/seats/voice-narration.ts",
  "src/desktop/install.ts",
  "src/guard/confirm.ts",
  "src/notify/helper-status.ts",
  "src/notify/local.ts",
  "src/reminders/daemon.ts",
  "src/reminders/source.ts",
  "src/utils/open-browser.ts",
  "src/voice/siri.ts",
  "src/voice/speaker.ts",
  "src/voice/system-voices.ts",
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP.has(p)) out.push(...sourceFiles(p))
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

const allowlist: string[] = JSON.parse(readFileSync(join(__dirname, "os-allowlist.json"), "utf8")).files
// Each matching file, with its first matching line so a failure points at the code to move.
const hits = new Map<string, string>()
for (const f of sourceFiles(SRC)) {
  const lines = readFileSync(f, "utf8").split("\n")
  const i = lines.findIndex((l) => OS_WORDS.test(l))
  if (i >= 0) hits.set(relative(ROOT, f).split("\\").join("/"), `${i + 1}: ${lines[i].trim()}`)
}
const offenders = [...hits.keys()].sort()

describe("no OS-specific code in core (#1062)", () => {
  it("names the OS only in src/native/ or an allowlisted file", () => {
    const fresh = offenders.filter((f) => !allowlist.includes(f)).map((f) => `${f}:${hits.get(f)}`)
    expect(fresh, "move this OS work into src/native/ instead of adding to os-allowlist.json").toEqual([])
  })

  it("drops allowlist entries that no longer name the OS", () => {
    const stale = allowlist.filter((f) => !offenders.includes(f))
    expect(stale, "delete these lines from test/native/os-allowlist.json").toEqual([])
  })

  it("never gains a file the allowlist did not start with", () => {
    const baseline = new Set(BASELINE)
    const added = allowlist.filter((f) => !baseline.has(f))
    expect(added, "move this OS work into src/native/; the allowlist may only shrink").toEqual([])
  })

  it("keeps the allowlist sorted and without repeats", () => {
    expect(allowlist).toEqual([...new Set(allowlist)].sort())
  })
})
