import { describe, it, expect } from "vitest"
import { getLedgerMode, isLedgerActive, parseLedgerMode } from "../src/intent/mode"
import type { IntentSource } from "../src/intent/types"

// Tests for Phase 1 commit 4 — mode flag plumbing.
//
// The function is pure (env: ProcessEnv) → mode, so every test passes a
// hand-crafted env object rather than mutating process.env. Keeps the
// test deterministic and avoids accidental cross-test bleed.

const ALL_SOURCES: IntentSource[] = ["telegram", "gitlab", "github", "workflow", "cron", "mesh"]

describe("parseLedgerMode", () => {
  it("accepts the three documented values", () => {
    expect(parseLedgerMode("off")).toBe("off")
    expect(parseLedgerMode("shadow")).toBe("shadow")
    expect(parseLedgerMode("authoritative")).toBe("authoritative")
  })

  it("is case-insensitive", () => {
    expect(parseLedgerMode("OFF")).toBe("off")
    expect(parseLedgerMode("Shadow")).toBe("shadow")
    expect(parseLedgerMode("AUTHORITATIVE")).toBe("authoritative")
  })

  it("trims surrounding whitespace", () => {
    expect(parseLedgerMode("  shadow  ")).toBe("shadow")
    expect(parseLedgerMode("\tshadow\n")).toBe("shadow")
  })

  it("returns null for unset / invalid / non-string values — caller defaults to off", () => {
    expect(parseLedgerMode(undefined)).toBeNull()
    expect(parseLedgerMode("")).toBeNull()
    expect(parseLedgerMode("on")).toBeNull()
    expect(parseLedgerMode("yes")).toBeNull()
    expect(parseLedgerMode("true")).toBeNull()
    expect(parseLedgerMode("1")).toBeNull()
    expect(parseLedgerMode(1)).toBeNull()
    expect(parseLedgerMode(null)).toBeNull()
  })
})

describe("getLedgerMode resolution order", () => {
  it("defaults to 'off' when nothing is set", () => {
    for (const source of ALL_SOURCES) {
      expect(getLedgerMode(source, {})).toBe("off")
    }
  })

  it("global env var applies to all sources when no per-source override is set", () => {
    const env = { INTENT_LEDGER_MODE: "shadow" }
    for (const source of ALL_SOURCES) {
      expect(getLedgerMode(source, env)).toBe("shadow")
    }
  })

  it("per-source env var beats global — the staged-rollout primitive", () => {
    // The point of the per-source override: in 1c, the operator promotes
    // gitlab to "authoritative" while everything else stays "shadow".
    const env = {
      INTENT_LEDGER_MODE: "shadow",
      INTENT_LEDGER_MODE_GITLAB: "authoritative",
    }
    expect(getLedgerMode("gitlab", env)).toBe("authoritative")
    expect(getLedgerMode("telegram", env)).toBe("shadow")
    expect(getLedgerMode("workflow", env)).toBe("shadow")
    expect(getLedgerMode("cron", env)).toBe("shadow")
    expect(getLedgerMode("mesh", env)).toBe("shadow")
    expect(getLedgerMode("github", env)).toBe("shadow")
  })

  it("each source has its own env var — no shared naming collision", () => {
    const env = {
      INTENT_LEDGER_MODE_TELEGRAM: "off",
      INTENT_LEDGER_MODE_GITLAB: "shadow",
      INTENT_LEDGER_MODE_GITHUB: "shadow",
      INTENT_LEDGER_MODE_WORKFLOW: "authoritative",
      INTENT_LEDGER_MODE_CRON: "off",
      INTENT_LEDGER_MODE_MESH: "shadow",
    }
    expect(getLedgerMode("telegram", env)).toBe("off")
    expect(getLedgerMode("gitlab", env)).toBe("shadow")
    expect(getLedgerMode("github", env)).toBe("shadow")
    expect(getLedgerMode("workflow", env)).toBe("authoritative")
    expect(getLedgerMode("cron", env)).toBe("off")
    expect(getLedgerMode("mesh", env)).toBe("shadow")
  })

  it("invalid global value falls through to the default ('off') — operator typo cannot accidentally activate", () => {
    expect(getLedgerMode("gitlab", { INTENT_LEDGER_MODE: "yes" })).toBe("off")
    expect(getLedgerMode("gitlab", { INTENT_LEDGER_MODE: "ON" })).toBe("off")
    expect(getLedgerMode("gitlab", { INTENT_LEDGER_MODE: "" })).toBe("off")
  })

  it("invalid per-source value falls through to global — partial typo doesn't break the whole rollout", () => {
    const env = {
      INTENT_LEDGER_MODE: "shadow",
      INTENT_LEDGER_MODE_GITLAB: "actv", // typo for "authoritative"
    }
    expect(getLedgerMode("gitlab", env)).toBe("shadow")
    expect(getLedgerMode("telegram", env)).toBe("shadow")
  })

  it("case-insensitive resolution at every level", () => {
    expect(getLedgerMode("gitlab", { INTENT_LEDGER_MODE: "SHADOW" })).toBe("shadow")
    expect(
      getLedgerMode("gitlab", {
        INTENT_LEDGER_MODE: "off",
        INTENT_LEDGER_MODE_GITLAB: "Authoritative",
      }),
    ).toBe("authoritative")
  })

  it("explicit 'off' at the per-source level demotes one source while others stay active — used during 1c rollback drills", () => {
    const env = {
      INTENT_LEDGER_MODE: "authoritative",
      INTENT_LEDGER_MODE_TELEGRAM: "off", // pull telegram back if it misbehaves
    }
    expect(getLedgerMode("telegram", env)).toBe("off")
    expect(getLedgerMode("gitlab", env)).toBe("authoritative")
  })

  it("uses process.env when no env arg is supplied", () => {
    // We don't mutate process.env in tests — just confirm the default-arg
    // path doesn't crash. Whatever production env happens to be is fine.
    expect(() => getLedgerMode("gitlab")).not.toThrow()
    const mode = getLedgerMode("gitlab")
    expect(["off", "shadow", "authoritative"]).toContain(mode)
  })
})

describe("isLedgerActive", () => {
  it("returns false only when mode is 'off'", () => {
    expect(isLedgerActive("gitlab", {})).toBe(false)
    expect(isLedgerActive("gitlab", { INTENT_LEDGER_MODE: "off" })).toBe(false)
    expect(isLedgerActive("gitlab", { INTENT_LEDGER_MODE: "shadow" })).toBe(true)
    expect(isLedgerActive("gitlab", { INTENT_LEDGER_MODE: "authoritative" })).toBe(true)
  })
})
