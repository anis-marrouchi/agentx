import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { daemonConfigSchema } from "../src/daemon/config"
import { CronScheduler } from "../src/crons/scheduler"
import { evaluateAutonomy } from "../src/guard/autonomy"
import { shippedTeam } from "../src/teams/catalog"
import { applyTeam, fillPendingDelivery } from "../src/teams/package"
import { hasSource, unsourcedClaims, withSourceWarning } from "../src/sales/sources"
import { isOptedOut, leadLine, newLeads, parseLeads, parseOptOuts, quietLeads, readOptOuts, recordOptOut } from "../src/sales/leads"
import { changesSince, checkCompetitors, formatChanges, pageLines, parseCompetitors } from "../src/sales/watch"

// Sales (#1288): sourced research and brief, opt-outs, competitor watch,
// and drafts that never leave without the owner.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-sales-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const team = shippedTeam("sales-follow-up")!
const skill = (name: string) => team.agents.sales.skills[name]["SKILL.md"]
/** The example answer in a skill's "Answer format" section. */
const exampleAnswer = (name: string) => skill(name).split("## Answer format")[1].split("```")[1]

describe("every fact has a source", () => {
  it("passes an answer whose every claim links its source", () => {
    const answer = [
      "Summary: 2 leads found.",
      "",
      "## Example Accounting",
      "- Accounting firm with 12 staff. [source](https://example.com/about)",
      "- Contact page: https://example.com/contact",
      "",
      "| Lead | Fact |",
      "|---|---|",
      "| Sample Co | Hiring two sales reps ([jobs](https://sample.example/jobs)) |",
      "",
      "Quiet leads:",
      "- Alex (at Sample Co) [leads.md](leads.md)",
      "- None.",
      "No competitor changes.",
      "```",
      "a code sample is not a claim",
      "```",
    ].join("\n")
    expect(unsourcedClaims(answer)).toEqual([])
    expect(withSourceWarning(answer)).toEqual({ text: answer, unsourced: 0 })
  })

  it("names every line that states a fact without a source", () => {
    const answer = [
      "## Example Accounting",
      "- Accounting firm with 12 staff. [source](https://example.com/about)",
      "- Revenue grew 40% last year.",
      "They are about to raise money.",
      "| Sample Co | Hiring |",
      "- Mentioned on [their blog](blog)",
    ].join("\n")
    expect(unsourcedClaims(answer).map((c) => c.line)).toEqual([3, 4, 5, 6])
    const warned = withSourceWarning(answer)
    expect(warned.unsourced).toBe(4)
    expect(warned.text.startsWith(answer)).toBe(true)
    expect(warned.text).toContain("4 lines above have no source.")
    expect(warned.text).toContain("line 3: - Revenue grew 40% last year.")
  })

  it("does not count a bare domain or a relative link as a source", () => {
    expect(hasSource("- Found on example.com")).toBe(false)
    expect(hasSource("- See [notes](notes.txt)")).toBe(false)
    expect(hasSource("- See http://example.com/x")).toBe(true)
  })

  it("the research and brief skills show answers that pass the check", () => {
    expect(unsourcedClaims(exampleAnswer("lead-research"))).toEqual([])
    expect(unsourcedClaims(exampleAnswer("daily-brief"))).toEqual([])
  })

  describe("on the research and brief schedules", () => {
    const OWNER = { channel: "telegram", chatId: "2000", accountId: "sales" }
    const prevCwd = process.cwd()
    afterEach(() => { process.chdir(prevCwd) })

    async function runOnce(id: string, answer: string) {
      process.chdir(dir)
      const config: any = { node: { id: "demo-node", name: "Demo node" }, agents: {}, crons: {} }
      applyTeam(config, team, { workspaceRoot: join(dir, "agents"), timezone: "UTC" })
      config.notifications = { destination: OWNER }
      fillPendingDelivery(config, OWNER)
      const s: any = new CronScheduler(daemonConfigSchema.parse(config) as any, { execute: vi.fn(async () => ({ duration: 5, content: answer })) } as any, undefined, () => {})
      s.scheduleNext = () => {}
      s.scheduleRetry = () => {}
      s.running = true
      const deliver = vi.fn(async () => {})
      s.setDeliverCallback(deliver)
      await s.executeJob(id)
      const runDir = join(dir, ".agentx/cron/runs", id)
      const record = JSON.parse(readFileSync(join(runDir, readdirSync(runDir)[0]), "utf-8"))
      return { delivered: (deliver.mock.calls[0] as any[])[2] as string, record }
    }

    it("research is delivered as written when every claim has a URL", async () => {
      const answer = exampleAnswer("lead-research")
      const { delivered, record } = await runOnce("sales-weekly-research", answer)
      expect(delivered).toBe(answer)
      expect(record.unsourced).toBeUndefined()
    })

    it("a claim without a URL is pointed out to the owner and counted on the run", async () => {
      const answer = "## Example Accounting\n- Accounting firm. [source](https://example.com/about)\n- Their CEO is leaving."
      const { delivered, record } = await runOnce("sales-daily-brief", answer)
      expect(delivered).toContain("⚠ 1 line above has no source.")
      expect(delivered).toContain("line 3: - Their CEO is leaving.")
      expect(record.unsourced).toBe(1)
      // The run record keeps the answer as the agent wrote it.
      expect(record.response).toBe(answer)
    })

    it("follow-up drafts are not source-checked", async () => {
      const { delivered } = await runOnce("sales-monday-follow-ups", "2 leads are quiet.\n\nSam: Hi Sam, ...")
      expect(delivered).toBe("2 leads are quiet.\n\nSam: Hi Sam, ...")
    })
  })
})

describe("leads and opt-outs", () => {
  const LEADS = [
    "# Leads",
    "- Sam | Example Ltd | last contact 2026-01-01 | offered: quote | next: call back",
    "- Alex | Sample Co | last contact 2026-01-09 | next: send demo",
    "- Kim | Example Ltd | last contact 2025-12-01 | next: done",
    "- Robin | Demo GmbH | added 2026-01-10",
    "- Jo | Sample Co | last contact 2025-12-20 | added 2025-12-20",
  ].join("\n")
  const TODAY = "2026-01-10"

  it("reads leads.md", () => {
    const leads = parseLeads(LEADS)
    expect(leads.map((l) => l.name)).toEqual(["Sam", "Alex", "Kim", "Robin", "Jo"])
    expect(leads[0]).toMatchObject({ company: "Example Ltd", lastContact: "2026-01-01", offered: "quote", next: "call back" })
  })

  it("finds quiet and new leads", () => {
    const leads = parseLeads(LEADS)
    expect(quietLeads(leads, [], TODAY).map((l) => l.name)).toEqual(["Sam", "Jo"])
    expect(newLeads(leads, [], TODAY).map((l) => l.name)).toEqual(["Robin"])
    expect(leadLine(leads[0])).toBe("- Sam (at Example Ltd, last contact 2026-01-01, next: call back) [leads.md](leads.md)")
    expect(hasSource(leadLine(leads[0]))).toBe(true)
  })

  it("leaves opted-out people out of every list", () => {
    const leads = parseLeads(LEADS)
    const optOuts = parseOptOuts("- Sam | Example Ltd | 2026-01-05 | asked by email\n- Robin |  | 2026-01-10")
    expect(quietLeads(leads, optOuts, TODAY).map((l) => l.name)).toEqual(["Jo"])
    expect(newLeads(leads, optOuts, TODAY)).toEqual([])
    // A company on the opt-out limits it to that company; none means everywhere.
    expect(isOptedOut({ name: "sam", company: "example ltd" }, optOuts)).toBe(true)
    expect(isOptedOut({ name: "Sam", company: "Other Inc" }, optOuts)).toBe(false)
    expect(isOptedOut({ name: "Robin", company: "Anywhere" }, optOuts)).toBe(true)
  })

  it("records an opt-out once", () => {
    expect(recordOptOut(dir, { name: "Sam", company: "Example Ltd", reason: "replied stop" }, TODAY)).toBe(true)
    expect(recordOptOut(dir, { name: "sam", company: "example ltd" }, "2026-01-11")).toBe(false)
    expect(recordOptOut(dir, { name: "Alex|x\ny" }, TODAY)).toBe(true)
    const file = readFileSync(join(dir, "opt-outs.md"), "utf-8")
    expect(file).toContain("- Sam | Example Ltd | 2026-01-10 | replied stop\n")
    expect(readOptOuts(dir)).toEqual([
      { name: "Sam", company: "Example Ltd", date: "2026-01-10", reason: "replied stop" },
      { name: "Alex x y", company: "", date: "2026-01-10", reason: undefined },
    ])
    expect(() => recordOptOut(dir, { name: " " }, TODAY)).toThrow(/name/)
  })
})

describe("competitor watch", () => {
  const PAGE = (plan: string) => `<html><head><title>Rival</title><style>p{}</style></head><body>
    <h1>Pricing</h1><p>Starter plan &amp; support</p><p>${plan}</p><script>var t = Date.now()</script></body></html>`

  it("reads competitors.md and the visible text of a page", () => {
    expect(parseCompetitors("# Watch\n- Example Rival | https://rival.example/pricing\n- https://other.example/\nhttps://not-a-list.example\n")).toEqual([
      { name: "Example Rival", url: "https://rival.example/pricing" },
      { name: "other.example", url: "https://other.example/" },
    ])
    expect(pageLines(PAGE("Team plan 19 per month"))).toEqual(["Pricing", "Starter plan & support", "Team plan 19 per month"])
  })

  it("reports only what changed, with the page's URL on every line", async () => {
    writeFileSync(join(dir, "competitors.md"), "- Example Rival | https://rival.example/pricing\n- Sample Rival | https://sample.example/\n")
    const pages: Record<string, string> = {
      "https://rival.example/pricing": PAGE("Team plan 19 per month"),
      "https://sample.example/": "<p>Hello</p>",
    }
    const fetcher = async (url: string) => pages[url]

    const first = await checkCompetitors(dir, fetcher, new Date("2026-01-09T07:30:00Z"))
    expect(first.changes).toEqual([])
    expect(first.baselined.map((c) => c.name)).toEqual(["Example Rival", "Sample Rival"])

    // Same pages: nothing to report.
    const same = await checkCompetitors(dir, fetcher, new Date("2026-01-09T08:00:00Z"))
    expect(same).toMatchObject({ changes: [], baselined: [], unchanged: 2 })

    pages["https://rival.example/pricing"] = PAGE("Team plan 25 per month")
    const changed = await checkCompetitors(dir, fetcher, new Date("2026-01-10T07:30:00Z"))
    expect(changed.changes).toEqual([{
      at: "2026-01-10T07:30:00.000Z", name: "Example Rival", url: "https://rival.example/pricing",
      added: ["Team plan 25 per month"], removed: ["Team plan 19 per month"],
    }])
    const lines = formatChanges(changed.changes)
    expect(lines).toEqual([
      "- [Example Rival](https://rival.example/pricing) added: \"Team plan 25 per month\"",
      "- [Example Rival](https://rival.example/pricing) removed: \"Team plan 19 per month\"",
    ])
    expect(unsourcedClaims(lines.join("\n"))).toEqual([])

    // The brief reads the recorded changes for its window.
    expect(changesSince(dir, new Date("2026-01-09T08:30:00Z")).map((c) => c.at)).toEqual(["2026-01-10T07:30:00.000Z"])
    expect(changesSince(dir, new Date("2026-01-10T08:30:00Z"))).toEqual([])
  })

  it("keeps the last snapshot when a page cannot be fetched", async () => {
    writeFileSync(join(dir, "competitors.md"), "- Example Rival | https://rival.example/pricing\n")
    await checkCompetitors(dir, async () => PAGE("Plan A"))
    const failed = await checkCompetitors(dir, async () => { throw new Error("HTTP 503") })
    expect(failed.failed).toEqual([{ competitor: { name: "Example Rival", url: "https://rival.example/pricing" }, error: "HTTP 503" }])
    const back = await checkCompetitors(dir, async () => PAGE("Plan B"))
    expect(back.changes[0]).toMatchObject({ added: ["Plan B"], removed: ["Plan A"] })
  })
})

describe("outreach waits for the owner", () => {
  it("every sales schedule is read-only, and drafts go to the owner", () => {
    for (const [id, s] of Object.entries(team.schedules)) {
      expect(s.autonomy, id).toBe("report")
      expect(s.prompt, id).toMatch(/do not (send|contact|add)|answer with its output/i)
    }
    expect(team.agents.sales.systemPrompt).toContain("you never send them yourself")
  })

  it("a report run cannot send, write or change opt-outs, but can run the sales checks", () => {
    const allowed = (input: { tool: string; command?: string }) => evaluateAutonomy("report", input).allowed
    for (const tool of ["mcp__gmail__send_email", "mcp__telegram__send_message", "mcp__linkedin__post_message", "Write", "Edit"]) {
      expect(allowed({ tool }), tool).toBe(false)
    }
    expect(allowed({ tool: "WebSearch" })).toBe(true)
    expect(allowed({ tool: "WebFetch" })).toBe(true)
    for (const command of ["agentx sales leads --quiet-only", "agentx sales changes --since 24h", "agentx sales watch", "agentx sales check -"]) {
      expect(allowed({ tool: "Bash", command }), command).toBe(true)
    }
    for (const command of ["agentx sales opt-out Sam", "agentx send sales hi", "agentx team add x", "agentx sales leads > leads.md"]) {
      expect(allowed({ tool: "Bash", command }), command).toBe(false)
    }
  })
})
