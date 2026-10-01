import { afterEach, describe, expect, it, vi } from "vitest"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"
import { browserOpener, openBrowser } from "../src/utils/open-browser"

afterEach(() => vi.restoreAllMocks())

describe("openBrowser", () => {
  // A server has no xdg-open. Node reports that as an "error" event on the
  // child, so an unhandled one ends the process (#403).
  it("prints the address and carries on when the opener is missing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    openBrowser("http://127.0.0.1:18931/live", "agentx-no-such-opener")
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1))
    expect(String(log.mock.calls[0][0])).toContain("http://127.0.0.1:18931/live")
  })

  it("picks the opener for the platform", () => {
    expect(browserOpener("darwin")).toBe("open")
    expect(browserOpener("win32")).toBe("start")
    expect(browserOpener("linux")).toBe("xdg-open")
  })

  it("is the only place in src that starts an opener", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
      )
    const src = join(__dirname, "..", "src")
    const users = files(src).filter((f) => readFileSync(f, "utf8").includes('"xdg-open"'))
    expect(users).toEqual([join(src, "utils", "open-browser.ts")])
  })
})
