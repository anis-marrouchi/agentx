import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { workflowHealth, scanRuns, type RunSummary } from "../src/daemon/workflow-health"
import { MONITOR_SCRIPT, renderMonitorPage } from "../src/daemon/ui/pages/monitor"

const NOW = Date.UTC(2026, 8, 6)
const DAY = 86_400_000
const run = (workflowId: string, daysAgo: number, status = "completed"): RunSummary =>
  ({ workflowId, status, at: NOW - daysAgo * DAY })

describe("workflow health", () => {
  it("reports a workflow that stopped firing, which nothing else would mention", () => {
    // The real case: ksi-mr-review fired 26 times, then went silent for 3 days.
    const runs = [...Array(26)].map((_, i) => run("ksi-mr-review", 8 + (i % 6)))
    const [h] = workflowHealth([{ id: "ksi-mr-review", name: "MR review" }], runs, NOW)
    expect(h.state).toBe("dormant")
    expect(h.prior).toBeGreaterThan(0)
    expect(h.recent).toBe(0)
    expect(h.lastRunAt).toBe(NOW - 8 * DAY)
  })

  it("ranks silence above failure, and both above healthy traffic", () => {
    const health = workflowHealth(
      [{ id: "quiet" }, { id: "broken" }, { id: "fine" }, { id: "unused" }],
      [
        run("quiet", 9), run("quiet", 10),
        run("broken", 1, "failed"), run("broken", 2, "failed"), run("broken", 3),
        run("fine", 1), run("fine", 2), run("fine", 3),
      ], NOW)
    expect(health.map(h => [h.id, h.state])).toEqual([
      ["quiet", "dormant"], ["broken", "failing"], ["fine", "active"], ["unused", "never"],
    ])
  })

  it("does not call a workflow failing when only a minority of runs failed", () => {
    const runs = [run("w", 1, "failed"), run("w", 2), run("w", 3), run("w", 4)]
    expect(workflowHealth([{ id: "w" }], runs, NOW)[0].state).toBe("active")
  })

  it("counts runs parked at a checkpoint separately from failures", () => {
    const runs = [run("w", 1, "paused"), run("w", 2)]
    const [h] = workflowHealth([{ id: "w" }], runs, NOW)
    expect(h).toMatchObject({ state: "active", paused: 1, failed: 0 })
  })

  it("reads workflow id and terminal status without replaying the whole run", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-runs-"))
    try {
      const file = join(dir, "r1.jsonl")
      writeFileSync(file, [
        JSON.stringify({ v: 2, kind: "snapshot", run: { id: "r1", workflowId: "ksi-mr-review", status: "running" } }),
        JSON.stringify({ v: 2, kind: "exec", runId: "r1", entry: {}, pending: [] }),
        JSON.stringify({ v: 2, kind: "exec", runId: "r1", entry: {}, pending: [], status: "failed" }),
      ].join("\n") + "\n")
      const when = new Date(NOW - DAY)
      utimesSync(file, when, when)
      expect(scanRuns(dir)).toEqual([{ workflowId: "ksi-mr-review", status: "failed", at: NOW - DAY }])
      // A truncated or unreadable run must never take the whole scan down.
      writeFileSync(join(dir, "bad.jsonl"), "{not json")
      expect(scanRuns(dir).map(r => r.workflowId)).toEqual(["ksi-mr-review"])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("gives the monitor page somewhere to report it, and stays parseable", () => {
    expect(renderMonitorPage()).toContain('id="automation"')
    expect(MONITOR_SCRIPT).toContain("renderAutomation")
    // The block must render nothing when every workflow is healthy, so the
    // overview stays compact on a normal day.
    expect(MONITOR_SCRIPT).toContain("if(!rows.length){$('automation').innerHTML='';return;}")
    expect(() => new Function(MONITOR_SCRIPT)).not.toThrow()
  })
})
