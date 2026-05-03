import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import {
  getDefaultLedger,
  resetLedgerForTesting,
  setLedgerForTesting,
} from "../src/intent/instance"

// Tests for Phase 1 commit 6.0 — daemon-singleton accessor.
//
// The function is process-global state, so we drop the reference in
// afterEach to keep cases independent.

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-instance-"))
})

afterEach(() => {
  resetLedgerForTesting()
  rmSync(tmp, { recursive: true, force: true })
})

describe("getDefaultLedger", () => {
  it("constructs a ledger lazily on first call", () => {
    const ledger = getDefaultLedger({ path: path.join(tmp, "ledger.sqlite") })
    expect(ledger).toBeInstanceOf(IntentLedger)
    expect(ledger.schemaVersion()).toBe(2)
    ledger.close()
  })

  it("is idempotent — repeated calls return the same handle", () => {
    const a = getDefaultLedger({ path: path.join(tmp, "ledger.sqlite") })
    const b = getDefaultLedger({ path: path.join(tmp, "ledger.sqlite") })
    expect(b).toBe(a)
    a.close()
  })

  it("path option only affects the first call — later calls return the cached singleton regardless", () => {
    const a = getDefaultLedger({ path: path.join(tmp, "first.sqlite") })
    // Passing a different path doesn't construct a second ledger; the
    // singleton ignores the option.
    const b = getDefaultLedger({ path: path.join(tmp, "second.sqlite") })
    expect(b).toBe(a)
    expect(a.path.endsWith("first.sqlite")).toBe(true)
    a.close()
  })
})

describe("setLedgerForTesting / resetLedgerForTesting", () => {
  it("setLedgerForTesting replaces the singleton with the supplied instance", () => {
    const injected = new IntentLedger({ path: path.join(tmp, "injected.sqlite") })
    setLedgerForTesting(injected)
    expect(getDefaultLedger()).toBe(injected)
    injected.close()
  })

  it("resetLedgerForTesting clears the cached reference so the next caller constructs fresh", () => {
    const a = new IntentLedger({ path: path.join(tmp, "a.sqlite") })
    setLedgerForTesting(a)
    expect(getDefaultLedger()).toBe(a)
    a.close()
    resetLedgerForTesting()

    const b = getDefaultLedger({ path: path.join(tmp, "b.sqlite") })
    expect(b).not.toBe(a)
    b.close()
  })
})
