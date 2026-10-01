import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { closeDb } from "../src/storage/sqlite"
import { requests } from "../src/commands/requests"
import { updateRequestSettings } from "../src/requests/settings"
import { handleRequestsPanel } from "../src/daemon/requests-panel"
import { renderApprovalsPage } from "../src/daemon/ui/pages/approvals"
import { REQUESTS_SCRIPT } from "../src/daemon/ui/pages/approvals-requests"

// Rough edges left by the reviews of the requests CLI and page (#395).

const P = "/api/admin/approvals/requests"
const CONFIG = JSON.stringify({ node: { id: "n", name: "n" }, agents: {} })

let tmp: string
let cwd: string

beforeEach(() => {
  cwd = process.cwd()
  // realpath: process.cwd() gives the resolved path, and the reader compares.
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "agentx-requests-edges-")))
  process.chdir(tmp)
})
afterEach(() => {
  closeDb()
  process.chdir(cwd)
  process.exitCode = undefined
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

/** A database file with no requests tables, as the usage recorder leaves it. */
function bareDatabase(): string {
  mkdirSync(path.join(tmp, ".agentx"))
  const file = path.join(tmp, ".agentx", "db.sqlite")
  new Database(file).close()
  return file
}

const tables = (file: string) => {
  const db = new Database(file, { readonly: true })
  try { return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name) } finally { db.close() }
}

describe("agentx requests outside the install folder", () => {
  it("says so and exits 1, even when a database file is there", async () => {
    bareDatabase()
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const out = vi.spyOn(console, "log").mockImplementation(() => {})
    await requests.parseAsync(["list"], { from: "user" })
    expect(process.exitCode).toBe(1)
    expect(String(err.mock.calls[0]?.[0])).toContain("run this from the install folder")
    expect(out).not.toHaveBeenCalled()
  })
})

describe("the channels setting", () => {
  it("refuses a name no person writes on, and saves nothing", async () => {
    const configPath = path.join(tmp, "agentx.json")
    writeFileSync(configPath, CONFIG)
    const r = await updateRequestSettings({ channels: ["voice", "telegrm"] }, { configPath, reload: false })
    expect(r.success).toBe(false)
    expect(r.error).toContain('unknown channel "telegrm"')
    expect(r.error).toContain("telegram")
    expect(readFileSync(configPath, "utf-8")).toBe(CONFIG)
  })

  it("takes known names in any case, with a node suffix, and the empty list", async () => {
    const configPath = path.join(tmp, "agentx.json")
    writeFileSync(configPath, CONFIG)
    expect((await updateRequestSettings({ channels: ["Voice", "telegram@peer"] }, { configPath, reload: false })).success).toBe(true)
    expect(JSON.parse(readFileSync(configPath, "utf-8")).requests.channels).toEqual(["Voice", "telegram@peer"])
    expect((await updateRequestSettings({ channels: [] }, { configPath, reload: false })).success).toBe(true)
  })

  it("is refused by the dashboard form too", async () => {
    const configPath = path.join(tmp, "agentx.json")
    writeFileSync(configPath, CONFIG)
    const r = await handleRequestsPanel("POST", `${P}/settings`, { channels: "whatsap" }, { root: tmp, configPath, reload: false })
    expect(r.status).toBe(400)
    expect((r.body as any).error).toContain('unknown channel "whatsap"')
  })
})

describe("reading requests from the dashboard", () => {
  it("creates no tables in a database that has none", async () => {
    const file = bareDatabase()
    const configPath = path.join(tmp, "agentx.json")
    writeFileSync(configPath, CONFIG)
    const r = await handleRequestsPanel("GET", P, {}, { root: tmp, configPath, reload: false })
    expect(r.status).toBe(200)
    expect((r.body as any).items).toEqual([])
    closeDb()
    expect(tables(file)).not.toContain("requests")
    expect(tables(file)).not.toContain("request_links")
  })
})

describe("the Open requests list after an answer in the inbox", () => {
  it("loads again when the inbox reports a decision", async () => {
    const listeners: Record<string, () => void> = {}
    const element: any = { addEventListener: () => {}, contains: () => false, enabled: {}, from: {}, channels: {}, staleAfterHours: {}, retentionDays: {} }
    const document = {
      getElementById: () => element,
      addEventListener: (name: string, fn: () => void) => { listeners[name] = fn },
      visibilityState: "visible",
      activeElement: null,
    }
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ items: [], settings: {} }) }))
    new Function("document", "fetch", "window", "setInterval", REQUESTS_SCRIPT)(document, fetch, {}, () => 0)
    expect(fetch).toHaveBeenCalledTimes(1)
    listeners["apv:decided"]()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0]).toBe(P)
  })

  it("is told by the inbox once a decision is saved", () => {
    expect(renderApprovalsPage()).toContain("document.dispatchEvent(new Event('apv:decided'))")
  })
})
