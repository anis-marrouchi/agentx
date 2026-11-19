import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { loadDaemonConfig } from "../src/daemon/config"
import { retireStatusTables, STATUS_TABLES } from "../src/requests/status-retire"

// Request status was removed (#1950); the Jobs page replaces it. A node
// whose agentx.json still has the setting keeps starting, and the old
// tables leave the database only when nothing in them is lost.

const NODE = { id: "test-node", name: "Test node", bind: "127.0.0.1:1" }

describe("an agentx.json that still has requestStatus", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-rs-cfg-")) })
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

  it("keeps loading, ignores the setting, and warns in one line, once", () => {
    const file = join(dir, "agentx.json")
    writeFileSync(file, JSON.stringify({ node: NODE, requestStatus: { channels: ["gitlab"] } }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const cfg = loadDaemonConfig(file) as Record<string, unknown>
    expect(cfg.requestStatus).toBeUndefined()
    loadDaemonConfig(file)
    const lines = warn.mock.calls.map((c) => c.join(" "))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("\n")
    expect(lines[0]).toContain("requestStatus")
    expect(lines[0]).toContain("Jobs page")
  })

  it("says nothing for a file without it", () => {
    const file = join(dir, "agentx.json")
    writeFileSync(file, JSON.stringify({ node: NODE }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    loadDaemonConfig(file)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("agentx request-status", () => {
  it("is no longer a command", async () => {
    const { buildProgram } = await import("../src/program")
    const program = await buildProgram()
    expect(program.commands.map((c) => c.name())).not.toContain("request-status")
  }, 30_000)
})

describe("the old request status tables", () => {
  let dir: string
  let db: Database.Database
  let logs: string[]
  const log = (m: string) => { logs.push(m) }
  const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)

  /** The tables as the last release made them. */
  const makeOld = () => db.exec(`
    CREATE TABLE request_status (id TEXT PRIMARY KEY, channel TEXT NOT NULL, chat_id TEXT NOT NULL, agent_id TEXT NOT NULL, sender_id TEXT,
      state TEXT NOT NULL, waiting_on TEXT, since INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 0, turn_live INTEGER NOT NULL DEFAULT 0,
      comment_ref TEXT, shown TEXT, write_fails INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE request_status_refs (kind TEXT NOT NULL, ref TEXT NOT NULL, status_id TEXT NOT NULL, PRIMARY KEY (kind, ref),
      FOREIGN KEY (status_id) REFERENCES request_status(id) ON DELETE CASCADE);
    CREATE TABLE request_status_waits (delegation_id TEXT PRIMARY KEY, status_id TEXT NOT NULL, until INTEGER NOT NULL,
      FOREIGN KEY (status_id) REFERENCES request_status(id) ON DELETE CASCADE);
  `)
  const addRow = () => {
    db.prepare("INSERT INTO request_status (id, channel, chat_id, agent_id, state, since, created_at, updated_at) VALUES ('req-1', 'gitlab', 'acme/shop:issue:7', 'coder', 'done', 1, 1, 1)").run()
    db.prepare("INSERT INTO request_status_refs (kind, ref, status_id) VALUES ('run', 't1', 'req-1')").run()
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-rs-db-"))
    db = new Database(join(dir, "db.sqlite"))
    db.pragma("foreign_keys = ON")
    logs = []
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it("does nothing on a database that never had them", () => {
    expect(retireStatusTables(db, join(dir, ".agentx"), log)).toBe("none")
    expect(logs).toEqual([])
    expect(existsSync(join(dir, ".agentx"))).toBe(false)
  })

  it("drops them when they are empty, and writes no file", () => {
    makeOld()
    expect(retireStatusTables(db, join(dir, ".agentx"), log)).toBe("dropped")
    expect(tables().filter((t) => (STATUS_TABLES as readonly string[]).includes(t))).toEqual([])
    expect(existsSync(join(dir, ".agentx"))).toBe(false)
    expect(logs.join("\n")).toContain("removed")
  })

  it("exports the rows to a file under .agentx, then drops them", () => {
    makeOld()
    addRow()
    const agentxDir = join(dir, ".agentx")
    expect(retireStatusTables(db, agentxDir, log)).toBe("exported")
    expect(tables().filter((t) => (STATUS_TABLES as readonly string[]).includes(t))).toEqual([])
    const files = readdirSync(agentxDir).filter((f) => f.startsWith("request-status-export-"))
    expect(files).toHaveLength(1)
    const saved = JSON.parse(readFileSync(join(agentxDir, files[0]), "utf-8"))
    expect(saved.tables.request_status).toHaveLength(1)
    expect(saved.tables.request_status[0].id).toBe("req-1")
    expect(saved.tables.request_status_refs).toEqual([{ kind: "run", ref: "t1", status_id: "req-1" }])
    expect(saved.tables.request_status_waits).toEqual([])
    expect(logs.join("\n")).toContain(files[0])
  })

  it("keeps the tables and says why when the rows cannot be exported", () => {
    makeOld()
    addRow()
    // A file where the folder should be: nothing can be written there.
    const blocked = join(dir, "blocked")
    writeFileSync(blocked, "")
    expect(retireStatusTables(db, join(blocked, ".agentx"), log)).toBe("kept")
    expect(tables()).toEqual(expect.arrayContaining([...STATUS_TABLES]))
    expect(db.prepare("SELECT COUNT(*) AS n FROM request_status").get()).toEqual({ n: 1 })
    expect(logs.join("\n")).toMatch(/kept/i)
  })

  it("is done once: a second start finds nothing", () => {
    makeOld()
    addRow()
    mkdirSync(join(dir, ".agentx"))
    retireStatusTables(db, join(dir, ".agentx"), log)
    expect(retireStatusTables(db, join(dir, ".agentx"), log)).toBe("none")
  })
})
