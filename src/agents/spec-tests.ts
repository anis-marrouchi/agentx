import { spawn as nodeSpawn } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { dirname, join, resolve, sep } from "path"
import { markBody } from "@/channels/outbound-marker"
import { claudeCliEnv } from "@/utils/workspace-env"

// --- Spec-first tests (#992) ---
//
// For an issue in a pilot path (e.g. `src/daemon`), a separate test agent
// writes tests from the issue text and its acceptance criteria only, while
// the coding agent's cloud session (#622) writes the code. The test agent
// never sees the implementation:
//   - its input is built here from the issue alone (title, body, the
//     acceptance criteria and the interfaces the issue names), never from
//     the coding agent's prompt, diff or session;
//   - it runs in a fresh detached worktree of the base branch, before the
//     code exists, with file tools only (no shell, no network, no MCP), so
//     it cannot fetch the pull request either.
// The daemon, not the model, commits what it wrote as `test: spec tests for
// #N` under the test agent's name and pushes it to `spec-tests/issue-N`. The
// coding session is told to merge that branch (a merge keeps the commit's
// author) and to record in the PR which failures were code defects and
// which were test misreads.
//
// Off by default: `quality.specTests.enabled` (daemon/config.ts).

/** `quality.specTests` (daemon/config.ts). */
export interface SpecTestsSettings {
  enabled: boolean
  /** Path prefixes an issue must name to be in the pilot. */
  paths: string[]
  /** The test agent's name: the spec-test commit's author, and the key its
   *  records are kept under. Must not be the coding agent. */
  agent: string
  /** Model for the test agent. Unset: the CLI default. */
  model?: string
  /** USD cap for one issue's test agent run. The run stops when it is spent. */
  maxCostPerIssue: number
  /** Wall-clock cap for one issue's test agent run. */
  maxMinutes: number
}

export const SPEC_TESTS_DEFAULTS: SpecTestsSettings = {
  enabled: false,
  paths: ["src/daemon"],
  agent: "spec-tests",
  maxCostPerIssue: 2,
  maxMinutes: 20,
}

export function specTestBranch(issueNumber: number): string {
  return `spec-tests/issue-${issueNumber}`
}

export function specTestCommitMessage(issueNumber: number): string {
  return `test: spec tests for #${issueNumber}`
}

/** The commit identity of the test agent. A reserved `.invalid` address,
 *  so it never resolves to a real GitHub account. */
export function specTestAuthor(agent: string): { name: string; email: string } {
  const slug = agent.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "spec-tests"
  return { name: agent, email: `${slug}@spec-tests.agentx.invalid` }
}

// --- Issue → test agent input ---

export interface SpecIssue {
  repo: string
  number: number
  title: string
  body: string
}

/** Everything the test agent is given. Built from the issue only: there is
 *  deliberately no field for a diff, a branch, a session or the coding
 *  agent's prompt. */
export interface SpecTestInput {
  repo: string
  number: number
  title: string
  body: string
  acceptanceCriteria: string[]
  interfaces: string[]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** True when the issue names one of the pilot path prefixes, as a path:
 *  `src/daemon` matches `src/daemon/x.ts` and `src/daemon`, not `src/daemons`. */
export function matchesPilotPath(text: string, paths: string[]): boolean {
  return paths.some((p) => {
    const prefix = p.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "")
    if (!prefix) return false
    return new RegExp(`(^|[^A-Za-z0-9_.\\/-])(\\.\\/)?${escapeRe(prefix)}(?=$|[^A-Za-z0-9_-])`).test(text)
  })
}

/** The checklist items under an "Acceptance criteria" heading, or every
 *  checklist item in the body when there is no such heading. */
export function extractAcceptanceCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/)
  const item = (line: string) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/)?.[1]
  const start = lines.findIndex((l) => /^\s*#{1,6}\s*acceptance criteria\b/i.test(l))
  if (start >= 0) {
    const out: string[] = []
    for (const line of lines.slice(start + 1)) {
      if (/^\s*#{1,6}\s/.test(line)) break
      const it = item(line)
      if (it) out.push(it)
    }
    if (out.length) return out
  }
  return lines.map(item).filter((x): x is string => !!x)
}

/** Inline-code spans that name an interface: a path, an identifier, a
 *  dotted setting or a call signature. Plain words and shell commands are
 *  left out. */
export function extractNamedInterfaces(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(/`([^`\n]{2,160})`/g)) {
    const span = m[1].trim()
    if (/\s/.test(span) && !/^[\w.$]+\s*[(<]/.test(span)) continue
    if (!/[A-Za-z_]/.test(span)) continue
    seen.add(span)
  }
  return [...seen]
}

export function buildSpecTestInput(issue: SpecIssue): SpecTestInput {
  const body = issue.body ?? ""
  return {
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    body,
    acceptanceCriteria: extractAcceptanceCriteria(body),
    interfaces: extractNamedInterfaces(`${issue.title}\n${body}`),
  }
}

const MAX_ISSUE_BODY_CHARS = 20_000

/** The test agent's prompt. Only `input` goes in. */
export function buildSpecTestPrompt(input: SpecTestInput): string {
  const body = input.body.length > MAX_ISSUE_BODY_CHARS ? `${input.body.slice(0, MAX_ISSUE_BODY_CHARS)}\n[issue cut at ${MAX_ISSUE_BODY_CHARS} characters]` : input.body
  const acs = input.acceptanceCriteria.length ? input.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(the issue has no checklist; take the requirements from its text)"
  const ifaces = input.interfaces.length ? input.interfaces.map((x) => `- \`${x}\``).join("\n") : "(none named)"
  return [
    `You are the spec-test agent for issue #${input.number} in ${input.repo}.`,
    `Another agent is writing the code for this issue at the same time. You do not see its code, and you must not guess at it. Write tests from the issue alone.`,
    ``,
    `## Your job`,
    `- Write one test file for this issue, following the repository's existing test conventions (framework, folder, naming). Read the existing tests and the public interfaces the issue names to get imports and signatures right.`,
    `- One test or more per acceptance criterion. Name each test after the criterion it checks, so a failure points at the criterion.`,
    `- Test behaviour through public interfaces. The code under test may not exist yet: that is expected, the tests may fail now.`,
    `- Only create or edit test files. Do not change any other file. Do not commit: the daemon commits your file.`,
    `- When a criterion cannot be tested from the issue text alone, write no test for it and say so in your final reply.`,
    `- End with a short reply: the file you wrote and one line per criterion (tested, or why not).`,
    ``,
    `## Issue #${input.number}: ${input.title}`,
    body,
    ``,
    `## Acceptance criteria`,
    acs,
    ``,
    `## Interfaces the issue names`,
    ifaces,
  ].join("\n")
}

/** What the coding session is told when spec tests run for its issue. */
export function specTestAuthorInstructions(issueNumber: number, agent: string): string {
  const branch = specTestBranch(issueNumber)
  return [
    ``,
    `## Spec tests (#992)`,
    `A separate test agent ("${agent}") is writing tests for this issue from the issue text only, without seeing your code. It pushes them as one commit, "${specTestCommitMessage(issueNumber)}", to the branch \`${branch}\`.`,
    `- Do not write those tests yourself. Do not edit or delete them, except as described below.`,
    `- Before you open the pull request, and again before you finish, run \`git fetch origin ${branch}\`. When the branch exists, merge it into your branch with \`git merge --no-ff origin/${branch}\` (a merge, not a cherry-pick, squash or rebase, so the commit keeps its author), then run its tests.`,
    `- When a spec test fails, decide which it is. A code defect: fix the code. A test that misreads the acceptance criteria: change that test in a separate commit whose message starts with "test: spec misread" and quotes the criterion it misreads. Never skip or disable a spec test.`,
    `- In the pull request description, add a "Spec tests" section that lists each failure on the first run and your call (code defect or test misread), and ends with this line, filled in:`,
    `  <!-- agentx:spec-tests written=W failed-first-run=F code-defects=D test-misreads=M -->`,
    `- If the branch has not appeared by the time you finish, say so in that section.`,
  ].join("\n")
}

// --- Per-PR record ---

export interface SpecTestPrRecord {
  written: number
  failedFirstRun: number
  codeDefects: number
  testMisreads: number
}

export function formatSpecTestPrRecord(r: SpecTestPrRecord): string {
  return `<!-- agentx:spec-tests written=${r.written} failed-first-run=${r.failedFirstRun} code-defects=${r.codeDefects} test-misreads=${r.testMisreads} -->`
}

/** The record line from a pull request description, or undefined when the
 *  PR has none (or it was left unfilled). For the weekly report (#988). */
export function parseSpecTestPrRecord(body: string | undefined | null): SpecTestPrRecord | undefined {
  const m = body?.match(/<!--\s*agentx:spec-tests\s+([^>]*?)\s*-->/)
  if (!m) return undefined
  const fields: Record<string, number> = {}
  for (const kv of m[1].matchAll(/([a-z-]+)=(\d+)/g)) fields[kv[1]] = Number(kv[2])
  const keys = ["written", "failed-first-run", "code-defects", "test-misreads"]
  if (!keys.every((k) => Number.isInteger(fields[k]))) return undefined
  return { written: fields["written"], failedFirstRun: fields["failed-first-run"], codeDefects: fields["code-defects"], testMisreads: fields["test-misreads"] }
}

// --- Per-issue run record ---

/** `running` is written when a run starts, so a second dispatch for the
 *  same issue does not start another one; `finish` replaces it. `blocked`:
 *  a written file looked like it held a secret, so nothing was pushed. */
export type SpecTestRunStatus = "running" | "pushed" | "no-tests" | "budget-stopped" | "timed-out" | "failed" | "blocked" | "skipped"

export interface SpecTestRun {
  repo: string
  number: number
  /** The test agent that ran (settings.agent). */
  agent: string
  /** The coding agent the tests are for. */
  codeAgent: string
  status: SpecTestRunStatus
  startedAt: number
  finishedAt: number
  minutes: number
  /** USD the CLI reported. Undefined when the run named no cost. */
  costUsd?: number
  branch?: string
  commit?: string
  testFiles?: string[]
  /** Test cases in the pushed files (`it(` / `test(` calls). */
  testsWritten?: number
  /** Why the run did not push, in words; also posted on the issue. */
  note?: string
}

const KEEP_MS = 90 * 24 * 60 * 60 * 1000

/** Spec-test runs, one per issue, in a JSON file (default
 *  .agentx/spec-tests.json). Survives a daemon restart, so an issue is not
 *  given a second run. */
export class SpecTestStore {
  private runs: SpecTestRun[] = []
  private loaded = false

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"))
      const list = Array.isArray(raw?.runs) ? raw.runs : []
      this.runs = list.filter((r: any) => r && typeof r.repo === "string" && Number.isInteger(r.number) && Number.isFinite(r.startedAt))
    } catch {
      this.runs = []
    }
  }

  private save(): void {
    const now = Date.now()
    this.runs = this.runs.filter((r) => now - r.startedAt < KEEP_MS)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ runs: this.runs }, null, 2))
      renameSync(tmp, this.file)
    } catch { /* best effort: the daemon keeps the in-memory copy */ }
  }

  get(repo: string, number: number): SpecTestRun | undefined {
    this.load()
    const key = repo.toLowerCase()
    return this.runs.find((r) => r.repo.toLowerCase() === key && r.number === number)
  }

  record(run: SpecTestRun): void {
    this.load()
    this.runs = this.runs.filter((r) => !(r.repo.toLowerCase() === run.repo.toLowerCase() && r.number === run.number))
    this.runs.push(run)
    this.save()
  }

  all(): SpecTestRun[] {
    this.load()
    return [...this.runs]
  }
}

// --- Planning ---

/** A `running` record older than the time limit plus this is from a daemon
 *  that stopped mid-run, and no longer blocks a new run. */
const STALE_RUNNING_GRACE_MS = 10 * 60_000

/** Why an earlier record stops a new run for the issue, or undefined. */
export function previousRunBlocks(previous: SpecTestRun | undefined, settings: SpecTestsSettings, now = Date.now()): string | undefined {
  if (!previous) return undefined
  if (previous.status !== "running") return `spec tests already ran for this issue (${previous.status})`
  if (now - previous.startedAt > settings.maxMinutes * 60_000 + STALE_RUNNING_GRACE_MS) return undefined
  return "spec tests are already running for this issue"
}

export type SpecTestPlan =
  | { run: true; input: SpecTestInput }
  | { run: false; reason: string }

/** Whether the test agent runs for this issue. Pure. */
export function planSpecTests(opts: {
  settings: SpecTestsSettings
  issue: SpecIssue | undefined
  codeAgent: string
  previous?: SpecTestRun
  now?: number
}): SpecTestPlan {
  const { settings, issue } = opts
  if (!settings.enabled) return { run: false, reason: "spec tests are off" }
  if (!issue) return { run: false, reason: "the issue text could not be read" }
  if (!matchesPilotPath(`${issue.title}\n${issue.body}`, settings.paths)) {
    return { run: false, reason: `issue names none of the pilot paths (${settings.paths.join(", ") || "none set"})` }
  }
  if (settings.agent.trim().toLowerCase() === opts.codeAgent.trim().toLowerCase()) {
    return { run: false, reason: `the test agent "${settings.agent}" is the coding agent; set quality.specTests.agent to another name` }
  }
  const blocked = previousRunBlocks(opts.previous, settings, opts.now)
  if (blocked) return { run: false, reason: blocked }
  return { run: true, input: buildSpecTestInput(issue) }
}

// --- Running ---

export interface ExecResult { code: number; stdout: string; stderr: string }
export type ExecFn = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number; killGraceMs?: number }) => Promise<ExecResult>

export interface SpecAgentResult {
  ok: boolean
  costUsd?: number
  budgetStopped?: boolean
  timedOut?: boolean
  reply?: string
  error?: string
}

/** Runs the test agent's model on `prompt` in `dir`. `deny` holds the
 *  permission rules that keep its file tools out of everything but `dir`. */
export type SpecAgentFn = (opts: { prompt: string; dir: string; model?: string; maxBudgetUsd: number; timeoutMs: number; deny: string[] }) => Promise<SpecAgentResult>

export interface SpecTestRunDeps {
  settings: SpecTestsSettings
  input: SpecTestInput
  codeAgent: string
  /** The checkout the coding session was launched from. */
  checkout: string
  exec: ExecFn
  runAgent: SpecAgentFn
  store: Pick<SpecTestStore, "record">
  /** Leaves a note on the issue (budget stop, failure). */
  noteOnIssue: (text: string) => Promise<void>
  /** Tells the coding session the tests are on the branch. */
  tellAuthor?: (text: string) => Promise<void>
  log: (line: string) => void
  now?: () => number
  makeTempDir?: () => string
  /** Folders the test agent's file tools may not read or write. Default:
   *  the checkout, the daemon's folder and the home folder. */
  protectedPaths?: string[]
}

/** A file the test agent may leave behind. Anything else is discarded. */
export function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
}

/** `it(` / `test(` calls in a test file (`.skip`/`.only`/`.each` included). */
export function countTestCases(source: string): number {
  return (source.match(/(^|[^\w.$])(it|test)(\.(only|skip|todo|concurrent|each\([^)]*\)))?\s*\(/g) ?? []).length
}

export interface PorcelainEntry {
  /** The two-letter XY status: `??` for a new untracked file. */
  status: string
  path: string
}

/** Entries from `git status --porcelain -z --untracked-files=all`. */
export function parsePorcelainEntriesZ(out: string): PorcelainEntry[] {
  const parts = out.split("\0").filter(Boolean)
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    const status = entry.slice(0, 2)
    entries.push({ status, path: entry.slice(3) })
    if (status.startsWith("R") || status.startsWith("C")) i++ // the rename's source path follows
  }
  return entries
}

/** Paths from `git status --porcelain -z --untracked-files=all`. */
export function parsePorcelainZ(out: string): string[] {
  return parsePorcelainEntriesZ(out).map((e) => e.path)
}

/** The files the daemon commits: new, untracked test files. A change to a
 *  file that already exists (an edit, a deletion, a rename), a test or a
 *  fixture included, is never committed, so the test agent cannot weaken
 *  or remove the repository's existing tests. */
export function selectSpecTestFiles(entries: PorcelainEntry[]): { keep: string[]; discard: string[] } {
  const keep: string[] = []
  const discard: string[] = []
  for (const e of entries) {
    if (e.status === "??" && isTestFile(e.path)) keep.push(e.path)
    else discard.push(e.status === "??" ? `${e.path} (new, not a test file)` : `${e.path} (${e.status.trim() || "changed"}, existing file)`)
  }
  return { keep, discard }
}

// --- Secrets ---

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["API key (sk-)", /\bsk-(?!ant-)(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ["Stripe key", /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ["DigitalOcean token", /\bdo[pro]_v1_[a-f0-9]{64}\b/],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ["password in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{8,}@/i],
]

/** The kinds of secret `text` looks like it holds. Never returns the value. */
export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind)
}

// --- File access ---

const SENSITIVE_HOME_PATHS = [".ssh", ".gnupg", ".aws", ".config", ".claude", ".claude.json", ".netrc", ".git-credentials", ".npmrc", ".docker", ".kube"]

const permissionPath = (p: string) => `/${resolve(p).replace(/\\/g, "/").replace(/^\/+/, "")}`

/** `--settings` deny rules that keep the test agent's file tools (Read rules
 *  also cover Glob and Grep; Edit rules cover Write) out of each protected
 *  folder, its secrets in the home folder and `/proc` (the environment of
 *  running processes). A folder that contains the worktree cannot be denied
 *  whole, so only its sensitive entries are. */
export function specAgentDenyRules(dir: string, protectedPaths: string[]): string[] {
  const work = resolve(dir)
  const inside = (p: string) => work === p || work.startsWith(p.endsWith(sep) ? p : p + sep)
  const home = homedir()
  const paths = [...protectedPaths, home, ...SENSITIVE_HOME_PATHS.map((x) => join(home, x)), "/proc"].map((p) => resolve(p))
  const rules: string[] = []
  for (const p of [...new Set(paths)]) {
    if (inside(p)) continue
    const glob = `/${permissionPath(p)}/**`
    rules.push(`Read(${glob})`, `Edit(${glob})`)
  }
  return rules
}

/** Writes the spec tests, commits them as the test agent and pushes them to
 *  `spec-tests/issue-N`. Never throws, and never ends silently: every run is
 *  recorded, and every run that does not push leaves a note on the issue. */
export async function runSpecTests(deps: SpecTestRunDeps): Promise<SpecTestRun> {
  const { settings, input, exec } = deps
  const now = deps.now ?? Date.now
  const startedAt = now()
  const branch = specTestBranch(input.number)
  const base: Omit<SpecTestRun, "status" | "finishedAt" | "minutes"> = {
    repo: input.repo, number: input.number, agent: settings.agent, codeAgent: deps.codeAgent, startedAt,
  }
  let dir: string | undefined
  const git = (args: string[], cwd: string, timeoutMs = 120_000) => exec("git", args, { cwd, timeoutMs })
  // Before the first await, so a second dispatch that checks the store sees it.
  deps.store.record({ ...base, status: "running", finishedAt: startedAt, minutes: 0 })

  const finish = async (fields: Partial<SpecTestRun> & { status: SpecTestRunStatus }): Promise<SpecTestRun> => {
    const finishedAt = now()
    const run: SpecTestRun = { ...base, ...fields, finishedAt, minutes: Math.round(((finishedAt - startedAt) / 60_000) * 10) / 10 }
    deps.store.record(run)
    const cost = run.costUsd === undefined ? "cost not reported" : `$${run.costUsd.toFixed(2)}`
    deps.log(`[spec-tests] ${input.repo}#${input.number}: ${run.status} in ${run.minutes} min, ${cost}${run.note ? ` — ${run.note}` : ""}`)
    if (run.status !== "pushed" && run.note) {
      try {
        await deps.noteOnIssue(markBody(`Spec tests for #${input.number} (${settings.agent}): ${run.note}`, settings.agent))
      } catch (e: any) {
        deps.log(`[spec-tests] ${input.repo}#${input.number}: could not leave the note on the issue: ${e?.message || e}`)
      }
    }
    return run
  }

  try {
    const fetched = await git(["fetch", "origin"], deps.checkout)
    if (fetched.code !== 0) return await finish({ status: "failed", note: `could not fetch the repository: ${fetched.stderr.trim().slice(0, 300)}` })
    const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], deps.checkout)
    const baseRef = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : "origin/main"

    dir = (deps.makeTempDir ?? (() => mkdtempSync(join(tmpdir(), `agentx-spec-${input.number}-`))))()
    const added = await git(["worktree", "add", "--detach", dir, baseRef], deps.checkout)
    if (added.code !== 0) return await finish({ status: "failed", note: `could not create a clean worktree of ${baseRef}: ${added.stderr.trim().slice(0, 300)}` })

    const agent = await deps.runAgent({
      prompt: buildSpecTestPrompt(input),
      dir,
      model: settings.model,
      maxBudgetUsd: settings.maxCostPerIssue,
      timeoutMs: settings.maxMinutes * 60_000,
      deny: specAgentDenyRules(dir, deps.protectedPaths ?? [deps.checkout, process.cwd()]),
    })
    if (agent.budgetStopped) {
      return await finish({ status: "budget-stopped", costUsd: agent.costUsd, note: `stopped at the budget of $${settings.maxCostPerIssue.toFixed(2)} (quality.specTests.maxCostPerIssue). No tests were pushed; review the issue's acceptance criteria by hand.` })
    }
    if (agent.timedOut) {
      return await finish({ status: "timed-out", costUsd: agent.costUsd, note: `stopped after ${settings.maxMinutes} minutes (quality.specTests.maxMinutes). No tests were pushed.` })
    }
    if (!agent.ok) {
      return await finish({ status: "failed", costUsd: agent.costUsd, note: `the test agent failed: ${(agent.error || "no reason given").slice(0, 300)}` })
    }

    const status = await git(["status", "--porcelain", "-z", "--untracked-files=all"], dir)
    if (status.code !== 0) return await finish({ status: "failed", costUsd: agent.costUsd, note: `could not list the files the test agent wrote: ${status.stderr.trim().slice(0, 300)}` })
    const { keep: testFiles, discard } = selectSpecTestFiles(parsePorcelainEntriesZ(status.stdout))
    if (discard.length) deps.log(`[spec-tests] ${input.repo}#${input.number}: discarded (only new test files are committed): ${discard.join(", ")}`)
    if (!testFiles.length) {
      return await finish({ status: "no-tests", costUsd: agent.costUsd, note: `the test agent wrote no new test file${discard.length ? ` (its other changes were discarded: ${discard.join(", ")})` : ""}.` })
    }

    let testsWritten = 0
    const secrets: string[] = []
    for (const f of testFiles) {
      const source = readFileSync(join(dir, f), "utf8")
      testsWritten += countTestCases(source)
      for (const kind of findSecrets(source)) secrets.push(`${kind} in ${f}`)
    }
    if (secrets.length) {
      return await finish({ status: "blocked", costUsd: agent.costUsd, testFiles, note: `a written file looks like it holds a secret (${secrets.join(", ")}), so nothing was pushed. The operator should check what the test agent could read.` })
    }
    const author = specTestAuthor(settings.agent)
    const identity = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`]
    // Untracked files only, so `add` cannot stage a deletion or an edit.
    const staged = await git(["add", "--", ...testFiles], dir)
    if (staged.code !== 0) return await finish({ status: "failed", costUsd: agent.costUsd, note: `could not stage the tests: ${staged.stderr.trim().slice(0, 300)}` })
    const body = `Written by ${settings.agent} from the text of #${input.number} and its acceptance criteria only, without the implementation (#992).`
    const committed = await git([...identity, "commit", "--no-verify", "-m", specTestCommitMessage(input.number), "-m", body], dir)
    if (committed.code !== 0) return await finish({ status: "failed", costUsd: agent.costUsd, testFiles, note: `could not commit the tests: ${committed.stderr.trim().slice(0, 300)}` })
    const sha = (await git(["rev-parse", "HEAD"], dir)).stdout.trim()
    const pushed = await git(["push", "origin", `HEAD:refs/heads/${branch}`], dir)
    if (pushed.code !== 0) return await finish({ status: "failed", costUsd: agent.costUsd, testFiles, commit: sha, note: `could not push ${branch}: ${pushed.stderr.trim().slice(0, 300)}` })

    const run = await finish({ status: "pushed", costUsd: agent.costUsd, branch, commit: sha, testFiles, testsWritten })
    if (deps.tellAuthor) {
      try {
        await deps.tellAuthor(`The spec tests for #${input.number} are on \`${branch}\` (${testFiles.join(", ")}). Merge them with \`git fetch origin ${branch} && git merge --no-ff origin/${branch}\`, run them, and record the outcome in the pull request's "Spec tests" section as described in your task.`)
      } catch (e: any) {
        deps.log(`[spec-tests] ${input.repo}#${input.number}: could not tell the coding session: ${e?.message || e}`)
      }
    }
    return run
  } catch (e: any) {
    return await finish({ status: "failed", note: `unexpected error: ${(e?.message || String(e)).slice(0, 300)}` })
  } finally {
    if (dir) {
      try { await git(["worktree", "remove", "--force", dir], deps.checkout) } catch { /* fall through */ }
      try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

// --- Real process runners ---

/** How long a timed-out process gets after SIGTERM before SIGKILL, and
 *  again after SIGKILL before the wait ends without its exit. */
export const KILL_GRACE_MS = 5_000

export interface SpawnResult extends ExecResult { timedOut: boolean }

/** Runs a process with a time limit that always ends the wait: SIGTERM at
 *  the limit, SIGKILL after `killGraceMs`, and a result after one more
 *  grace period even if a grandchild still holds the output open. */
export function spawnWithTimeout(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; killGraceMs?: number }): Promise<SpawnResult> {
  return new Promise((done) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const settle = (code: number, err?: string) => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      done({ code, stdout, stderr: err ?? stderr, timedOut })
    }
    let child: ReturnType<typeof nodeSpawn>
    try {
      child = nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] })
    } catch (e: any) {
      settle(-1, e?.message || String(e))
      return
    }
    const grace = opts.killGraceMs ?? KILL_GRACE_MS
    if (opts.timeoutMs) {
      timers.push(setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
        timers.push(setTimeout(() => {
          child.kill("SIGKILL")
          timers.push(setTimeout(() => {
            child.stdout?.destroy()
            child.stderr?.destroy()
            settle(-1)
          }, grace))
        }, grace))
      }, opts.timeoutMs))
    }
    child.stdout?.on("data", (d) => { stdout += d })
    child.stderr?.on("data", (d) => { stderr += d })
    child.stdin?.on("error", () => { /* the process exited before reading its input */ })
    child.on("error", (e) => settle(-1, e.message))
    child.on("close", (code) => settle(code ?? -1))
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

export const execProcess: ExecFn = async (cmd, args, opts) => {
  const r = await spawnWithTimeout(cmd, args, opts)
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

/** File tools only: the test agent reads and writes inside its own worktree
 *  (the deny rules block the base checkout and the daemon's files), and has
 *  no shell or network to look up the pull request. */
export const SPEC_AGENT_TOOLS = "Read,Glob,Grep,Write,Edit"

export function specAgentArgs(opts: { model?: string; maxBudgetUsd: number; deny?: string[] }): string[] {
  return [
    "-p", "-", "--output-format", "json",
    "--tools", SPEC_AGENT_TOOLS, "--permission-mode", "acceptEdits",
    "--max-budget-usd", String(opts.maxBudgetUsd),
    ...(opts.model ? ["--model", opts.model] : []),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--settings", JSON.stringify({ disableAllHooks: true, permissions: { deny: opts.deny ?? [] } }), "--no-session-persistence",
  ]
}

/** Reads `claude -p --output-format json` output. */
export function parseSpecAgentOutput(stdout: string, code: number | null): SpecAgentResult {
  let envelope: any
  try { envelope = JSON.parse(stdout) } catch { envelope = undefined }
  const cost = typeof envelope?.total_cost_usd === "number" && Number.isFinite(envelope.total_cost_usd) ? envelope.total_cost_usd : undefined
  if (envelope?.subtype === "error_max_budget_usd") return { ok: false, budgetStopped: true, costUsd: cost }
  if (!envelope) return { ok: false, error: `claude exited ${code ?? "unknown"} with no result` }
  if (envelope.is_error || (typeof envelope.subtype === "string" && envelope.subtype !== "success")) {
    return { ok: false, costUsd: cost, error: String(envelope.result ?? envelope.subtype).slice(0, 300) }
  }
  return { ok: true, costUsd: cost, reply: String(envelope.result ?? "") }
}

export const claudeSpecAgent: SpecAgentFn = async (opts) => {
  const r = await spawnWithTimeout("claude", specAgentArgs(opts), { cwd: opts.dir, env: claudeCliEnv(), input: opts.prompt, timeoutMs: opts.timeoutMs })
  if (r.timedOut) return { ok: false, timedOut: true, costUsd: parseSpecAgentOutput(r.stdout, r.code).costUsd }
  const parsed = parseSpecAgentOutput(r.stdout, r.code)
  if (!parsed.ok && !parsed.budgetStopped && r.stderr && (!parsed.error || !r.stdout)) parsed.error = r.stderr.trim().slice(0, 300)
  return parsed
}

/** The issue as `gh issue view` reads it, or undefined. */
export async function fetchIssueWithGh(exec: ExecFn, repo: string, number: number, cwd: string): Promise<SpecIssue | undefined> {
  const r = await exec("gh", ["issue", "view", String(number), "--repo", repo, "--json", "title,body"], { cwd, timeoutMs: 20_000 })
  if (r.code !== 0) return undefined
  try {
    const data = JSON.parse(r.stdout)
    if (typeof data?.title !== "string") return undefined
    return { repo, number, title: data.title, body: typeof data.body === "string" ? data.body : "" }
  } catch {
    return undefined
  }
}

export async function commentOnIssueWithGh(exec: ExecFn, repo: string, number: number, cwd: string, body: string): Promise<void> {
  const r = await exec("gh", ["issue", "comment", String(number), "--repo", repo, "--body", body], { cwd, timeoutMs: 20_000 })
  if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 300) || `gh exited ${r.code}`)
}
