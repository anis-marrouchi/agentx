import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { execSync } from "child_process"
import { resolve } from "path"
import { IntentLedger } from "../src/intent/ledger"
import { recordRouterDispatch } from "../src/intent/sources/router"
import { recordGitLabTargetDispatch } from "../src/intent/sources/gitlab"

// End-to-end-ish tests for the `agentx ledger` triage CLI. We populate a
// tmp ledger, then shell out to `node dist/cli.js ledger ...` and assert
// the JSON output. Skips when dist/ isn't built.

let tmp: string
let ledgerPath: string
let cliExists: boolean

const cliPath = resolve(__dirname, "..", "dist", "cli.js")

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-ledger-cli-"))
  ledgerPath = path.join(tmp, "ledger.sqlite")
  cliExists = (() => {
    try {
      execSync(`test -f ${cliPath}`)
      return true
    } catch { return false }
  })()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function run(args: string): string {
  return execSync(`node ${cliPath} ledger ${args} --path ${ledgerPath} --cwd ${tmp} --json`, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function populateLedger(): void {
  const ledger = new IntentLedger({ path: ledgerPath })
  // 1 telegram dispatch (agreement)
  recordRouterDispatch(
    ledger,
    { id: "msg-1", channel: "telegram", accountId: "default", sender: { id: "user-1" } },
    "telegram", "{}",
    { agentId: "mtgl-v2", outcome: "dispatched", reason: "mention" },
    () => 1714400000000,
  )
  // 1 telegram dedup (divergence: legacy=deduped vs ledger=halted)
  recordRouterDispatch(
    ledger,
    { id: "msg-2", channel: "telegram", accountId: "default", sender: { id: "user-2" } },
    "telegram", "{}",
    { agentId: null, outcome: "deduped", reason: "isDuplicateMessage" },
    () => 1714400001000,
  )
  // 1 gitlab issue dispatch
  recordGitLabTargetDispatch(
    ledger,
    { entityKind: "issue", project: "noqta/web", iid: 1, action: "open", title: "x", description: "", url: "u" },
    { agentId: "mtgl-v2", trigger: "assignee-added" },
    "{}",
    { agentId: "mtgl-v2", outcome: "dispatched" },
    () => 1714400002000,
  )
  ledger.close()
}

describe("agentx ledger CLI", () => {
  it("stats reports events by source, divergences, decisions", () => {
    if (!cliExists) return
    populateLedger()
    const out = JSON.parse(run("stats"))
    const bySource = Object.fromEntries(out.eventsBySource.map((r: any) => [r.source, r.n]))
    expect(bySource.telegram).toBe(2)
    expect(bySource.gitlab).toBe(1)
    expect(out.totalDecisions).toBe(3)
    expect(out.totalDivergences).toBe(1)
    expect(out.inFlight).toBe(2) // 2 dispatched, 0 resolved → 2 active
    const divBySource = Object.fromEntries(out.divergencesBySource.map((r: any) => [r.source, r.n]))
    expect(divBySource.telegram).toBe(1)
  })

  it("divergences --source filters by source", () => {
    if (!cliExists) return
    populateLedger()
    const all = JSON.parse(run("divergences"))
    expect(all.length).toBe(1)
    expect(all[0].source).toBe("telegram")

    const gitlab = JSON.parse(run("divergences --source gitlab"))
    expect(gitlab.length).toBe(0)
  })

  it("active lists in-flight dispatched decisions", () => {
    if (!cliExists) return
    populateLedger()
    const active = JSON.parse(run("active"))
    expect(active.length).toBe(2)
    const sources = active.map((r: any) => r.source).sort()
    expect(sources).toEqual(["gitlab", "telegram"])
  })

  it("active --source filters", () => {
    if (!cliExists) return
    populateLedger()
    const active = JSON.parse(run("active --source gitlab"))
    expect(active.length).toBe(1)
    expect(active[0].source).toBe("gitlab")
  })

  it("events lists rows with --source filter", () => {
    if (!cliExists) return
    populateLedger()
    const tg = JSON.parse(run("events --source telegram"))
    expect(tg.length).toBe(2)
    for (const row of tg) expect(row.source).toBe("telegram")
  })

  it("graceful when ledger missing", () => {
    if (!cliExists) return
    // No populateLedger() call — ledger file doesn't exist
    expect(() => run("stats")).toThrow()
  })

  it("--since accepts duration strings (1h, 7d, etc)", () => {
    if (!cliExists) return
    populateLedger()
    // All events were at 1714400000000-2000 ms (~Apr 2024). With --since 1h,
    // they'd all be filtered out (current ts >> events ts + 1h).
    const old = JSON.parse(run("events --since 1h"))
    expect(old.length).toBe(0)
  })

  it("replay reports 0 divergences for a clean populated ledger", () => {
    if (!cliExists) return
    populateLedger()
    const out = JSON.parse(run("replay"))
    expect(out.eventsCount).toBe(3)
    expect(out.decisionsCount).toBe(3)
    expect(out.divergences).toEqual([])
  })

  it("replay --source filters the events that get replayed", () => {
    if (!cliExists) return
    populateLedger()
    const tg = JSON.parse(run("replay --source telegram"))
    expect(tg.eventsCount).toBe(2)
    expect(tg.decisionsCount).toBe(2)
    expect(tg.divergences).toEqual([])
  })
})
