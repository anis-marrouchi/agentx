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
const OS_WORDS = /darwin|win32|osascript|afplay|remindctl|\/System\/Library/

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
const offenders = sourceFiles(SRC)
  .filter((f) => OS_WORDS.test(readFileSync(f, "utf8")))
  .map((f) => relative(ROOT, f).split("\\").join("/"))
  .sort()

describe("no OS-specific code in core (#1062)", () => {
  it("names the OS only in src/native/ or an allowlisted file", () => {
    const fresh = offenders.filter((f) => !allowlist.includes(f))
    expect(fresh, "move this OS work into src/native/ instead of adding to os-allowlist.json").toEqual([])
  })

  it("drops allowlist entries that no longer name the OS", () => {
    const stale = allowlist.filter((f) => !offenders.includes(f))
    expect(stale, "delete these lines from test/native/os-allowlist.json").toEqual([])
  })

  it("keeps the allowlist sorted and without repeats", () => {
    expect(allowlist).toEqual([...new Set(allowlist)].sort())
  })
})
