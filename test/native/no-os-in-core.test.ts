import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "fs"
import { join, relative, sep } from "path"

// Nothing OS-specific in core (#1062, plan part 1 §3a).
//
// Code that names a platform or runs an OS tool belongs in src/native/,
// behind the NativeAdapter, so core never asks which OS it runs on and a
// Windows adapter can be added without touching it. apps/ (the Swift and
// Kotlin apps) and src/computer-use/ are OS code by nature and are not
// scanned.
//
// Today 22 files outside src/native/ still match. They are listed in
// os-allowlist.json, and the list may only shrink:
//   - a file that matches and is not listed fails: move its OS code into
//     src/native/ instead of listing it;
//   - a listed file that no longer matches fails: take it off the list, so
//     the list never claims more than is there;
//   - the list may never hold a file that was not on it when it was made
//     (BASELINE below). That baseline is history: never add to it.
//
// The scan is plain text, comments included. A comment that names
// osascript in core is still a pointer to OS code that lives in core.

const ROOT = join(__dirname, "..", "..")
const SRC = join(ROOT, "src")
const SKIP = new Set([join(SRC, "native"), join(SRC, "computer-use")])
const OS_WORDS = /\b(darwin|win32|osascript|afplay|remindctl)\b|\/System\/Library/

/** The allowlist as it was made on 2026-10-19 (main at 6612b35). */
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

const allowlist: string[] = JSON.parse(readFileSync(join(__dirname, "os-allowlist.json"), "utf-8")).files

function filesUnder(dir: string): string[] {
  if (SKIP.has(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    return e.isDirectory() ? filesUnder(path) : [path]
  })
}

/** "src/x.ts:12: <line>" for the first line that names an OS word, or null. */
function firstMatch(path: string): string | null {
  const lines = readFileSync(path, "utf-8").split("\n")
  const i = lines.findIndex((l) => OS_WORDS.test(l))
  return i < 0 ? null : `${toRepoPath(path)}:${i + 1}: ${lines[i].trim().slice(0, 120)}`
}

const toRepoPath = (path: string) => relative(ROOT, path).split(sep).join("/")

describe("OS-specific code outside src/native", () => {
  const matches = filesUnder(SRC)
    .map((path) => ({ file: toRepoPath(path), hit: firstMatch(path) }))
    .filter((m): m is { file: string; hit: string } => m.hit !== null)

  it("appears only in files on the allowlist", () => {
    const listed = new Set(allowlist)
    const unlisted = matches.filter((m) => !listed.has(m.file)).map((m) => m.hit)
    expect(unlisted, "move this OS code into src/native/ rather than listing the file").toEqual([])
  })

  it("is still in every file on the allowlist", () => {
    const matching = new Set(matches.map((m) => m.file))
    const stale = allowlist.filter((f) => !matching.has(f))
    expect(stale, "these files no longer name an OS tool: take them off os-allowlist.json").toEqual([])
  })

  it("never gains a file the allowlist did not start with", () => {
    const baseline = new Set(BASELINE)
    expect(allowlist.filter((f) => !baseline.has(f))).toEqual([])
  })

  it("is listed once per file, in order", () => {
    expect(allowlist).toEqual([...new Set(allowlist)].sort())
  })
})

describe("the OS word scan", () => {
  it("finds platform names and OS tools, and nothing that only contains them", () => {
    for (const line of [
      'process.platform === "darwin"',
      "if (process.platform === 'win32')",
      'execFile("/usr/bin/osascript", args)',
      'spawn("afplay", ["-v", "0.4", file])',
      "remindctl show all --json",
      "/System/Library/Sounds/Glass.aiff",
    ]) expect(OS_WORDS.test(line), line).toBe(true)
    for (const line of ["darwinism", "win32api", "remindctlx", "System/Libraryish"]) {
      expect(OS_WORDS.test(line), line).toBe(false)
    }
  })
})
