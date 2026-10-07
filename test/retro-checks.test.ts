import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd } from "../src/storage/traces"
import { createCard, decideCard, listCards, readCard, saveCard, verdictMessage } from "../src/approvals/cards"
import type { ApprovalSettings } from "../src/approvals/sweep"
import { approvalsConfigSchema } from "../src/daemon/config"
import { CHECK_CHOICES } from "../src/approvals/origin"
import { listPolicyRules } from "../src/guard/policy"
import { isRetroRun } from "../src/retro/retro"
import {
  checkCard,
  checkFires,
  listRetroChecks,
  recommendFor,
  retroTagOf,
  reviewChecksPass,
  reviewRetroChecks,
} from "../src/retro/checks"

// #743 P2: checks a retro added are tagged; once a month one that fires
// often on good work comes back as a keep / loosen / remove card.

const DAY = 86_400_000
let tmp: string
let db: Database.Database

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-retro-checks-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})

afterEach(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

const settings = (forwardTo?: string) => ({ ...approvalsConfigSchema.parse(undefined), ...(forwardTo ? { forwardTo } : {}) }) as ApprovalSettings

function policy(file: string, body: string) {
  const p = path.join(tmp, ".agentx", "guardrails", file)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, body)
}

const TAGGED = `rules:
  - id: no-stop-without-start
    match: { tool: Bash, command_regex: "launchctl bootout" }
    action: warn
    tags: ["retro:T-deploy"]
  - id: plain-rule
    match: { tool: Bash, command_regex: "rm -rf /" }
    action: deny
`

/** A finished run for `agentId`, started at `at`, lasting a minute. */
function run(taskId: string, agentId: string, status: "ok" | "error", at: number) {
  recordTraceStart(db, { agentId, channel: "telegram", chatId: "ops", messagePreview: "deploy" }, taskId)
  recordTraceEnd(db, taskId, { status, ...(status === "error" ? { error: "failed" } : {}) })
  db.prepare("UPDATE task_traces SET started_at = ?, duration_ms = 60000 WHERE task_id = ?").run(at, taskId)
}

let fireN = 0
function fire(ruleId: string, ts: number, opts: { taskId?: string; agentId?: string } = {}) {
  db.prepare(`INSERT INTO guardrail_decisions (id, ts, agent_id, task_id, tool, command, matched_rule, verdict, effective_action, mode)
    VALUES (?, ?, ?, ?, 'Bash', 'launchctl bootout x', ?, 'warn', 'allow', 'warn')`)
    .run(`d${fireN++}`, ts, opts.agentId ?? "builder", opts.taskId ?? null, ruleId)
}

/** The retro card the rule came from, answered `daysAgo` days ago. */
function answeredRetro(daysAgo: number) {
  const r = createCard(tmp, {
    title: "Daemon left stopped", ask: "What should change so this can't happen again?", recommend: "Script",
    choices: ["Deploy script", "None of these"], if_silent: "discard", raised_by: "builder",
  }, { settings: settings(), origin: { kind: "retro", taskId: "T-deploy", signature: "sig" } })
  if (!r.ok) throw new Error(r.error)
  const d = decideCard(tmp, r.card.id, "yes", { choice: 1, now: Date.now() - daysAgo * DAY })
  if (!d.ok) throw new Error(d.error)
}

describe("finding the checks a retro added", () => {
  it("reads the tag from tags, or from the message", () => {
    expect(retroTagOf({ id: "a", match: {}, action: "warn", preconditions: [], tags: ["ops", "retro:T-1"] })).toBe("T-1")
    expect(retroTagOf({ id: "b", match: {}, action: "warn", preconditions: [], message: "Start it again (retro:T-2)" })).toBe("T-2")
    expect(retroTagOf({ id: "c", match: {}, action: "warn", preconditions: [] })).toBeNull()
  })

  it("lists tagged rules from every policy file, scoped to their agent", () => {
    policy("policy.yaml", TAGGED)
    policy("agents/ops.yaml", `rules:\n  - id: ops-rule\n    match: { tool: Bash }\n    action: warn\n    tags: ["retro:T-ops"]\n`)
    policy("agents/old.yml", `rules:\n  - id: not-live\n    match: { tool: Bash }\n    action: warn\n    tags: ["retro:T-old"]\n`)
    expect(listPolicyRules(tmp).map((e) => e.rule.id)).toEqual(["no-stop-without-start", "plain-rule", "ops-rule"])
    const checks = listRetroChecks(tmp)
    expect(checks.map((c) => [c.rule.id, c.taskId, c.agentId])).toEqual([
      ["no-stop-without-start", "T-deploy", undefined],
      ["ops-rule", "T-ops", "ops"],
    ])
    expect(checks[0].file).toBe(".agentx/guardrails/policy.yaml")
  })
})

describe("measuring a check", () => {
  it("splits fires by how the run ended, matching a run by time when the task id is missing", () => {
    const now = Date.now()
    run("T-good", "builder", "ok", now - 2 * DAY)
    run("T-bad", "builder", "error", now - DAY)
    fire("no-stop-without-start", now - 2 * DAY + 1000, { taskId: "T-good" })
    fire("no-stop-without-start", now - 2 * DAY + 2000) // no task id: inside T-good
    fire("no-stop-without-start", now - DAY + 1000, { taskId: "T-bad" })
    fire("no-stop-without-start", now - 3 * DAY) // no run going on
    fire("no-stop-without-start", now - 40 * DAY, { taskId: "T-good" }) // outside the window
    fire("plain-rule", now - DAY)
    const f = checkFires(db, "no-stop-without-start", now - 30 * DAY)
    expect(f).toEqual({ total: 4, good: 2, failed: 1, unknown: 1, agents: ["builder"] })
  })

  it("compares the agent's runs before and after the retro card was answered", () => {
    policy("policy.yaml", TAGGED)
    answeredRetro(10)
    const now = Date.now()
    for (let i = 0; i < 4; i++) run(`B${i}`, "builder", i < 2 ? "ok" : "error", now - (15 + i) * DAY)
    for (let i = 0; i < 6; i++) run(`A${i}`, "builder", "ok", now - (5 + i * 0.1) * DAY)
    run("other-agent", "ops", "error", now - 5 * DAY)
    for (let i = 0; i < 6; i++) fire("no-stop-without-start", now - (5 + i * 0.1) * DAY + 1000, { taskId: `A${i}` })

    const [r] = reviewRetroChecks(db, tmp, { now })
    expect(r.check.rule.id).toBe("no-stop-without-start")
    expect(r.agents).toEqual(["builder"])
    expect(r.owner).toBe("builder")
    expect(r.before).toMatchObject({ n: 4, successRate: 0.5 })
    expect(r.after).toMatchObject({ n: 6, successRate: 1 })
    expect(r.noisy).toBe(true)
    expect(recommendFor(r).choice).toBe(CHECK_CHOICES.loosen)
  })

  it("recommends removing a check when runs did not go better", () => {
    policy("policy.yaml", TAGGED)
    answeredRetro(10)
    const now = Date.now()
    for (let i = 0; i < 4; i++) run(`B${i}`, "builder", "ok", now - (15 + i) * DAY)
    for (let i = 0; i < 6; i++) run(`A${i}`, "builder", i < 5 ? "ok" : "error", now - (5 + i * 0.1) * DAY)
    for (let i = 0; i < 5; i++) fire("no-stop-without-start", now - (5 + i * 0.1) * DAY + 1000, { taskId: `A${i}` })
    const [r] = reviewRetroChecks(db, tmp, { now })
    expect(recommendFor(r).choice).toBe(CHECK_CHOICES.remove)
  })
})

describe("the monthly pass", () => {
  function noisyCheck(fires = 6) {
    policy("policy.yaml", TAGGED)
    answeredRetro(10)
    const now = Date.now()
    for (let i = 0; i < fires; i++) {
      run(`A${i}`, "builder", "ok", now - (5 + i * 0.1) * DAY)
      fire("no-stop-without-start", now - (5 + i * 0.1) * DAY + 1000, { taskId: `A${i}` })
    }
  }

  it("previews without raising, then raises one card per noisy check", () => {
    noisyCheck()
    const preview = reviewChecksPass({ root: tmp, db, settings: settings() })
    expect(preview.outcomes).toEqual([{ ruleId: "no-stop-without-start", result: "would-raise" }])
    expect(listCards(tmp).filter((c) => c.origin?.kind === "retro-check")).toHaveLength(0)

    const r = reviewChecksPass({ root: tmp, db, settings: settings(), commit: true })
    expect(r.outcomes[0].result).toBe("raised")
    const card = readCard(tmp, (r.outcomes[0] as { cardId: string }).cardId)!
    expect(card.raised_by).toBe("builder")
    expect(card.choices).toEqual(["Keep it", "Loosen it", "Remove it"])
    expect(card.if_silent).toBe("discard")
    expect(card.context).toContain("6 on runs that went well")
    expect(card.context).toContain("before:")
    expect(card.origin).toEqual({ kind: "retro-check", ruleId: "no-stop-without-start", taskId: "T-deploy", file: ".agentx/guardrails/policy.yaml" })
  })

  it("asks about a check at most once in 30 days", () => {
    noisyCheck()
    reviewChecksPass({ root: tmp, db, settings: settings(), commit: true })
    const again = reviewChecksPass({ root: tmp, db, settings: settings(), commit: true })
    expect(again.outcomes[0]).toMatchObject({ result: "skipped" })
    expect((again.outcomes[0] as { why: string }).why).toMatch(/reviewed it on/)

    // An old answered review no longer blocks.
    const old = listCards(tmp).find((c) => c.origin?.kind === "retro-check")!
    saveCard(tmp, { ...old, status: "decided", verdict: "yes", choice: "Keep it", created_at: new Date(Date.now() - 31 * DAY).toISOString() })
    expect(reviewChecksPass({ root: tmp, db, settings: settings() }).outcomes[0].result).toBe("would-raise")
  })

  it("leaves a quiet check alone and respects --min-fires and --max", () => {
    noisyCheck(3)
    expect(reviewChecksPass({ root: tmp, db, settings: settings() }).outcomes).toEqual([])
    expect(reviewChecksPass({ root: tmp, db, settings: settings(), minGoodFires: 3 }).outcomes).toHaveLength(1)
    expect(reviewChecksPass({ root: tmp, db, settings: settings(), minGoodFires: 3, max: 0 }).outcomes).toEqual([])
  })

  it("refuses to raise cards when they would be forwarded", () => {
    noisyCheck()
    const r = reviewChecksPass({ root: tmp, db, settings: settings("hub"), commit: true })
    expect(r.error).toMatch(/forwardTo/)
    expect(r.reviews).toHaveLength(1)
  })
})

describe("the answer", () => {
  function reviewCard() {
    policy("policy.yaml", TAGGED)
    const r = { ...reviewRetroChecks(db, tmp)[0], owner: "builder", agents: ["builder"] }
    const c = createCard(tmp, checkCard(r), { settings: settings(), origin: checkCard(r).origin })
    if (!c.ok) throw new Error(c.error)
    return c.card
  }

  it("tells the agent to open a pull request that loosens or removes the rule", () => {
    const card = reviewCard()
    const loosen = decideCard(tmp, card.id, "yes", { choice: CHECK_CHOICES.loosen })
    if (!loosen.ok) throw new Error(loosen.error)
    const msg = verdictMessage(loosen.card)
    expect(msg).toContain("loosen it")
    expect(msg).toContain("no-stop-without-start")
    expect(msg).toContain("pull request")
    expect(msg).toContain("retro:T-deploy")
    expect(msg).not.toContain("Approved text")
  })

  it("changes nothing on Keep, No or silence", () => {
    const card = reviewCard()
    const keep = decideCard(tmp, card.id, "yes", { choice: CHECK_CHOICES.keep })
    if (!keep.ok) throw new Error(keep.error)
    expect(verdictMessage(keep.card)).toContain("Change nothing")
    expect(verdictMessage({ ...card, status: "decided", verdict: "no" })).toContain("Change nothing")
    expect(verdictMessage({ ...card, status: "expired", outcome: "discard" })).toContain("Change nothing")
  })

  it("never feeds the run that changes the rule back into a retro", () => {
    const card = reviewCard()
    expect(isRetroRun(tmp, { channel: "approvals", chatId: card.id })).toBe(true)
  })
})
