import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite.js"

const columns = (db: Database.Database) =>
  (db.prepare("PRAGMA table_info(task_traces)").all() as Array<{ name: string }>).map((c) => c.name)

describe("lesson impact columns (#98)", () => {
  afterEach(() => closeDb())

  it("reach a database whose version number was taken by another branch", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentx-98-")), "db.sqlite")
    let db = openDb({ path })!
    expect(columns(db)).toEqual(expect.arrayContaining(["num_turns", "injected_context"]))

    // Another branch recorded later versions without our columns.
    db.exec(`
      ALTER TABLE task_traces DROP COLUMN num_turns;
      ALTER TABLE task_traces DROP COLUMN injected_context;
      INSERT INTO schema_version (v) VALUES (14), (15);
    `)
    closeDb()

    db = openDb({ path })!
    expect(columns(db)).toEqual(expect.arrayContaining(["num_turns", "injected_context"]))
    closeDb()
    expect(() => openDb({ path })).not.toThrow()
  })
})
