import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  buildRulesBlock, cronKind, namedAgents, parseRegistry, parseScope, ruleId, rulesCheck, rulesForRun,
  wallProjectsOf, RULES_BLOCK_HEADER, type RunFacts, type RuleRow,
} from "../src/agents/rules-registry"
import { buildAgentContext } from "../src/agents/context"
import { injectedContextOf, boundInjectedContext } from "../src/agents/injected-context"
import { parseInjectedContext } from "../src/storage/traces"

// noqta#809: each run gets the Rules Registry rows that fit it.

const PAGE = readFileSync(join(__dirname, "fixtures", "rules-registry-page.md"), "utf-8")

const AGENTS = [
  { id: "marketing-agent", name: "Nadia" },
  { id: "pm-agent", name: "Hakim" },
  { id: "devops-agent", name: "DevOps" },
  { id: "cx-agent", name: "CX" },
  { id: "agentx-channel", name: "AgentX Channel" },
  { id: "dev-session", name: "Dev Session" },
  { id: "coder", name: "Coder" },
]

const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  agentId: "dev-session", nodeName: "MacBook-Local", projects: [], scheduled: false, ...over,
})
const ids = (rows: RuleRow[]) => rows.map((r) => r.id)
const FLEET = ["keep-things-moving-fleet-rule-decision", "every-new-issue-is-complete-when-it-is-created",
  "workflow-changes-are-built-inside-the-existing", "team-words-are-the-standard-for-everyone",
  "open-every-reply-to-the-owner-with-its-subject", "no-guessed-times", "R4", "R5",
  "a-schedule-wakes-an-agent-it-never-runs-a-script"]

describe("parseScope", () => {
  it("reads bare kinds, kind:value with spaces, and ';' between terms", () => {
    expect(parseScope("fleet").terms).toEqual([{ kind: "fleet" }])
    expect(parseScope(" team ").terms).toEqual([{ kind: "team" }])
    expect(parseScope("mesh : Clawd Server").terms).toEqual([{ kind: "mesh", value: "Clawd Server" }])
    expect(parseScope("project:Channel One; project:Channel Two").terms).toEqual([
      { kind: "project", value: "Channel One" }, { kind: "project", value: "Channel Two" },
    ])
    expect(parseScope("run:Weekly").terms).toEqual([{ kind: "run", value: "weekly" }])
  })
  it("refuses commas, unknown kinds, unknown run kinds and empty cells, with a reason", () => {
    expect(parseScope("channel: A, B").error).toMatch(/comma/)
    expect(parseScope("channel:A").error).toMatch(/unknown kind/)
    expect(parseScope("run:hourly").error).toMatch(/unknown run kind/)
    expect(parseScope("").error).toMatch(/empty/)
    expect(parseScope("fleet;").error).toMatch(/empty term/)
  })
})

describe("ruleId", () => {
  it("takes the first bold Rn anywhere in the Rule cell, else a slug of the title", () => {
    expect(ruleId("**R4** No due time", "No due time")).toBe("R4")
    expect(ruleId("Weekly score (see **R8**) and **R9**", "Weekly score")).toBe("R8")
    expect(ruleId("Clean up before done", "Clean up before done")).toBe("clean-up-before-done")
  })
})

describe("the live page (fixture mirrors 2026-11-20, 21 rows)", () => {
  const rows = parseRegistry(PAGE)

  it("has 0 unparsed rows: 20 sent to runs, 1 about people", () => {
    const c = rulesCheck(rows)
    expect(rows).toHaveLength(21)
    expect(c.unparsed.map((r) => `${r.id}: ${r.error}`)).toEqual([])
    expect(c.sent).toHaveLength(20)
    expect(ids(c.people)).toEqual(["planner-block-tracking"])
  })

  it("reaches each agent as the v2 table says, row by row", () => {
    // A plain Mac run of an agent no row names: fleet + the Mac row.
    expect(ids(rulesForRun(rows, run(), AGENTS)).sort()).toEqual([...FLEET, "clean-up-before-reporting-done"].sort())
    // Nadia on the Mac: + R1 R2 R6 (project rows that name her). Not R3 (not a daily run), not R7 (DevOps).
    expect(ids(rulesForRun(rows, run({ agentId: "marketing-agent" }), AGENTS))).toEqual(
      expect.arrayContaining(["R1", "R2", "R6"]))
    expect(ids(rulesForRun(rows, run({ agentId: "marketing-agent" }), AGENTS))).not.toContain("R3")
    expect(ids(rulesForRun(rows, run({ agentId: "marketing-agent" }), AGENTS))).not.toContain("R7")
    // DevOps: R7 only of the channel rows.
    const devops = ids(rulesForRun(rows, run({ agentId: "devops-agent" }), AGENTS))
    expect(devops).toContain("R7")
    expect(devops).not.toContain("R1")
    // Hakim: his two agent rows; the Saber-type row by agent:pm-agent.
    const pm = ids(rulesForRun(rows, run({ agentId: "pm-agent" }), AGENTS))
    expect(pm).toEqual(expect.arrayContaining(["team-member-whatsapp-writing-rule", "the-owner-s-word-comes-first"]))
    expect(pm).not.toContain("R8") // not a weekly run
    // CX: the writing row, not the pm-agent-only one.
    const cx = ids(rulesForRun(rows, run({ agentId: "cx-agent" }), AGENTS))
    expect(cx).toContain("team-member-whatsapp-writing-rule")
    expect(cx).not.toContain("the-owner-s-word-comes-first")
    // The publish row reaches agentx-channel only.
    expect(ids(rulesForRun(rows, run({ agentId: "agentx-channel" }), AGENTS))).toContain("youtube-publish-approval-rule")
    expect(ids(rulesForRun(rows, run(), AGENTS))).not.toContain("youtube-publish-approval-rule")
    // clawd: fleet + its own mesh row, not the Mac row.
    const clawd = ids(rulesForRun(rows, run({ nodeName: "Clawd Server" }), AGENTS))
    expect(clawd).toContain("decision-add-verifiable-success-criteria-rule-to")
    expect(clawd).not.toContain("clean-up-before-reporting-done")
    // The people row never reaches a run.
    for (const a of AGENTS) expect(ids(rulesForRun(rows, run({ agentId: a.id }), AGENTS))).not.toContain("planner-block-tracking")
  })

  it("R8 reaches pm-agent's weekly run, not marketing-agent's (Applies to + Scope)", () => {
    const weekly = { scheduled: true, cronSpec: "0 8 * * 1" }
    expect(ids(rulesForRun(rows, run({ agentId: "pm-agent", ...weekly }), AGENTS))).toContain("R8")
    expect(ids(rulesForRun(rows, run({ agentId: "marketing-agent", ...weekly }), AGENTS))).not.toContain("R8")
  })

  it("R3 reaches marketing-agent's daily run only", () => {
    const daily = { scheduled: true, cronSpec: "0 6 * * *" }
    expect(ids(rulesForRun(rows, run({ agentId: "marketing-agent", ...daily }), AGENTS))).toContain("R3")
    expect(ids(rulesForRun(rows, run({ agentId: "pm-agent", ...daily }), AGENTS))).not.toContain("R3")
  })

  it("a rule removed from the page stops being sent on the next run", () => {
    const without = PAGE.split("\n").filter((l) => !l.includes("**R4**")).join("\n")
    expect(ids(rulesForRun(parseRegistry(PAGE), run(), AGENTS))).toContain("R4")
    expect(ids(rulesForRun(parseRegistry(without), run(), AGENTS))).not.toContain("R4")
  })
})

describe("matching details", () => {
  it("reads agent names as whole words in any case, ignoring prose", () => {
    expect(namedAgents("Nadia asks, the owner approves", AGENTS)).toEqual(["marketing-agent"])
    expect(namedAgents("CX, Hakim (messages to a team member)", AGENTS)).toEqual(["pm-agent", "cx-agent"])
    expect(namedAgents("everyone", AGENTS)).toEqual([])
    expect(namedAgents("clawd agents", AGENTS)).toEqual([])
    expect(namedAgents("nadiaX", AGENTS)).toEqual([])
    expect(namedAgents("devops", AGENTS)).toEqual(["devops-agent"])
  })

  it("project: also fits a run the wall projects put there", () => {
    const rows = parseRegistry("| Rule | Scope | Applies to |\n|---|---|---|\n| Post daily | project:Channel One | the channel team |")
    expect(rulesForRun(rows, run(), AGENTS)).toHaveLength(0)
    expect(rulesForRun(rows, run({ projects: ["Channel One"] }), AGENTS)).toHaveLength(1)
  })

  it("wallProjectsOf counts every matching entry, by agent, repo or workspace", () => {
    const entries = [
      { name: "Channel One", agents: ["marketing-agent"] },
      { name: "Channel Two", agents: ["marketing-agent"] },
      { name: "Site", repos: ["group/site"] },
      { name: "Ws", workspaces: ["/w/ws"] },
    ]
    expect(wallProjectsOf(entries, { agentId: "marketing-agent" })).toEqual(["Channel One", "Channel Two"])
    expect(wallProjectsOf(entries, { agentId: "x", repo: "group/site" })).toEqual(["Site"])
    expect(wallProjectsOf(entries, { agentId: "x", workspace: "/w/ws/sub" })).toEqual(["Ws"])
    expect(wallProjectsOf(entries, { agentId: "x", workspace: "/w/wsx" })).toEqual([])
    expect(wallProjectsOf(undefined, { agentId: "x" })).toEqual([])
  })

  it("run:workflow and run:schedule", () => {
    const rows = parseRegistry("| Rule | Scope | Applies to |\n|---|---|---|\n| A | run:workflow | |\n| B | run:schedule | |")
    expect(ids(rulesForRun(rows, run(), AGENTS))).toEqual([])
    expect(ids(rulesForRun(rows, run({ workflowRunId: "r1" }), AGENTS))).toEqual(["a"])
    expect(ids(rulesForRun(rows, run({ scheduled: true }), AGENTS))).toEqual(["b"])
  })

  it("cronKind tells daily from weekly", () => {
    expect(cronKind("0 6 * * *")).toBe("daily")
    expect(cronKind("30 9 * * 1-5")).toBe("daily")
    expect(cronKind("0 8 * * 1")).toBe("weekly")
    expect(cronKind("0 8 * * MON")).toBe("weekly")
    expect(cronKind("0 * * * *")).toBeNull()
    expect(cronKind("*/15 * * * *")).toBeNull()
    expect(cronKind("0 6 1 * *")).toBeNull()
    expect(cronKind(undefined)).toBeNull()
    expect(cronKind("every day")).toBeNull()
  })
})

describe("the block", () => {
  it("lists the fitting rules with their ids", () => {
    const rows = rulesForRun(parseRegistry(PAGE), run(), AGENTS)
    const b = buildRulesBlock(rows)
    expect(b.startsWith(RULES_BLOCK_HEADER)).toBe(true)
    expect(b).toContain("- R4: R4 No due time without a check time (decided: owner 2026-11-15)")
    expect(buildRulesBlock([])).toBe("")
  })

  it("fits 40 long rows under its budget and still names every id", () => {
    const long = "x".repeat(600)
    const table = ["| Rule | Scope | Applies to |", "|---|---|---|",
      ...Array.from({ length: 40 }, (_, i) => `| **R${i + 1}** Rule ${i + 1}: ${long} | fleet | everyone |`)].join("\n")
    const b = buildRulesBlock(parseRegistry(table), { maxTokens: 1200 })
    expect(b.length).toBeLessThanOrEqual(1200 * 4)
    for (let i = 1; i <= 40; i++) expect(b).toMatch(new RegExp(`^- R${i}: `, "m"))
    // And the context layer does not cut it.
    const ctx = buildAgentContext({ channel: "api", chatId: "c", message: "hi", rulesBlock: b } as any)
    for (let i = 1; i <= 40; i++) expect(ctx).toMatch(new RegExp(`^- R${i}: `, "m"))
  })

  it("sits ahead of the owner decisions in the context", () => {
    const ctx = buildAgentContext({ channel: "api", chatId: "c", message: "hi", rulesBlock: `${RULES_BLOCK_HEADER}\n- R4: x\n[End rules]`, ownerDecisions: "[Owner decisions — x]\ny" } as any)
    expect(ctx.indexOf(RULES_BLOCK_HEADER)).toBeGreaterThanOrEqual(0)
    expect(ctx.indexOf(RULES_BLOCK_HEADER)).toBeLessThan(ctx.indexOf("[Owner decisions"))
  })
})

describe("trace ids", () => {
  it("records the rule ids only when the block reached the prompt, and reads them back", () => {
    const withBlock = injectedContextOf(`${RULES_BLOCK_HEADER}\n- R4: x`, { rules: ["R4", "R5"] })
    expect(withBlock.rules).toEqual(["R4", "R5"])
    expect(injectedContextOf("no block", { rules: ["R4"] }).rules).toBeUndefined()
    const stored = JSON.stringify(boundInjectedContext(withBlock))
    expect(parseInjectedContext(stored)?.rules).toEqual(["R4", "R5"])
    expect(parseInjectedContext(JSON.stringify({ memory: [], procedures: [], wiki: false }))?.rules).toBeUndefined()
  })
})
