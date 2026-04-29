import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"

// Schema-only smoke tests for Phase 1 commit 1. The ledger has no read/write
// API yet — these tests pin the constructor + DDL contract. Read/write tests
// land alongside the API in commit 2.

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-intent-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function open() {
  return new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
}

describe("IntentLedger schema", () => {
  it("creates the database file in the workspace path", () => {
    const ledger = open()
    expect(existsSync(ledger.path)).toBe(true)
    ledger.close()
  })

  it("reports the current schema version after first open", () => {
    const ledger = open()
    // Bumped to 2 in commit 5 with the intent_divergences table. Any new
    // migration appends to runMigrations and bumps this number — never
    // mutate an existing migration body.
    expect(ledger.schemaVersion()).toBe(2)
    ledger.close()
  })

  it("re-opening an existing ledger does not roll the version backward", () => {
    // Migrations are idempotent; constructing twice must not duplicate the
    // schema_version row or change the reported version.
    const a = open()
    a.close()
    const b = open()
    expect(b.schemaVersion()).toBe(2)
    b.close()
  })

  it("creates the four core tables", () => {
    const ledger = open()
    const tables = (ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>)
      .map((r) => r.name)
    // schema_version is bookkeeping; the four ledger tables are the
    // append-only records this phase commits to.
    expect(tables).toContain("intent_events")
    expect(tables).toContain("intent_decisions")
    expect(tables).toContain("intent_resolutions")
    expect(tables).toContain("intent_divergences")
    expect(tables).toContain("schema_version")
    ledger.close()
  })

  it("intent_events has the documented column set", () => {
    const ledger = open()
    const cols = (ledger.db
      .prepare("PRAGMA table_info(intent_events)")
      .all() as Array<{ name: string; notnull: number; pk: number }>)
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(Object.keys(byName).sort()).toEqual([
      "id", "intent", "project", "raw_json", "source", "source_event_id", "subject", "ts",
    ])
    expect(byName.id.pk).toBe(1)
    expect(byName.id.notnull).toBe(1)
    expect(byName.ts.notnull).toBe(1)
    expect(byName.source.notnull).toBe(1)
    expect(byName.raw_json.notnull).toBe(1)
    ledger.close()
  })

  it("intent_decisions has composite primary key (event_id, decided_by)", () => {
    const ledger = open()
    const cols = (ledger.db
      .prepare("PRAGMA table_info(intent_decisions)")
      .all() as Array<{ name: string; pk: number }>)
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort()
    expect(pkCols).toEqual(["decided_by", "event_id"])
    ledger.close()
  })

  it("creates the dedup-critical indices", () => {
    const ledger = open()
    const indices = (ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_intent%' ORDER BY name")
      .all() as Array<{ name: string }>)
      .map((r) => r.name)
    // (project, subject) is the active-task lookup the dispatcher will
    // hit on every event; (source, source_event_id) is the idempotency
    // check for re-deliveries.
    expect(indices).toContain("idx_intent_events_subject")
    expect(indices).toContain("idx_intent_events_source_event_id")
    ledger.close()
  })

  it("foreign keys are enforced — decision without event must fail", () => {
    const ledger = open()
    expect(() =>
      ledger.db.prepare(
        "INSERT INTO intent_decisions (event_id, decided_at, decided_by, agent_id, outcome, reason) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("ghost-event", 1, "tester", null, "halted", "no parent"),
    ).toThrow(/FOREIGN KEY/)
    ledger.close()
  })

  it("intent_divergences has the documented columns and composite FK", () => {
    const ledger = open()
    const cols = (ledger.db
      .prepare("PRAGMA table_info(intent_divergences)")
      .all() as Array<{ name: string; pk: number; notnull: number }>)
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(Object.keys(byName).sort()).toEqual([
      "decided_by", "event_id", "id", "ledger_agent_id", "ledger_outcome",
      "ledger_reason", "legacy_agent_id", "legacy_outcome", "legacy_reason",
      "source", "ts",
    ])
    expect(byName.id.pk).toBe(1)
    expect(byName.ts.notnull).toBe(1)
    expect(byName.source.notnull).toBe(1)
    expect(byName.ledger_outcome.notnull).toBe(1)
    expect(byName.legacy_outcome.notnull).toBe(1)

    // Composite FK to intent_decisions(event_id, decided_by) — divergence
    // cannot exist without its ledger-side decision.
    expect(() =>
      ledger.db.prepare(
        `INSERT INTO intent_divergences (id, ts, source, event_id, decided_by,
           ledger_agent_id, ledger_outcome, ledger_reason,
           legacy_agent_id, legacy_outcome, legacy_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("div-1", 1, "gitlab", "ghost-event", "no-such-decider", null, "halted", null, null, "halted", null),
    ).toThrow(/FOREIGN KEY/)
    ledger.close()
  })
})
