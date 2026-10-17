import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execFileSync } from "child_process"
import {
  SPEC_TESTS_DEFAULTS,
  SpecTestStore,
  buildSpecTestInput,
  buildSpecTestPrompt,
  countTestCases,
  execProcess,
  extractAcceptanceCriteria,
  extractNamedInterfaces,
  formatSpecTestPrRecord,
  isTestFile,
  matchesPilotPath,
  parsePorcelainZ,
  parseSpecAgentOutput,
  parseSpecTestPrRecord,
  planSpecTests,
  runSpecTests,
  specAgentArgs,
  specTestAuthorInstructions,
  type SpecAgentFn,
  type SpecIssue,
  type SpecTestRun,
  type SpecTestsSettings,
} from "../src/agents/spec-tests"
import { daemonConfigSchema } from "../src/daemon/config"

// #992 — a separate test agent writes tests from the issue text only, and
// they land on the PR branch as their own commit, authored by that agent.

const ISSUE: SpecIssue = {
  repo: "example-org/example-repo",
  number: 42,
  title: "Retry webhook delivery in src/daemon/webhooks.ts",
  body: [
    "When a delivery fails, `deliverWebhook(url, payload)` should retry.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] A 500 response is retried up to `webhooks.maxRetries` times.",
    "- [x] A 400 response is not retried.",
    "",
    "## Notes",
    "- [ ] not a criterion",
  ].join("\n"),
}

const NODE = { id: "n", name: "N" }
const on = (over: Partial<SpecTestsSettings> = {}): SpecTestsSettings => ({ ...SPEC_TESTS_DEFAULTS, enabled: true, ...over })

describe("settings", () => {
  it("is off by default", () => {
    const cfg = daemonConfigSchema.parse({ node: NODE })
    expect(cfg.quality.specTests.enabled).toBe(false)
    expect(cfg.quality.specTests.paths).toEqual(["src/daemon"])
    expect(SPEC_TESTS_DEFAULTS.enabled).toBe(false)
  })

  it("accepts the documented keys", () => {
    const cfg = daemonConfigSchema.parse({ node: NODE, quality: { specTests: { enabled: true, paths: ["src/agents"], agent: "tester", model: "sonnet", maxCostPerIssue: 1.5, maxMinutes: 10 } } })
    expect(cfg.quality.specTests).toEqual({ enabled: true, paths: ["src/agents"], agent: "tester", model: "sonnet", maxCostPerIssue: 1.5, maxMinutes: 10 })
  })
})

describe("planSpecTests", () => {
  it("with the switch off, nothing runs", () => {
    expect(planSpecTests({ settings: SPEC_TESTS_DEFAULTS, issue: ISSUE, codeAgent: "coder" })).toEqual({ run: false, reason: "spec tests are off" })
  })

  it("runs for an issue that names a pilot path", () => {
    const plan = planSpecTests({ settings: on(), issue: ISSUE, codeAgent: "coder" })
    expect(plan.run).toBe(true)
  })

  it("skips an issue outside the pilot paths", () => {
    const plan = planSpecTests({ settings: on(), issue: { ...ISSUE, title: "Fix src/wiki search", body: "" }, codeAgent: "coder" })
    expect(plan).toMatchObject({ run: false })
  })

  it("refuses a test agent that is the coding agent", () => {
    const plan = planSpecTests({ settings: on({ agent: "Coder" }), issue: ISSUE, codeAgent: "coder" })
    expect(plan).toMatchObject({ run: false, reason: expect.stringContaining("is the coding agent") })
  })

  it("runs once per issue", () => {
    const previous = { status: "pushed" } as SpecTestRun
    expect(planSpecTests({ settings: on(), issue: ISSUE, codeAgent: "coder", previous })).toMatchObject({ run: false })
  })

  it("skips when the issue could not be read", () => {
    expect(planSpecTests({ settings: on(), issue: undefined, codeAgent: "coder" })).toMatchObject({ run: false })
  })
})

describe("matchesPilotPath", () => {
  it("matches the path and files under it, not a longer name", () => {
    expect(matchesPilotPath("see src/daemon/index.ts", ["src/daemon"])).toBe(true)
    expect(matchesPilotPath("hotspot: `src/daemon`.", ["src/daemon/"])).toBe(true)
    expect(matchesPilotPath("see ./src/daemon/x.ts", ["src/daemon"])).toBe(true)
    expect(matchesPilotPath("see src/daemons/x.ts", ["src/daemon"])).toBe(false)
    expect(matchesPilotPath("see lib/src/daemon/x.ts", ["src/daemon"])).toBe(false)
    expect(matchesPilotPath("anything", [])).toBe(false)
  })
})

describe("test agent input", () => {
  it("takes the checklist under Acceptance criteria", () => {
    expect(extractAcceptanceCriteria(ISSUE.body)).toEqual([
      "A 500 response is retried up to `webhooks.maxRetries` times.",
      "A 400 response is not retried.",
    ])
  })

  it("falls back to every checklist item", () => {
    expect(extractAcceptanceCriteria("- [ ] one\n* [x] two\n- plain")).toEqual(["one", "two"])
  })

  it("keeps the interfaces the issue names", () => {
    expect(extractNamedInterfaces(ISSUE.body)).toEqual(["deliverWebhook(url, payload)", "webhooks.maxRetries"])
    expect(extractNamedInterfaces("run `pnpm test --watch` and `123`")).toEqual([])
  })

  it("is built from the issue only: no diff, branch or session", () => {
    const input = buildSpecTestInput(ISSUE)
    expect(Object.keys(input).sort()).toEqual(["acceptanceCriteria", "body", "interfaces", "number", "repo", "title"])
    const prompt = buildSpecTestPrompt(input)
    expect(prompt).toContain(ISSUE.body)
    expect(prompt).toContain("1. A 500 response is retried")
    expect(prompt).not.toMatch(/^diff --git|^@@ |^\+\+\+ /m)
    expect(prompt).not.toMatch(/claude\/|spec-tests\/issue|session_/)
  })

  it("runs the model with file tools only and the budget cap", () => {
    const args = specAgentArgs({ maxBudgetUsd: 1.25, model: "sonnet" })
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Write,Edit")
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("1.25")
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet")
    expect(args).toContain("--strict-mcp-config")
  })
})

describe("records", () => {
  it("round-trips the per-PR record line", () => {
    const r = { written: 6, failedFirstRun: 2, codeDefects: 1, testMisreads: 1 }
    expect(parseSpecTestPrRecord(`## Spec tests\n...\n${formatSpecTestPrRecord(r)}`)).toEqual(r)
    expect(parseSpecTestPrRecord("<!-- agentx:spec-tests written=W failed-first-run=F code-defects=D test-misreads=M -->")).toBeUndefined()
    expect(parseSpecTestPrRecord("no record")).toBeUndefined()
  })

  it("tells the coding session the branch and the record line", () => {
    const text = specTestAuthorInstructions(42, "spec-tests")
    expect(text).toContain("spec-tests/issue-42")
    expect(text).toContain("test: spec tests for #42")
    expect(text).toContain("<!-- agentx:spec-tests written=W")
  })

  it("keeps runs across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "spec-store-"))
    try {
      const file = join(dir, "spec-tests.json")
      const run: SpecTestRun = { repo: "a/b", number: 1, agent: "t", codeAgent: "c", status: "pushed", startedAt: Date.now(), finishedAt: Date.now(), minutes: 1, costUsd: 0.4 }
      new SpecTestStore(file).record(run)
      expect(new SpecTestStore(file).get("A/B", 1)).toEqual(run)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("helpers", () => {
  it("tells test files apart", () => {
    expect(isTestFile("test/webhooks.test.ts")).toBe(true)
    expect(isTestFile("src/daemon/webhooks.spec.ts")).toBe(true)
    expect(isTestFile("src/daemon/webhooks.ts")).toBe(false)
  })

  it("counts test cases", () => {
    expect(countTestCases("it('a', () => {})\ntest.skip('b', () => {})\nit.each([1])('c', () => {})\nsplit('x')")).toBe(3)
  })

  it("reads porcelain -z output, renames included", () => {
    expect(parsePorcelainZ("?? test/a.test.ts\0R  test/new.ts\0test/old.ts\0 M src/x.ts\0")).toEqual(["test/a.test.ts", "test/new.ts", "src/x.ts"])
  })

  it("reads the CLI result, budget stop included", () => {
    expect(parseSpecAgentOutput(JSON.stringify({ subtype: "success", result: "done", total_cost_usd: 0.3 }), 0)).toEqual({ ok: true, costUsd: 0.3, reply: "done" })
    expect(parseSpecAgentOutput(JSON.stringify({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 2.01 }), 1)).toEqual({ ok: false, budgetStopped: true, costUsd: 2.01 })
    expect(parseSpecAgentOutput("", 1)).toMatchObject({ ok: false })
  })
})

// --- End to end against a real git remote ---

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

function setup() {
  const root = mkdtempSync(join(tmpdir(), "spec-run-"))
  const remote = join(root, "remote.git")
  const checkout = join(root, "checkout")
  execFileSync("git", ["init", "--bare", "-b", "main", remote])
  execFileSync("git", ["clone", remote, checkout], { stdio: "ignore" })
  git(checkout, "config", "user.name", "Code Author")
  git(checkout, "config", "user.email", "author@example.invalid")
  mkdirSync(join(checkout, "src/daemon"), { recursive: true })
  writeFileSync(join(checkout, "src/daemon/webhooks.ts"), "export const x = 1\n")
  git(checkout, "add", "-A")
  git(checkout, "commit", "-m", "base")
  git(checkout, "push", "origin", "main")
  git(checkout, "remote", "set-head", "origin", "main")
  // The coding agent's unpushed work in the same checkout: the test agent must not see it.
  writeFileSync(join(checkout, "src/daemon/webhooks.ts"), "export const x = 1\nexport function deliverWebhook() { /* IMPLEMENTATION */ }\n")
  return { root, remote, checkout }
}

function harness(runAgent: SpecAgentFn, settings = on()) {
  const env = setup()
  const runs: SpecTestRun[] = []
  const notes: string[] = []
  const told: string[] = []
  const deps = {
    settings,
    input: buildSpecTestInput(ISSUE),
    codeAgent: "coder",
    checkout: env.checkout,
    exec: execProcess,
    runAgent,
    store: { record: (r: SpecTestRun) => { runs.push(r) } },
    noteOnIssue: async (t: string) => { notes.push(t) },
    tellAuthor: async (t: string) => { told.push(t) },
    log: () => {},
  }
  return { env, runs, notes, told, deps }
}

describe("runSpecTests", () => {
  it("pushes one commit authored by the test agent to spec-tests/issue-N", async () => {
    let seen: { prompt: string; dir: string; maxBudgetUsd: number } | undefined
    let sawImplementation = true
    const h = harness(async (opts) => {
      seen = opts
      sawImplementation = execFileSync("cat", [join(opts.dir, "src/daemon/webhooks.ts")], { encoding: "utf8" }).includes("IMPLEMENTATION")
      mkdirSync(join(opts.dir, "test"), { recursive: true })
      writeFileSync(join(opts.dir, "test/webhooks-spec.test.ts"), "it('retries a 500', () => {})\nit('does not retry a 400', () => {})\n")
      writeFileSync(join(opts.dir, "src/daemon/webhooks.ts"), "tampered\n")
      return { ok: true, costUsd: 0.42 }
    })
    try {
      const run = await runSpecTests(h.deps)
      expect(run).toMatchObject({ status: "pushed", branch: "spec-tests/issue-42", testFiles: ["test/webhooks-spec.test.ts"], testsWritten: 2, costUsd: 0.42, agent: "spec-tests", codeAgent: "coder" })
      expect(run.minutes).toBeGreaterThanOrEqual(0)
      expect(h.runs).toEqual([run])
      expect(h.notes).toEqual([])
      expect(h.told[0]).toContain("spec-tests/issue-42")

      // The agent worked on a clean base, and got only the issue-built prompt.
      expect(sawImplementation).toBe(false)
      expect(seen!.dir).not.toBe(h.env.checkout)
      expect(seen!.prompt).toBe(buildSpecTestPrompt(buildSpecTestInput(ISSUE)))
      expect(seen!.prompt).not.toContain("IMPLEMENTATION")
      expect(seen!.maxBudgetUsd).toBe(SPEC_TESTS_DEFAULTS.maxCostPerIssue)

      const log = git(h.env.remote, "log", "-1", "--format=%an <%ae>|%s", "spec-tests/issue-42")
      expect(log).toBe("spec-tests <spec-tests@spec-tests.agentx.invalid>|test: spec tests for #42")
      expect(log).not.toContain("Code Author")
      const files = git(h.env.remote, "show", "--name-only", "--format=", "spec-tests/issue-42")
      expect(files).toBe("test/webhooks-spec.test.ts") // the non-test change was not committed
      // The worktree is gone and the author's checkout is untouched.
      expect(git(h.env.checkout, "worktree", "list")).not.toContain("agentx-spec")
      expect(git(h.env.checkout, "status", "--porcelain")).toBe("M src/daemon/webhooks.ts")
    } finally {
      rmSync(h.env.root, { recursive: true, force: true })
    }
  })

  it("budget guard: stops, records the cost and leaves a note", async () => {
    const h = harness(async () => ({ ok: false, budgetStopped: true, costUsd: 2.03 }))
    try {
      const run = await runSpecTests(h.deps)
      expect(run).toMatchObject({ status: "budget-stopped", costUsd: 2.03 })
      expect(h.notes).toHaveLength(1)
      expect(h.notes[0]).toContain("budget of $2.00")
      expect(h.notes[0]).toContain("<!-- agentx:spec-tests -->")
      expect(() => git(h.env.remote, "rev-parse", "spec-tests/issue-42")).toThrow()
      expect(h.told).toEqual([])
    } finally {
      rmSync(h.env.root, { recursive: true, force: true })
    }
  })

  it("a time-out and an agent that writes no test both leave a note", async () => {
    for (const [result, status] of [[{ ok: false, timedOut: true }, "timed-out"], [{ ok: true }, "no-tests"], [{ ok: false, error: "boom" }, "failed"]] as const) {
      const h = harness(async () => result)
      try {
        const run = await runSpecTests(h.deps)
        expect(run.status).toBe(status)
        expect(h.notes).toHaveLength(1)
      } finally {
        rmSync(h.env.root, { recursive: true, force: true })
      }
    }
  })

  it("a note that cannot be posted is logged, not thrown", async () => {
    const h = harness(async () => ({ ok: false, budgetStopped: true }))
    const lines: string[] = []
    try {
      const run = await runSpecTests({ ...h.deps, noteOnIssue: async () => { throw new Error("gh missing") }, log: (l) => lines.push(l) })
      expect(run.status).toBe("budget-stopped")
      expect(lines.some((l) => l.includes("could not leave the note") && l.includes("gh missing"))).toBe(true)
    } finally {
      rmSync(h.env.root, { recursive: true, force: true })
    }
  })
})
