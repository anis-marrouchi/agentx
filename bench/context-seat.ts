// Labelled check of the request-context seat on the landscape sections
// (#455): for messages whose needs are known, which sections does the seat
// drop, how often does it drop one the message needs, and how much prompt
// does that save. Runs the seat for real through a decision backend (the
// local one by default: Claude Code with Haiku), outside the daemon, into
// a throwaway decision store.
//
//   pnpm tsx bench/context-seat.ts                    # each case once
//   pnpm tsx bench/context-seat.ts --repeats 3 --json out.json
//   pnpm tsx bench/context-seat.ts --backend jev      # needs OPENROUTER_API_KEY
//
// Every case is one seat call (cents on Haiku). The demo node, agents and
// messages are neutral examples.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configureDecisions, registerBuiltinDecisionBackends, DecisionStore } from "../src/decisions"
import { LandscapeBuilder } from "../src/agents/landscape"
import { selectRequestContext, splitLandscape } from "../src/agents/request-planner"

export type SectionId = "landscape" | "landscape.messaging" | "landscape.recall" | "landscape.monitoring" | "landscape.teams"
export const SECTION_IDS: SectionId[] = ["landscape", "landscape.messaging", "landscape.recall", "landscape.monitoring", "landscape.teams"]

export interface Case { message: string; needs: SectionId[] }

/** What each message needs from the landscape. Everything else is safe to
 *  drop for it. Labels are deliberately narrow: "needs" means the reply is
 *  wrong or impossible without the section, not that it might be handy. */
export const CASES: Case[] = [
  { message: "Ask the ops agent to check whether last night's backup finished.", needs: ["landscape"] },
  { message: "Who on this node can help me with an invoice question?", needs: ["landscape"] },
  { message: "Tell the design agent the mockups are approved.", needs: ["landscape"] },
  { message: "Post the release notes in the team's Telegram group.", needs: ["landscape.messaging"] },
  { message: "Send this summary as a comment on the GitLab issue for the login bug.", needs: ["landscape.messaging"] },
  { message: "Continue with what we discussed yesterday about the pricing page.", needs: ["landscape.recall"] },
  { message: "As I said earlier, go with the second option.", needs: ["landscape.recall"] },
  { message: "Watch the deploy logs and tell me as soon as errors show up.", needs: ["landscape.monitoring"] },
  { message: "Review this large pull request for security, performance and test coverage in parallel.", needs: ["landscape.teams"] },
  { message: "Fix the failing test in src/cart.js.", needs: [] },
  { message: "Rename the function parseDate to parseIsoDate across the repository.", needs: [] },
  { message: "What does this error mean: TypeError: undefined is not a function?", needs: [] },
  { message: "Write a unit test for formatCents in src/money.js.", needs: [] },
  { message: "Explain how the retry logic in src/client.ts works.", needs: [] },
  { message: "Thanks, that's all for today.", needs: [] },
  { message: "Good morning!", needs: [] },
]

const DEMO_CONFIG: any = {
  node: { id: "demo", name: "Demo node", bind: "127.0.0.1:19900" },
  agents: {
    helper: { name: "Helper", tier: "claude-code", systemPrompt: "General assistant for the team.", mentions: ["@helper_bot"] },
    ops: { name: "Ops", tier: "claude-code", systemPrompt: "Runs servers, backups and deploys.", mentions: ["@ops_bot"] },
    design: { name: "Design", tier: "claude-code", systemPrompt: "Designs screens and reviews mockups.", mentions: ["@design_bot"] },
    finance: { name: "Finance", tier: "claude-code", systemPrompt: "Answers invoice and billing questions.", mentions: ["@finance_bot"] },
  },
  channels: {
    telegram: { enabled: true, policy: { group: "mention", dm: "open" } },
    gitlab: { enabled: true },
    whatsapp: { enabled: false },
  },
}

export interface CaseResult {
  message: string
  needs: SectionId[]
  dropped: string[]
  wrongDrops: SectionId[]
  savedChars: number
  ms: number
}

/** Score one seat answer against a case's labels. */
export function scoreCase(c: Case, dropped: string[], sectionChars: Record<string, number>, ms: number): CaseResult {
  const wrongDrops = c.needs.filter((id) => dropped.includes(id))
  const savedChars = dropped.reduce((n, id) => n + (sectionChars[id] ?? 0), 0)
  return { message: c.message, needs: c.needs, dropped, wrongDrops, savedChars, ms }
}

export function summarize(results: CaseResult[], sectionChars: Record<string, number>, landscapeChars: number): string {
  const lines: string[] = []
  const total = results.length
  const wrong = results.filter((r) => r.wrongDrops.length).length
  const saved = results.reduce((n, r) => n + r.savedChars, 0) / Math.max(1, total)
  lines.push(`Cases: ${total}. Landscape: ${landscapeChars} characters.`)
  lines.push(`Turns with a wrong drop (a needed section removed): ${wrong}/${total}.`)
  lines.push(`Average saved per turn: ${Math.round(saved)} characters (${Math.round((saved / landscapeChars) * 100)}% of the landscape).`)
  lines.push("", "| Section | Characters | Needed by | Dropped when needed | Dropped when not needed |", "|---|---|---|---|---|")
  for (const id of SECTION_IDS) {
    const needed = results.filter((r) => r.needs.includes(id))
    const notNeeded = results.filter((r) => !r.needs.includes(id))
    lines.push(`| ${id} | ${sectionChars[id] ?? 0} | ${needed.length} | ${needed.filter((r) => r.dropped.includes(id)).length}/${needed.length} | ${notNeeded.filter((r) => r.dropped.includes(id)).length}/${notNeeded.length} |`)
  }
  lines.push("", "| Message | Needs | Dropped | Wrong |", "|---|---|---|---|")
  for (const r of results) {
    lines.push(`| ${r.message} | ${r.needs.join(", ") || "none"} | ${r.dropped.join(", ") || "none"} | ${r.wrongDrops.join(", ") || ""} |`)
  }
  return lines.join("\n")
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  const repeats = Math.max(1, Number(opt("--repeats") ?? 1))
  const backend = opt("--backend") ?? "local"
  const json = opt("--json")

  const dir = mkdtempSync(join(tmpdir(), "context-seat-"))
  registerBuiltinDecisionBackends({}, {}, {}, {})
  configureDecisions({
    enabled: true,
    defaultBackend: backend,
    store: new DecisionStore({ path: join(dir, "decisions.sqlite") }),
    seats: { "request-context": { mode: "active", backend, timeoutMs: 60_000 } },
  })

  const builder = new LandscapeBuilder(DEMO_CONFIG)
  builder.build()
  const landscape = builder.getForAgent("helper")!
  const sectionChars: Record<string, number> = {}
  for (const s of splitLandscape(landscape)) if (s.id) sectionChars[s.id] = s.text.length

  const results: CaseResult[] = []
  for (let r = 0; r < repeats; r++) {
    for (const c of CASES) {
      const started = Date.now()
      const out = await selectRequestContext({
        agentId: "helper", agentName: "Helper", channel: "telegram", channelScope: "group",
        sender: "User", message: c.message, landscape,
      } as any, { timeoutMs: 120_000 })
      const result = scoreCase(c, out.excluded, sectionChars, Date.now() - started)
      results.push(result)
      console.error(`${result.wrongDrops.length ? "WRONG" : "ok   "} ${c.message.slice(0, 60)} -> dropped ${out.excluded.join(", ") || "none"} (${result.ms}ms)`)
    }
  }
  console.log(summarize(results, sectionChars, landscape.length))
  if (json) writeFileSync(json, JSON.stringify({ backend, repeats, sectionChars, landscapeChars: landscape.length, results }, null, 2) + "\n")
  rmSync(dir, { recursive: true, force: true })
}

if (process.argv[1]?.endsWith("context-seat.ts")) main().catch((e) => { console.error(e); process.exit(1) })
