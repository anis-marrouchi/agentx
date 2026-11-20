import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { improveConfigSchema } from "../src/daemon/config"
import { AgentMemory } from "../src/agents/agent-memory"
import { recordSignal } from "../src/improve/signals"
import { byRank, groupKey, groupSignals, normalizeDetail, type SignalGroup } from "../src/improve/rank"
import { spentToday } from "../src/improve/budget"
import { improvePass } from "../src/improve/nightly"
import {
  RULE_BUDGET, RULE_PREFIX, checkRuleText, listRules, pickRetire, readRuleLog,
  ruleEligible, ruleRetiredNote, ruleStage, rulesReport, type RuleCheck,
} from "../src/improve/rules"

// #1996: the nightly pass turns each agent's worst group into one rule in
// its memory, at most 3 per agent. A 4th retires one; a rule whose signal
// did not fall, or whose owner signals rose, is retired.

const DAY = 86_400_000
const T0 = Date.parse("2026-11-01T02:00:00Z")
const ON = { ...improveConfigSchema.parse(undefined), enabled: true, dailyUsd: 10 }
const OFF = { ...ON, enabled: false }
const AGENT = "builder"
const WORDS = ["build", "deploy", "report", "backup"] as const
const detailOf = (w: string) => `${w} job ended quiet`
const keyOf = (w: string) => groupKey("job_stalled", AGENT, normalizeDetail("job_stalled", detailOf(w)))

let tmp: string
let db: Database.Database
let memory: AgentMemory

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-improve-rules-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
  memory = new AgentMemory({ baseDir: tmp })
})

afterEach(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

let seq = 0
/** `n` job_stalled rows of one group, each on its own run, from `at`. */
function stalls(w: string, n: number, at: number) {
  for (let i = 0; i < n; i++) recordSignal(db, { kind: "job_stalled", agentId: AGENT, ref: `run-${w}-${seq++}`, detail: detailOf(w) }, at + i * 60_000)
}

function owner(n: number, at: number) {
  for (let i = 0; i < n; i++) recordSignal(db, { kind: "owner_reopened", agentId: AGENT, ref: `req-o${seq++}`, detail: "not done" }, at + i * 60_000)
}

function groupsOf(...words: string[]): SignalGroup[] {
  const keys = new Set(words.map(keyOf))
  return groupSignals(db, 0).filter((g) => keys.has(g.key)).sort(byRank)
}

/** A model that writes one good rule per group, named after its pattern. */
const goodCall = async (input: string) => {
  const w = String(JSON.parse(input).pattern).split(" ")[0]
  return { text: `Before ending a ${w} run, state the job's status in one line.`, usd: 0.01 }
}

async function addRule(w: string, at: number) {
  return ruleStage({ db, memory, groups: groupsOf(w), settings: ON, call: goodCall, now: at, commit: true })
}

describe("the rule text check (C2, D1)", () => {
  const ok = (t: string, kind = "job_stalled", others: string[] = []) => checkRuleText(t, kind, others)

  it("passes a plain imperative rule", () => {
    expect(ok("State the job's status before the run ends.")).toEqual({ ok: true, text: "State the job's status before the run ends." })
  })

  it("passes a lead clause with a lower-case verb after the comma (D1)", () => {
    expect(ok("When a request is reopened, check the proof first.", "owner_reopened").ok).toBe(true)
  })

  it("1. refuses a bad shape: too long, a newline, two sentences, markdown", () => {
    expect(ok(`State the job's status ${"x".repeat(290)}.`)).toMatchObject({ ok: false, check: 1 })
    expect(ok("State the job's status.\nThen stop.")).toMatchObject({ ok: false, check: 1 })
    expect(ok("State the job's status. Then stop.")).toMatchObject({ ok: false, check: 1 })
    expect(ok("State the `job` status before the end.")).toMatchObject({ ok: false, check: 1 })
    expect(ok("State the job's status")).toMatchObject({ ok: false, check: 1 })
  })

  it("2. refuses a sentence that names no behaviour", () => {
    expect(ok("The job status matters a lot for the owner.")).toMatchObject({ ok: false, check: 2 })
  })

  it("3. refuses vague words", () => {
    expect(ok("State the job status if possible.")).toMatchObject({ ok: false, check: 3 })
  })

  it("4. refuses a rule off the group's topic", () => {
    expect(ok("Write shorter replies to the owner every morning.")).toMatchObject({ ok: false, check: 4 })
  })

  it("5. refuses a rule the agent already holds", () => {
    expect(ok("State the job's status before the run ends.", "job_stalled", ["state the  job's STATUS before the run ends."])).toMatchObject({ ok: false, check: 5 })
  })

  it("refuses 301 characters and accepts 300 (B1)", () => {
    const base = "State the job's status "
    const at = (n: number) => base + "a".repeat(n - base.length - 1) + "."
    expect(at(300)).toHaveLength(300)
    expect(ok(at(300)).ok).toBe(true)
    expect(ok(at(301))).toMatchObject({ ok: false, check: 1 })
  })
})

describe("which groups make rules", () => {
  const g = (kind: string, pattern = "", agentId: string | null = AGENT) => ({ kind, pattern, sample: pattern, agentId }) as unknown as SignalGroup

  it("awareness and Bayan kinds only; cost kinds never", () => {
    expect(ruleEligible(g("job_stalled"))).toBe(true)
    expect(ruleEligible(g("same_work_waited"))).toBe(true)
    expect(ruleEligible(g("callback_repeat_skipped"))).toBe(true)
    expect(ruleEligible(g("job_cost_high"))).toBe(false)
    expect(ruleEligible(g("context_rewrite"))).toBe(false)
    expect(ruleEligible(g("job_stalled", "", null))).toBe(false)
  })

  it("a refused hand-off counts only for missing information (Bayan)", () => {
    expect(ruleEligible(g("handoff_refused", "ask -> helper: budget spent"))).toBe(false)
    expect(ruleEligible(g("handoff_refused", "ask -> helper: missing information"))).toBe(true)
  })
})

describe("the rule in the memory index (B1, D2)", () => {
  it("the rule sentence is the index line, once, under Rules", async () => {
    stalls("build", 3, T0 - DAY)
    await addRule("build", T0)
    memory.save({ agentId: AGENT, type: "feedback", name: "short_replies", description: "Keep replies short.", body: "" })
    memory.save({ agentId: AGENT, type: "user", name: "owner_role", description: "The owner runs the shop.", body: "" })
    const index = memory.indexMarkdown(AGENT, 0)
    const name = `${RULE_PREFIX}${keyOf("build")}`
    expect(index).toContain(`- **${name}** — Before ending a build run, state the job's status in one line.`)
    expect(index.split(`**${name}**`)).toHaveLength(2)
    expect(index.indexOf("## Rules")).toBeGreaterThan(-1)
    expect(index.indexOf("## Rules")).toBeLessThan(index.indexOf("## User"))
    expect(index.indexOf(name)).toBeLessThan(index.indexOf("## Feedback"))
  })

  it("3 full rules survive the index cap; the cut note counts the others", () => {
    for (let i = 0; i < 20; i++) memory.save({ agentId: AGENT, type: "project", name: `fact_${i}`, description: `A project fact number ${i} that takes some room in the index.`, body: "" })
    const rule = (w: string) => `State the ${w} job's status ${"z".repeat(300 - 25 - w.length)}.`
    for (const w of ["build", "deploy", "report"]) {
      expect(rule(w).length).toBeLessThanOrEqual(300)
      memory.save({ agentId: AGENT, type: "feedback", name: `${RULE_PREFIX}${w}`, description: rule(w), body: "" })
    }
    const index = memory.indexMarkdown(AGENT, 2000)
    expect(index.length).toBeLessThanOrEqual(2000)
    for (const w of ["build", "deploy", "report"]) expect(index).toContain(rule(w))
    const shown = (index.match(/^- \*\*fact_/gm) ?? []).length
    expect(shown).toBeLessThan(20)
    expect(index).toContain(`_(${20 - shown} more memories not shown here`)
  })

  it("a rule with : and \" survives save and re-read", () => {
    const text = `Before a hand-off, say "done: yes" or "done: no".`
    memory.save({ agentId: AGENT, type: "feedback", name: `${RULE_PREFIX}quote`, description: text, body: "" })
    expect(new AgentMemory({ baseDir: tmp }).get(AGENT, `${RULE_PREFIX}quote`)!.description).toBe(text)
  })
})

describe("ruleStage: adding rules", () => {
  it("an agent with no rules takes one, with its signal in the body", async () => {
    stalls("build", 3, T0 - DAY)
    const r = await addRule("build", T0)
    expect(r.outcomes).toEqual([expect.objectContaining({ agentId: AGENT, result: "added", key: keyOf("build") })])
    const rules = listRules(memory, AGENT)
    expect(rules).toHaveLength(1)
    expect(rules[0].text).toBe("Before ending a build run, state the job's status in one line.")
    expect(rules[0].signal).toMatchObject({ key: keyOf("build"), kinds: ["job_stalled"], addedAt: T0, before: 3 })
    expect(readRuleLog(db, { agentId: AGENT }).map((l) => l.action)).toEqual(["add"])
  })

  it("books the call as stage rule", async () => {
    stalls("build", 3, T0 - DAY)
    await addRule("build", T0)
    expect(spentToday(db, T0 + 1).calls.rule).toBe(1)
  })

  it("does nothing while improve.enabled is off", async () => {
    stalls("build", 3, T0 - DAY)
    let called = 0
    const r = await ruleStage({ db, memory, groups: groupsOf("build"), settings: OFF, call: async () => { called++; return { text: "x", usd: 0 } }, now: T0, commit: true })
    expect(called).toBe(0)
    expect(r.why).toMatch(/improve.enabled is off/)
    expect(listRules(memory, AGENT)).toHaveLength(0)
    expect(spentToday(db, T0 + 1).usd).toBe(0)
  })

  it("does not call past improve.dailyUsd", async () => {
    stalls("build", 3, T0 - DAY)
    let called = 0
    const r = await ruleStage({ db, memory, groups: groupsOf("build"), settings: { ...ON, dailyUsd: 0.05 }, call: async () => { called++; return { text: "x", usd: 0 } }, now: T0, commit: true })
    expect(called).toBe(0)
    expect(r.outcomes[0]).toMatchObject({ result: "skipped" })
  })

  it("a refused reply saves nothing, is logged, and still counts its spend", async () => {
    stalls("build", 3, T0 - DAY)
    const r = await ruleStage({ db, memory, groups: groupsOf("build"), settings: ON, call: async () => ({ text: "Be careful with jobs.", usd: 0.02 }), now: T0, commit: true })
    expect(r.outcomes[0]).toMatchObject({ result: "refused" })
    expect(listRules(memory, AGENT)).toHaveLength(0)
    const log = readRuleLog(db, { agentId: AGENT })
    expect(log).toEqual([expect.objectContaining({ action: "refused", key: keyOf("build") })])
    expect(log[0].reason).toMatch(/^check \d/)
    expect(spentToday(db, T0 + 1).calls.rule).toBe(1)
  })

  it("a refused 301-char reply writes nothing", async () => {
    stalls("build", 3, T0 - DAY)
    await ruleStage({ db, memory, groups: groupsOf("build"), settings: ON, call: async () => ({ text: `State the build job's status ${"a".repeat(271)}.`, usd: 0 }), now: T0, commit: true })
    expect(memory.list(AGENT)).toHaveLength(0)
  })

  it("a group already covered by a rule gets no second rule", async () => {
    stalls("build", 3, T0 - DAY)
    await addRule("build", T0)
    let called = 0
    await ruleStage({ db, memory, groups: groupsOf("build"), settings: ON, call: async (i) => { called++; return goodCall(i) }, now: T0 + DAY, commit: true })
    expect(called).toBe(0)
    expect(listRules(memory, AGENT)).toHaveLength(1)
  })

  it("a preview writes nothing", async () => {
    stalls("build", 3, T0 - DAY)
    const r = await ruleStage({ db, memory, groups: groupsOf("build"), settings: ON, call: goodCall, now: T0, commit: false })
    expect(r.why).toMatch(/preview/)
    expect(listRules(memory, AGENT)).toHaveLength(0)
  })
})

describe("ruleStage: the budget of 3", () => {
  beforeEach(() => { for (const w of WORDS) stalls(w, 3, T0 - 2 * DAY) })

  it("adding a 4th retires the rule at 0 the longest", async () => {
    await addRule("build", T0)
    await addRule("deploy", T0 + DAY)
    await addRule("report", T0 + 2 * DAY)
    // build's signal came back after it was added; deploy has been at 0
    // since its add (2 days), report since its add (1 day).
    stalls("build", 1, T0 + 2.5 * DAY)
    const r = await addRule("backup", T0 + 3 * DAY)
    expect(r.outcomes[0]).toMatchObject({ result: "added", retired: keyOf("deploy") })
    expect(listRules(memory, AGENT).map((x) => x.signal.key).sort()).toEqual([keyOf("build"), keyOf("report"), keyOf("backup")].sort())
    const retire = readRuleLog(db, { agentId: AGENT }).find((l) => l.action === "retire")!
    expect(retire).toMatchObject({ key: keyOf("deploy") })
    expect(retire.reason).toMatch(/budget/)
    // The retired text stays in the memory's history.
    expect(memory.versions(AGENT, `${RULE_PREFIX}${keyOf("deploy")}`).length).toBeGreaterThan(0)
  })

  it("when none is at 0, the oldest goes", async () => {
    await addRule("build", T0)
    await addRule("deploy", T0 + DAY)
    await addRule("report", T0 + 2 * DAY)
    for (const w of ["build", "deploy", "report"]) stalls(w, 1, T0 + 2.8 * DAY)
    const r = await addRule("backup", T0 + 3 * DAY)
    expect(r.outcomes[0]).toMatchObject({ result: "added", retired: keyOf("build") })
    expect(listRules(memory, AGENT)).toHaveLength(RULE_BUDGET)
  })

  it("pickRetire: at 0 longest, else oldest", () => {
    const c = (key: string, addedAt: number, zeroSince: number | null) => ({ key, addedAt, zeroSince }) as unknown as RuleCheck
    const now = 10 * DAY
    expect(pickRetire([c("a", 1 * DAY, null), c("b", 2 * DAY, 3 * DAY), c("c", 3 * DAY, 5 * DAY)], now).key).toBe("b")
    expect(pickRetire([c("a", 1 * DAY, null), c("b", 2 * DAY, null), c("c", 3 * DAY, null)], now).key).toBe("a")
  })
})

describe("ruleStage: held or retired after 7 days (C1)", () => {
  beforeEach(() => { stalls("build", 3, T0 - 2 * DAY) })

  it("a rule whose signal did not fall is retired, and the retirement is logged", async () => {
    await addRule("build", T0)
    stalls("build", 3, T0 + DAY)
    const r = await ruleStage({ db, memory, groups: [], settings: ON, call: goodCall, now: T0 + 8 * DAY, commit: true })
    expect(r.outcomes).toContainEqual(expect.objectContaining({ result: "retired", key: keyOf("build") }))
    expect(listRules(memory, AGENT)).toHaveLength(0)
    const retire = readRuleLog(db, { agentId: AGENT }).find((l) => l.action === "retire")!
    expect(retire.reason).toBe("signal did not fall 3→3")
  })

  it("a rule whose signal fell is kept, logged once", async () => {
    await addRule("build", T0)
    stalls("build", 1, T0 + DAY)
    await ruleStage({ db, memory, groups: [], settings: ON, call: goodCall, now: T0 + 8 * DAY, commit: true })
    await ruleStage({ db, memory, groups: [], settings: ON, call: goodCall, now: T0 + 9 * DAY, commit: true })
    expect(listRules(memory, AGENT)).toHaveLength(1)
    expect(readRuleLog(db, { agentId: AGENT }).filter((l) => l.action === "keep")).toHaveLength(1)
  })

  it("is not judged before the 7 days are over", async () => {
    await addRule("build", T0)
    stalls("build", 5, T0 + DAY)
    await ruleStage({ db, memory, groups: [], settings: ON, call: goodCall, now: T0 + 3 * DAY, commit: true })
    expect(listRules(memory, AGENT)).toHaveLength(1)
  })

  it("owner signals up by 1 (1→2): kept", async () => {
    owner(1, T0 - DAY)
    await addRule("build", T0)
    owner(2, T0 + DAY)
    await ruleStage({ db, memory, groups: [], settings: ON, call: goodCall, now: T0 + 8 * DAY, commit: true })
    expect(listRules(memory, AGENT)).toHaveLength(1)
  })

  it("owner signals up by 2 (1→3): retired, both counts in the reason", async () => {
    owner(1, T0 - DAY)
    await addRule("build", T0)
    recordSignal(db, { kind: "owner_check_mismatch", agentId: AGENT, ref: "req-m1", detail: "x" }, T0 + DAY)
    owner(2, T0 + 2 * DAY)
    await ruleStage({ db, memory, groups: [], settings: ON, call: goodCall, now: T0 + 8 * DAY, commit: true })
    expect(listRules(memory, AGENT)).toHaveLength(0)
    expect(readRuleLog(db, { agentId: AGENT }).find((l) => l.action === "retire")!.reason).toBe("owner signals rose 1→3")
  })
})

describe("who sees it", () => {
  it("rulesReport lists each agent's rules and its last retirements", async () => {
    stalls("build", 3, T0 - 2 * DAY)
    await addRule("build", T0)
    stalls("build", 3, T0 + DAY)
    await ruleStage({ db, memory, groups: [], settings: ON, call: goodCall, now: T0 + 8 * DAY, commit: true })
    stalls("deploy", 3, T0 + 7 * DAY)
    await addRule("deploy", T0 + 8 * DAY + 1000)
    const rep = rulesReport(db, memory, T0 + 9 * DAY)
    expect(rep).toHaveLength(1)
    expect(rep[0].agentId).toBe(AGENT)
    expect(rep[0].rules.map((r) => r.key)).toEqual([keyOf("deploy")])
    expect(rep[0].rules[0]).toMatchObject({ text: expect.stringContaining("deploy"), verdict: "waiting", before: 3 })
    expect(rep[0].retired.map((l) => l.key)).toEqual([keyOf("build")])
    expect(rulesReport(db, memory, T0 + 9 * DAY, "someone-else")).toEqual([])
  })

  it("a retirement shows on the next card about the same problem", async () => {
    stalls("build", 3, T0 - 2 * DAY)
    await addRule("build", T0)
    stalls("build", 3, T0 + DAY)
    await ruleStage({ db, memory, groups: [], settings: ON, call: goodCall, now: T0 + 8 * DAY, commit: true })
    expect(ruleRetiredNote(db, [keyOf("build")])).toMatch(/rule .* was retired .*signal did not fall 3→3/)
    expect(ruleRetiredNote(db, ["other"])).toBeUndefined()
  })

  it("the nightly pass runs the rule stage when given the agent memory", async () => {
    stalls("build", 3, T0 - 3600_000)
    const r = await improvePass({ db, since: T0 - DAY, commit: true, settings: ON, call: (input) => goodCall(input), rules: { memory }, now: T0 })
    expect(r.rules?.outcomes).toContainEqual(expect.objectContaining({ result: "added", key: keyOf("build") }))
    expect(listRules(memory, AGENT)).toHaveLength(1)
  })
})
