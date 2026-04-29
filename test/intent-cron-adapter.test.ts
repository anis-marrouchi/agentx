import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import {
  buildCronEventInput,
  buildCronPolicyFromLegacy,
  recordCronDispatch,
  type CronJobProjection,
} from "../src/intent/sources/cron"

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-cron-adapter-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const sampleJob: CronJobProjection = {
  jobId: "marketing-daily-brief",
  agentId: "nadia",
  firedAt: new Date(1714400000000),
}

describe("buildCronEventInput", () => {
  it("normalizes per-(jobId, firedAt.ms) sourceEventId; subject scopes per-job", () => {
    const input = buildCronEventInput(sampleJob, "{}", () => 1714400000000)
    expect(input).toEqual({
      ts: 1714400000000,
      source: "cron",
      sourceEventId: "marketing-daily-brief:1714400000000",
      project: null,
      subject: "cron:marketing-daily-brief",
      intent: "cron.fired",
      rawJson: "{}",
    })
  })

  it("two fires of the same job at different times yield distinct sourceEventIds", () => {
    const a = buildCronEventInput({ ...sampleJob, firedAt: new Date(1) }, "{}", () => 1)
    const b = buildCronEventInput({ ...sampleJob, firedAt: new Date(2) }, "{}", () => 2)
    expect(a.sourceEventId).not.toBe(b.sourceEventId)
  })
})

describe("buildCronPolicyFromLegacy", () => {
  it("decidedBy is the stable string 'cron-scheduler'", () => {
    expect(
      buildCronPolicyFromLegacy({ outcome: "dispatched", agentId: "x" }).decidedBy,
    ).toBe("cron-scheduler")
  })

  it("dispatched legacy → policy returns dispatched verbatim", () => {
    const decided = buildCronPolicyFromLegacy({
      outcome: "dispatched", agentId: "nadia", reason: null,
    }).decide({} as any)
    expect(decided).toEqual({ agentId: "nadia", outcome: "dispatched", reason: null })
  })

  it("hook-blocked → halted with reason", () => {
    const decided = buildCronPolicyFromLegacy({
      outcome: "halted", agentId: null, reason: "pre-hook blocked: maintenance window",
    }).decide({} as any)
    expect(decided.outcome).toBe("halted")
    expect(decided.reason).toMatch(/maintenance window/)
  })
})

describe("recordCronDispatch", () => {
  it("records event + decision; agreement → no divergence", () => {
    recordCronDispatch(
      ledger, sampleJob, "{}",
      { agentId: "nadia", outcome: "dispatched", reason: null },
      () => 1,
    )
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(1)
    expect(ledger.getDivergences()).toHaveLength(0)
  })

  it("re-fire of same (jobId, firedAt.ms) is idempotent (one event, one decision)", () => {
    for (let i = 0; i < 3; i++) {
      recordCronDispatch(
        ledger, sampleJob, "{}",
        { agentId: "nadia", outcome: "dispatched", reason: null },
        () => 1 + i,
      )
    }
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(1)
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }).n,
    ).toBe(1)
  })

  it("project=null disables active-task safety: successive fires both dispatch (matches legacy)", () => {
    recordCronDispatch(
      ledger, { ...sampleJob, firedAt: new Date(1) }, "{}",
      { agentId: "nadia", outcome: "dispatched", reason: null },
      () => 1,
    )
    recordCronDispatch(
      ledger, { ...sampleJob, firedAt: new Date(2) }, "{}",
      { agentId: "nadia", outcome: "dispatched", reason: null },
      () => 2,
    )
    expect(ledger.getDivergences()).toHaveLength(0)
  })
})
