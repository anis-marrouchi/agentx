import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { setCronEnabled } from "../src/crons/set-enabled"

let configPath: string

const base = {
  node: { id: "t", name: "T", bind: "127.0.0.1:0" },
  agents: { helper: { name: "Helper", workspace: "./agents/helper", tier: "claude-code", mentions: ["@helper"] } },
}

function write(crons: Record<string, unknown>) {
  writeFileSync(configPath, JSON.stringify({ ...base, crons }, null, 2) + "\n")
}
const read = () => JSON.parse(readFileSync(configPath, "utf-8"))

beforeEach(() => {
  configPath = join(mkdtempSync(join(tmpdir(), "cron-enabled-")), "agentx.json")
})

describe("setCronEnabled", () => {
  it("switches a schedule off and on", async () => {
    write({ digest: { schedule: "0 9 * * *", agent: "helper", prompt: "hi", enabled: true } })
    expect(await setCronEnabled("digest", false, { configPath })).toEqual({ ok: true, id: "digest", enabled: false, changed: true })
    expect(read().crons.digest.enabled).toBe(false)
    expect(await setCronEnabled("digest", true, { configPath })).toMatchObject({ ok: true, changed: true })
    expect(read().crons.digest.enabled).toBe(true)
  })

  it("does not write when nothing changes", async () => {
    write({ digest: { schedule: "0 9 * * *", agent: "helper", prompt: "hi", enabled: false } })
    const before = statSync(configPath).mtimeMs
    expect(await setCronEnabled("digest", false, { configPath })).toMatchObject({ ok: true, changed: false })
    expect(statSync(configPath).mtimeMs).toBe(before)
  })

  it("refuses an unknown schedule", async () => {
    write({})
    expect(await setCronEnabled("nope", true, { configPath })).toMatchObject({ ok: false, status: 404 })
  })

  it("keeps a proposed schedule off until it is approved", async () => {
    write({ proposed: { schedule: "0 9 * * *", agent: "helper", prompt: "hi", enabled: false, approval: { action: "create" } } })
    expect(await setCronEnabled("proposed", true, { configPath })).toMatchObject({ ok: false, status: 409 })
    expect(read().crons.proposed.enabled).toBe(false)
    // Switching it off is always allowed.
    expect(await setCronEnabled("proposed", false, { configPath })).toMatchObject({ ok: true, changed: false })
  })

  it("keeps ${VAR} tokens in the file", async () => {
    write({ d: { schedule: "0 9 * * *", agent: "helper", prompt: "Say ${GREETING}", enabled: true } })
    await setCronEnabled("d", false, { configPath })
    expect(read().crons.d.prompt).toBe("Say ${GREETING}")
    expect(read().crons.d.enabled).toBe(false)
  })
})
