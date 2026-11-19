import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { daemonConfigSchema } from "../src/daemon/config"
import { REQUEST_STATUS_DEPRECATION, requestStatusDeprecationLog } from "../src/requests/status-deprecation"

// Request status is deprecated (#1861): the command says so on stderr and
// still works; the setting still parses; the daemon logs it only when on.

const NODE = { id: "test-node", name: "Test node", bind: "127.0.0.1:1" }
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("agentx request-status (deprecated)", () => {
  let cwd: string
  let out: string[]
  let err: string[]

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "agentx-reqstatus-"))
    writeFileSync(join(cwd, "agentx.json"), JSON.stringify({ node: NODE, requestStatus: { channels: ["github"] } }, null, 2))
    vi.spyOn(process, "cwd").mockReturnValue(cwd)
    // Never reach a real daemon from a test.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no daemon in tests") }))
    out = []
    err = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(plain(a.join(" "))) })
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(plain(a.join(" "))) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    rmSync(cwd, { recursive: true, force: true })
  })

  it("prints one deprecation line on stderr, then still lists the channels", async () => {
    const { requestStatus } = await import("../src/commands/request-status")
    await requestStatus.parseAsync([], { from: "user" })
    expect(err).toHaveLength(1)
    expect(err[0]).toContain("deprecated")
    expect(err[0]).toContain("Jobs page")
    expect(err[0]).toContain("removed in a later release")
    expect(out.join("\n")).toMatch(/github\s+on/)
    expect(out.join("\n")).toMatch(/gitlab\s+off/)
  })

  it("still turns a channel on, after the notice", async () => {
    const { requestStatus } = await import("../src/commands/request-status")
    await requestStatus.parseAsync(["gitlab", "on"], { from: "user" })
    expect(err[0]).toContain("deprecated")
    const saved = JSON.parse(readFileSync(join(cwd, "agentx.json"), "utf-8"))
    expect(saved.requestStatus.channels).toEqual(["github", "gitlab"])
    expect(out.join("\n")).toMatch(/gitlab\s+on/)
  })
})

describe("requestStatus setting (deprecated)", () => {
  it("is still accepted by the config parser", () => {
    const cfg = daemonConfigSchema.parse({ node: NODE, requestStatus: { channels: ["gitlab"] } })
    expect(cfg.requestStatus.channels).toEqual(["gitlab"])
  })

  it("gives the daemon a start-log line only when a channel has it on", () => {
    expect(requestStatusDeprecationLog([])).toBeNull()
    const line = requestStatusDeprecationLog(["gitlab"])
    expect(line).toContain("gitlab")
    expect(line).toContain(REQUEST_STATUS_DEPRECATION)
  })
})
