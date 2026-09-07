import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd } from "../src/storage/traces"
import { SessionMonitor, parseReview, commitmentKey, REVIEW_PROMPT } from "../src/daemon/session-monitor"
import { MONITOR_SCRIPT, renderMonitorPage } from "../src/daemon/ui/pages/monitor"

let dir: string
beforeEach(() => { closeDb(); dir = mkdtempSync(join(tmpdir(), "monitor-test-")) })
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }) })
const result = { summary: "Completed the change; needs deployment approval.", warnings: [], actions: [{ text: "Approve deployment", evidence: "Awaiting approval", when: "now", minutes: 5, effort: "low", needsHuman: true }], decisions: [], friction: [], context: [], links: [], relatedTaskIds: [] }
function fixture(reviewer = vi.fn(async () => JSON.stringify(result))) {
  const db = openDb({ path: join(dir, "db.sqlite") })!
  return { db, reviewer, monitor: new SessionMonitor(db, reviewer) }
}
describe("session monitor", () => {
  it("reviews each ended trace once, preserving evidence and rejecting invented relations", async () => {
    const { db, reviewer, monitor } = fixture(vi.fn(async () => JSON.stringify({ ...result, relatedTaskIds: ["invented"] })))
    recordTraceStart(db, { agentId: "dev", channel: "cli", chatId: "chat", messagePreview: "Ship it" }, "task1")
    await monitor.tick()
    expect(reviewer).not.toHaveBeenCalled()
    recordTraceEnd(db, "task1", { status: "ok", finalResponse: "Awaiting approval" })
    await monitor.tick(); await monitor.tick()
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(JSON.parse(reviewer.mock.calls[0][0]).task.finalResponse).toBe("Awaiting approval")
    expect(monitor.snapshot().reviews[0].result.relatedTaskIds).toEqual([])
    expect(monitor.snapshot().reviews[0].status).toBe("ready")
    expect((db.prepare("SELECT input FROM session_reviews").get() as any).input).toBe("")
  })
  it("persists failed reviews and retries explicitly without a retry storm", async () => {
    const reviewer = vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValue(JSON.stringify(result))
    const { monitor, db } = fixture(reviewer)
    monitor.register({ id: "s", runtime: "gemini", label: "Research" })
    monitor.ended({ sessionId: "s", runId: "r", transcript: "Awaiting approval" })
    await monitor.tick(); await monitor.tick()
    expect(reviewer).toHaveBeenCalledTimes(1)
    const id = monitor.snapshot().reviews[0].id
    const restarted = new SessionMonitor(db, reviewer)
    restarted.retry(id); await restarted.tick()
    expect(restarted.snapshot().reviews[0].status).toBe("ready")
    restarted.action({ reviewId: id, index: 0, state: "later" })
    expect(restarted.snapshot().actionStates).toMatchObject([{ state: "later" }])
    expect(() => restarted.action({ reviewId: id, index: 9, state: "done" })).toThrow()
  })
  it("requires registration, deduplicates stop hooks, and bounds external input", async () => {
    const { monitor, reviewer } = fixture()
    const event = { sessionId: "s", runId: "r", transcript: "Ended" }
    expect(() => monitor.ended(event)).toThrow(/Register/)
    monitor.register({ id: "s", runtime: "other", label: "External" })
    monitor.ended(event); monitor.ended(event)
    await monitor.tick()
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(() => monitor.ended({ ...event, transcript: "x".repeat(100001) })).toThrow()
  })
  it("rejects malformed model output and unsafe link protocols", () => {
    expect(() => parseReview('{"summary":"pretend success"}')).toThrow()
    const review = parseReview(JSON.stringify({ ...result, links: [{ label: "bad", url: "javascript:alert(1)" }, { label: "good", url: "https://example.com/task" }, { label: "relative", url: "/task/1" }] }))
    expect(review.links).toHaveLength(2)
  })
  it("does not backfill history before monitor installation", async () => {
    const { monitor, db, reviewer } = fixture()
    recordTraceStart(db, { agentId: "dev", channel: "cli", chatId: "s" }, "old")
    recordTraceEnd(db, "old", { status: "ok" })
    db.prepare("UPDATE task_traces SET finished_at=1 WHERE task_id='old'").run()
    await monitor.tick()
    expect(reviewer).not.toHaveBeenCalled()
  })
})

describe("cost of delay", () => {
  it("puts the client who is actually waiting above work with no clock", async () => {
    const { rankByDecay, decayOf } = await import("../src/daemon/monitor-capacity")
    const now = Date.UTC(2026, 8, 7)
    const hour = 3600_000
    const clocks = { hasanah: 240, noqta: undefined }
    const list = [
      { needsHuman: true, clientId: "noqta", updatedAt: now - 200 * hour },   // ancient, but nobody waits
      { needsHuman: true, clientId: "hasanah", updatedAt: now - 2 * hour },   // inside the clock
      { needsHuman: true, clientId: "hasanah", updatedAt: now - 9 * hour },   // past the clock
    ]
    expect(rankByDecay(list, clocks, now)).toEqual([2, 1, 0])
    expect(decayOf(list[2], clocks, now)).toMatchObject({ rising: true, overdue: true })
    expect(decayOf(list[1], clocks, now)).toMatchObject({ rising: true, overdue: false })
    expect(decayOf(list[0], clocks, now)).toMatchObject({ rising: false, overdue: false })
  })

  it("keeps the order stable when nothing distinguishes two actions", async () => {
    const { rankByDecay } = await import("../src/daemon/monitor-capacity")
    const now = Date.now()
    const same = { needsHuman: true, clientId: "x", updatedAt: now }
    expect(rankByDecay([same, same, same], {}, now)).toEqual([0, 1, 2])
  })

  it("ships ordering to the browser with every helper it calls", async () => {
    const { rankByDecay, decayOf } = await import("../src/daemon/monitor-capacity")
    const { injectFns } = await import("../src/daemon/ui/inject")
    // new Function() cannot see this module, so a helper or constant left
    // behind is a ReferenceError here exactly as it would be in the browser.
    const src = injectFns({ decayOf, rankByDecay })
    const order = new Function(src + `return rankByDecay([
      {needsHuman:true,clientId:"flat",updatedAt:0},
      {needsHuman:true,clientId:"clocked",updatedAt:9000000}
    ],{clocked:240},10000000)`)()
    expect(order).toEqual([1, 0])
  })

  it("drops actions nobody touched, so the list stays a working set", async () => {
    const { db, monitor } = fixture()
    const day = 86_400_000
    const mk = (id: string, ageDays: number) =>
      db.prepare("INSERT INTO session_reviews (id,session_id,agent,source,status,updated_at,model,input,result) VALUES (?,?,?,'trace','ready',?,?,'',?)")
        .run(id, "s" + id, "atlas", Date.now() - ageDays * day, "opus", JSON.stringify(result))
    mk("fresh", 0)
    mk("stale", 30)
    const ids = monitor.openActions().items.map(a => a.reviewId)
    expect(ids).toContain("fresh")
    // Still in the database and still in its review — just not competing for
    // attention on a page whose whole job is "what needs me now".
    expect(ids).not.toContain("stale")
    expect(db.prepare("SELECT COUNT(*) AS n FROM session_reviews").get()).toEqual({ n: 2 })
  })

  it("does not review a scheduled job that worked", async () => {
    const { db, reviewer, monitor } = fixture()
    recordTraceStart(db, { agentId: "atlas", channel: "cron", chatId: "cron:nightly", messagePreview: "nightly" }, "ok-cron")
    recordTraceEnd(db, "ok-cron", { status: "ok", finalResponse: "done" })
    recordTraceStart(db, { agentId: "atlas", channel: "cron", chatId: "cron:nightly", messagePreview: "nightly" }, "bad-cron")
    recordTraceEnd(db, "bad-cron", { status: "error", finalResponse: "boom" })
    await monitor.tick(); await monitor.tick()
    // Nobody is waiting on a cron that succeeded; its failure is another matter.
    expect(db.prepare("SELECT id FROM session_reviews ORDER BY id").all()).toEqual([{ id: "bad-cron" }])
  })

  it("asks the reviewer for at most two actions, and for a strict needsHuman", () => {
    expect(REVIEW_PROMPT).toContain("AT MOST 2 actions")
    expect(REVIEW_PROMPT).toContain("needsHuman is true ONLY when no agent could do it")
  })

  it("can clear the whole backlog without losing the reviews", async () => {
    const { db, monitor } = fixture()
    for (const id of ["a", "b", "c"]) {
      db.prepare("INSERT INTO session_reviews (id,session_id,agent,source,status,updated_at,model,input,result) VALUES (?,?,?,'trace','ready',?,?,'',?)")
        .run(id, "s" + id, "atlas", Date.now(), "opus", JSON.stringify(result))
    }
    expect(monitor.openActions().total).toBe(3)
    expect(monitor.clearOpenActions()).toBe(3)
    expect(monitor.openActions().total).toBe(0)
    // Findings are evidence, not to-dos: clearing the list keeps them.
    expect(db.prepare("SELECT COUNT(*) AS n FROM session_reviews").get()).toEqual({ n: 3 })
    expect(monitor.snapshot().reviews).toHaveLength(3)
  })

  it("touches no element the page does not render", () => {
    // new Function() proves the script parses, not that it can run: a renamed
    // container leaves $('old-id') returning null and the whole script aborts
    // at load, which is how the briefing went blank after the bucket rewrite.
    const html = renderMonitorPage()
    const missing = [...new Set([...MONITOR_SCRIPT.matchAll(/\$\('([a-zA-Z0-9_-]+)'\)/g)].map(m => m[1]))]
      .filter(id => !html.includes(`id="${id}"`))
    expect(missing).toEqual([])
  })

  it("renders the three buckets and ships syntactically valid browser code", () => {
    expect(renderMonitorPage()).toContain("Only you")
    expect(renderMonitorPage()).toContain("Agents can handle")
    expect(() => new Function(MONITOR_SCRIPT)).not.toThrow()
  })
})

describe("external hooks and action retention", () => {
  it("only watches registered sessions and deduplicates hook delivery per turn", async () => {
    const { monitor, reviewer } = fixture()
    monitor.externalStop("unknown", "Secret response")
    expect(monitor.snapshot().reviews).toHaveLength(0)
    monitor.register({ id: "native", runtime: "claude", label: "Editor" })
    monitor.externalPrompt("native", "Prepare the release")
    monitor.externalStop("native", "Awaiting approval")
    monitor.externalStop("native", "Awaiting approval")
    await monitor.tick()
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(reviewer.mock.calls[0][0]).toContain("Prepare the release")
    monitor.externalPrompt("native", "Try again")
    monitor.externalStop("native", "Awaiting approval")
    await monitor.tick()
    expect(reviewer).toHaveBeenCalledTimes(2)
  })
  it("keeps open commitments beyond the recent-review limit and filters completed actions", async () => {
    const { monitor, db } = fixture()
    for (let i = 0; i < 105; i++) db.prepare("INSERT INTO session_reviews (id,session_id,agent,source,status,updated_at,model,input,result) VALUES (?,?,?,'external','ready',?,'opus','',?)").run(String(i), "s", "dev", Date.now() - i, JSON.stringify(result))
    expect(monitor.snapshot().reviews).toHaveLength(100)
    expect(monitor.openActions().total).toBe(105)
    monitor.action({ reviewId: "0", index: 0, state: "done" })
    expect(monitor.openActions().total).toBe(104)
    expect(monitor.openActions().items.some(a => a.reviewId === "0")).toBe(false)
  })
  it("recovers a review interrupted by daemon restart", async () => {
    const { monitor, db, reviewer } = fixture()
    monitor.register({ id: "s", runtime: "opencode", label: "Editor" })
    monitor.ended({ sessionId: "s", runId: "r", transcript: "Finished" })
    db.prepare("UPDATE session_reviews SET status='reviewing'").run()
    const restarted = new SessionMonitor(db, reviewer)
    await restarted.tick()
    expect(restarted.snapshot().reviews[0].status).toBe("ready")
  })
})

describe("monitor upload bounds", () => {
  it("rejects oversized and malformed payloads before storage", async () => {
    const { PassThrough } = await import("stream")
    const { readMonitorBody } = await import("../src/daemon/session-monitor")
    const oversized = new PassThrough()
    const first = expect(readMonitorBody(oversized as any)).rejects.toThrow(/512 KB/)
    oversized.end(Buffer.alloc(513 * 1024)); await first
    const malformed = new PassThrough()
    const second = expect(readMonitorBody(malformed as any)).rejects.toThrow(/Invalid/)
    malformed.end('[]'); await second
  })
})

describe("CLI discovery", () => {
  it("recognizes native and Node launchers without returning private arguments", async () => {
    const { parseCliProcesses } = await import("../src/daemon/session-monitor")
    const stamp = "Sat Sep  5 23:00:00 2026"
    const processes = parseCliProcesses(`1 ${stamp} /usr/local/bin/claude -p PRIVATE\n2 ${stamp} node /usr/lib/node_modules/@google/gemini-cli/dist/index.js PRIVATE\n3 ${stamp} node /opt/bin/codex.js PRIVATE\n4 ${stamp} /usr/bin/zsh -c echo claude`)
    expect(processes.map(p => p.runtime)).toEqual(["claude", "gemini", "codex"])
    expect(JSON.stringify(processes)).not.toContain("PRIVATE")
  })
})

describe("cross-mesh monitor authentication", () => {
  it("uses mesh credentials for configured and discovered nodes without mutating dashboard tokens", async () => {
    const { monitorTargets } = await import("../src/daemon/session-monitor")
    const nodes = [{ url: "http://primary:18800", token: "local" }, { url: "http://peer:19900", token: "dashboard-only" }, { url: "http://discovered:19900" }]
    const resolved = monitorTargets(nodes, [{ url: "http://peer:19900/", token: "mesh" }, { url: "http://discovered:19900", token: "peer-mesh" }])
    expect(resolved.map(n => n.token)).toEqual(["local", "mesh", "peer-mesh"])
    expect(nodes[1].token).toBe("dashboard-only")
  })
})

// Every string below is a real action text taken from the clawd node's review
// queue, where 107 open actions covered roughly 20 distinct jobs.
describe("commitment key", () => {
  it("collapses the same job re-derived by different sessions", () => {
    const rotate = [
      "Rotate the GitLab PAT 'glpat-REDACTED' and move it into an environment variable or secret store",
      "Rotate the GitLab PAT glpat-REDACTED and move it into an environment variable",
      "Rotate the GitLab PAT that appears in plaintext in the task trace, and move it into an environment v",
      "Revoke the GitLab token glpat-REDACTED in gitlab.noqta.tn user settings, issue a replacement",
    ].map(commitmentKey)
    expect(new Set(rotate).size).toBe(1)

    const merge64 = [
      "Review and merge MR !64 in hasanah-lab/hasanah-v1; issue #94 is reopened at Status::Review",
      "Review and merge MR !64 into development to land the remaining #94 work",
      "Review and merge MR !64 for issue #94 (internal report from Testing list dropdown)",
    ].map(commitmentKey)
    expect(new Set(merge64).size).toBe(1)
    expect(merge64[0]).toBe("merge:mr:64")

    const close94 = [
      "Tick the acceptance-criteria checkboxes on issue #94 that !64 satisfies (dropdown, read-only worksheet)",
      "After !64 merges, tick the #94 acceptance criteria and move the issue Status::Review to Status::Done",
    ].map(commitmentKey)
    expect(new Set(close94).size).toBe(1)
    expect(close94[0]).toBe("close:issue:94")
  })

  it("keeps different jobs on the same entity apart", () => {
    // Sharing an entity is not sharing a job: these are three separate asks.
    expect(new Set([
      commitmentKey("Review and merge MR !64 into development"),
      commitmentKey("Spot-check MR !64 against the #94 acceptance criteria that were not explicitly confirmed"),
      commitmentKey("Decide merge order between !67 and !64 and tell the agent which to rebase"),
    ]).size).toBe(3)
    expect(commitmentKey("Cancel or reconcile the duplicate running task on issue #94")).toBe("cleanup:issue:94")
    expect(commitmentKey("Re-dispatch issue #94 to the coding agent so the work actually starts")).toBe("rerun:issue:94")
  })

  it("never merges unrelated actions that carry no entity", () => {
    expect(commitmentKey("Add webhook deduplication by commit SHA"))
      .not.toBe(commitmentKey("Add sample_number to the internal-report print label"))
  })

  it("ships the key with every open action so peers can group across sessions", async () => {
    const { db, monitor } = fixture()
    for (const [i, text] of ["Rotate the GitLab PAT glpat-x", "Rotate the GitLab PAT in the trace"].entries()) {
      db.prepare("INSERT INTO session_reviews (id,session_id,agent,source,status,updated_at,model,input,result) VALUES (?,?,?,?,'ready',?,?,'',?)")
        .run(String(i), `s${i}`, "atlas", "trace", Date.now() - i, "opus",
          JSON.stringify({ ...result, actions: [{ ...result.actions[0], text }] }))
    }
    const keys = monitor.openActions().items.map(a => a.key)
    expect(keys).toEqual(["secure:secret", "secure:secret"])
  })
})

describe("review queue scope", () => {
  it("never spends a review on a workflow micro-span, queued or incoming", async () => {
    const { db, reviewer, monitor } = fixture()
    recordTraceStart(db, { agentId: "workflow:mr-fix-loop", channel: "api", chatId: "default", messagePreview: "step" }, "span1")
    recordTraceEnd(db, "span1", { status: "ok", finalResponse: "done" })
    recordTraceStart(db, { agentId: "atlas", channel: "api", chatId: "default", messagePreview: "real work" }, "task1")
    recordTraceEnd(db, "task1", { status: "ok", finalResponse: "done" })
    await monitor.tick(); await monitor.tick()
    expect(db.prepare("SELECT id FROM session_reviews").all()).toEqual([{ id: "task1" }])
    expect(reviewer).toHaveBeenCalledTimes(1)

    // History built before this rule is cleared on the next start: queued rows
    // are never reviewed, and completed ones must stop feeding the action list.
    db.prepare("INSERT INTO session_reviews (id,session_id,agent,source,status,updated_at,model,input) VALUES ('old','s','workflow:absorb','trace','pending',1,'opus','{}')").run()
    db.prepare("INSERT INTO session_reviews (id,session_id,agent,source,status,updated_at,model,input,result) VALUES ('done','s','workflow:absorb','trace','ready',1,'opus','',?)").run(JSON.stringify(result))
    new SessionMonitor(db, reviewer)
    expect(db.prepare("SELECT COUNT(*) AS n FROM session_reviews WHERE agent LIKE 'workflow:%'").get()).toEqual({ n: 0 })
  })
})
