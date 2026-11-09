import { describe, it, expect } from "vitest"
import Database from "better-sqlite3"
import {
  classifyCall,
  classifyFollowUp,
  classifyResult,
  gradingSample,
  questionOf,
  summariseUsage,
  wikiCalls,
  type StepRow,
  type TaskRow,
} from "../../scripts/wiki-query-usage-lib"
import { readLedger } from "../../scripts/wiki-query-report"

// #1820: wiki usage measured from the trace ledger.

const T0 = Date.parse("2026-11-02T09:00:00Z")
const DAY = 86_400_000

const task = (id: string, agent: string, at: number, session: string | null = null): TaskRow =>
  ({ task_id: id, agent_id: agent, started_at: at, session })
const use = (task_id: string, seq: number, action: string, input: unknown): StepRow =>
  ({ task_id, seq, name: "tool_use", action, status: "in-flight", input_summary: JSON.stringify(input), output_summary: null })
const result = (task_id: string, seq: number, text: string, status = "ok"): StepRow =>
  ({ task_id, seq, name: "tool_result", action: null, status, input_summary: null, output_summary: text })

describe("wiki usage from the trace ledger", () => {
  it("tells the query tool, the command, lookup and patch apart", () => {
    expect(classifyCall("mcp__agentx__agentx_wiki_query", "{}")).toBe("tool")
    expect(classifyCall("mcp__agentx__agentx_lookup", "{}")).toBe("lookup")
    expect(classifyCall("mcp__agentx__agentx_wiki_patch", "{}")).toBe("patch")
    expect(classifyCall("Bash", JSON.stringify({ command: 'node /x/cli.js wiki query "who owns billing?" --dir /n/.agentx/wiki' }))).toBe("cli")
    expect(classifyCall("Bash", JSON.stringify({ command: "agentx wiki query-runs" }))).toBeNull()
    expect(classifyCall("Grep", "{}")).toBeNull()
  })

  it("reads the question from either kind of call", () => {
    expect(questionOf("tool", JSON.stringify({ question: "What did we decide on retries?" }))).toBe("What did we decide on retries?")
    expect(questionOf("tool", '{"question":"Who runs deploys?","agent":"a1"')).toBe("Who runs deploys?")
    expect(questionOf("cli", JSON.stringify({ command: 'node cli.js wiki query "How do we tag a release?" --agent a1' }))).toBe("How do we tag a release?")
    expect(questionOf("cli", JSON.stringify({ command: "node cli.js wiki query 'single quoted' --agent a1" }))).toBe("single quoted")
  })

  it("sorts results into answers, no answer and causes of failure", () => {
    expect(classifyResult("Retries back off twice.\n\nCitations (2 articles walked):\n  - x", "ok")).toBe("answer")
    expect(classifyResult('Query returned status "no-candidates"', "ok")).toBe("no-answer")
    expect(classifyResult('Query returned status "error": Selector: claude exited 1: overloaded', "error")).toBe("model-error")
    expect(classifyResult("Error: no agent has a wiki catalog yet. Run `agentx wiki absorb` first.", "error")).toBe("no-catalog")
    expect(classifyResult("Error: ENOTDIR: not a directory, mkdir '/w/agents'\n    at mkdirSync (node:fs:1)", "error")).toBe("crash")
    expect(classifyResult("Command timed out after 2m", "error")).toBe("timeout")
    expect(classifyResult("Permission to use Bash has been denied.", "error")).toBe("denied")
    expect(classifyResult("", "ok")).toBe("empty")
  })

  it("classifies what the agent did next", () => {
    expect(classifyFollowUp("Grep", "{}")).toBe("search")
    expect(classifyFollowUp("Bash", JSON.stringify({ command: "rg -n billing src" }))).toBe("search")
    expect(classifyFollowUp("mcp__agentx__agentx_send_agent", "{}")).toBe("ask")
    expect(classifyFollowUp("Read", "{}")).toBe("read")
    expect(classifyFollowUp("mcp__agentx__agentx_wiki_query", "{}")).toBe("requery")
    expect(classifyFollowUp("Edit", "{}")).toBe("other")
  })

  const tasks = [
    task("t1", "pm", T0, "s1"),
    task("t2", "pm", T0 + 1000, "s1"),
    task("t3", "coder", T0 + DAY, "s2"),
    task("t4", "coder", T0 + DAY + 1000, "s3"),
  ]
  const steps = [
    use("t1", 0, "mcp__agentx__agentx_wiki_query", { question: "Who approves refunds?" }),
    result("t1", 1, "The finance lead approves refunds.\n\nCitations (1 article walked):\n  - Refunds"),
    use("t1", 2, "Grep", { pattern: "refund" }),
    result("t1", 3, "no matches"),
    // Two calls in a row, results after both: paired in order.
    use("t3", 0, "Bash", { command: 'node cli.js wiki query "How do we deploy?" --dir /n/.agentx/wiki' }),
    use("t3", 1, "mcp__agentx__agentx_lookup", { who: "devops" }),
    result("t3", 2, "Error: ENOTDIR: not a directory\n    at mkdirSync (node:fs:1)", "error"),
    result("t3", 3, "devops is on the release"),
    use("t3", 4, "mcp__agentx__agentx_wiki_query", { question: "How do we deploy?" }),
  ]

  it("pairs calls with their results and counts turns, sessions, agents and days", () => {
    const calls = wikiCalls(tasks, steps)
    expect(calls.map((c) => [c.task_id, c.kind, c.outcome])).toEqual([
      ["t1", "tool", "answer"],
      ["t3", "cli", "crash"],
      ["t3", "lookup", null],
      ["t3", "tool", null],
    ])
    expect(calls[0].next).toBe("search")

    const r = summariseUsage(tasks, calls)
    expect(r).toMatchObject({
      turns: 4, sessions: 3, turnsWithQuery: 2, sessionsWithQuery: 2,
      calls: { tool: 2, cli: 1, lookup: 1, patch: 0 },
      outcomes: { answer: 1, crash: 1 }, failed: 1, unpaired: 1,
      nextAfterAnswer: { search: 1 },
    })
    expect(r.byAgent).toEqual([
      { agent: "coder", turns: 2, turnsWithQuery: 1, queries: 2, failed: 1 },
      { agent: "pm", turns: 2, turnsWithQuery: 1, queries: 1, failed: 0 },
    ])
    expect(r.byDay).toEqual([
      { day: "2026-11-02", turns: 2, turnsWithQuery: 1, queries: 1 },
      { day: "2026-11-03", turns: 2, turnsWithQuery: 1, queries: 2 },
    ])
  })

  it("draws a grading sample of distinct questions across agents, newest first", () => {
    const sample = gradingSample(wikiCalls(tasks, steps), 30)
    expect(sample.map((s) => [s.agent, s.question])).toEqual([
      ["coder", "How do we deploy?"],
      ["pm", "Who approves refunds?"],
    ])
    expect(sample[0].expect).toEqual([])
    expect(gradingSample(wikiCalls(tasks, steps), 1)).toHaveLength(1)
  })

  it("reads only the turns in the window, and steps only of turns that touched the wiki", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE task_traces (task_id TEXT PRIMARY KEY, agent_id TEXT, started_at INTEGER, final_session_id TEXT, resume_session_id TEXT);
      CREATE TABLE task_trace_steps (task_id TEXT, seq INTEGER, name TEXT, action TEXT, status TEXT, input_summary TEXT, output_summary TEXT, error TEXT, ms INTEGER, started_at INTEGER);
    `)
    const addTask = db.prepare("INSERT INTO task_traces VALUES (?, ?, ?, ?, ?)")
    addTask.run("old", "pm", T0 - 30 * DAY, null, null)
    addTask.run("t1", "pm", T0, "s1", null)
    addTask.run("t2", "coder", T0, null, "s9")
    const addStep = db.prepare("INSERT INTO task_trace_steps (task_id, seq, name, action, status, input_summary, output_summary, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
    for (const s of [...steps.filter((x) => x.task_id === "t1"), use("t2", 0, "Edit", {}), use("old", 0, "mcp__agentx__agentx_wiki_query", { question: "q" })]) {
      addStep.run(s.task_id, s.seq, s.name, s.action, s.status, s.input_summary, s.output_summary)
    }
    const { tasks: got, steps: gotSteps } = readLedger(db, T0 - DAY)
    expect(got.map((t) => [t.task_id, t.session]).sort()).toEqual([["t1", "s1"], ["t2", "s9"]])
    expect(new Set(gotSteps.map((s) => s.task_id))).toEqual(new Set(["t1"]))
    expect(gotSteps).toHaveLength(4)
  })
})
