// Before/after for the lean session profile (#615): what agentx hands a
// fresh session on each automation channel, full profile against lean,
// section by section.
//
//   pnpm bench:profiles                              # github, a2a, workflow, cron
//   pnpm bench:profiles --channels github,telegram   # pick channels
//   pnpm bench:profiles --exact                      # exact counts (ANTHROPIC_API_KEY)
//   pnpm bench:profiles --warm 2                     # two earlier turns on the
//                                                    # chat and one side chat
//   pnpm bench:profiles --json
//
// Same fake `claude` as context-size.ts, so nothing is billed. The measured
// run is the third turn on its chat by default (--warm 2): that is when the
// full profile has a history and a cross-chat hint to push, which a first
// contact never has. Both profiles are measured from the same state.
//
// What it cannot count: Claude Code's own start (built-in tool schemas,
// the skill list, user-level MCP tool schemas, the global CLAUDE.md). Those
// are the flags row; issue #615 holds their measured sizes.

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { flag, measure, type Measurement } from "./context-size"

const DEFAULT_CHANNELS = ["github", "a2a", "workflow", "cron"]
// Mentions a peer and earlier work, so the full profile pushes its
// cross-chat hint: that is the shape of a real a2a or GitHub prompt.
const DEFAULT_TASK = "Continuing from what @helper_bot mentioned earlier: fix the failing test and make sure the whole suite passes."

interface Row { section: string; full: number; lean: number; fullChars: number; leanChars: number }

interface ChannelResult { channel: string; rows: Row[]; fullTotal: number; leanTotal: number; fullFlags: string[]; leanFlags: string[] }

export function compareRows(full: Measurement, lean: Measurement): Row[] {
  const names = [...new Set([...full.sections, ...lean.sections].map((s) => s.name))]
  return names.map((section) => {
    const f = full.sections.find((s) => s.name === section), l = lean.sections.find((s) => s.name === section)
    return { section, full: f?.tokens ?? 0, lean: l?.tokens ?? 0, fullChars: f?.text.length ?? 0, leanChars: l?.text.length ?? 0 }
  })
}

export function renderTable(results: ChannelResult[], exact: boolean): string {
  const mark = exact ? "" : "≈"
  const pct = (a: number, b: number) => a === 0 ? "–" : `${Math.round((1 - b / a) * 100)}%`
  const lines = [
    `| Channel | Section | full (tokens / chars) | lean (tokens / chars) | saved |`,
    `|---|---|---|---|---|`,
  ]
  for (const r of results) {
    for (const row of r.rows) {
      lines.push(`| ${r.channel} | ${row.section} | ${mark}${row.full} / ${row.fullChars} | ${mark}${row.lean} / ${row.leanChars} | ${pct(row.full, row.lean)} |`)
    }
    lines.push(`| ${r.channel} | **total added by agentx** | **${mark}${r.fullTotal}** | **${mark}${r.leanTotal}** | **${pct(r.fullTotal, r.leanTotal)}** |`)
    lines.push(`| ${r.channel} | claude flags | ${r.fullFlags.join("; ") || "none"} | ${r.leanFlags.join("; ") || "none"} | see #615 |`)
  }
  return lines.join("\n")
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const channels = (flag(args, "--channels") ?? DEFAULT_CHANNELS.join(",")).split(",").map((c) => c.trim()).filter(Boolean)
  const exact = args.includes("--exact")
  const shared = {
    task: flag(args, "--message") ?? DEFAULT_TASK,
    sections: true,
    exact,
    apiKey: process.env.ANTHROPIC_API_KEY,
    configPath: flag(args, "--config"),
    agentId: flag(args, "--agent"),
    warmTurns: Number(flag(args, "--warm") ?? 2),
  }
  const results: ChannelResult[] = []
  for (const channel of channels) {
    const full = await measure({ ...shared, channel, profile: "full" })
    const lean = await measure({ ...shared, channel, profile: "lean" })
    results.push({ channel, rows: compareRows(full, lean), fullTotal: full.total, leanTotal: lean.total, fullFlags: full.flags, leanFlags: lean.flags })
  }
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ exact, results }) + "\n")
  } else {
    console.log(renderTable(results, exact))
    if (!exact) console.log("\nEstimates at ~4 chars per token; --exact for real counts. Claude Code's own start is not counted: see the flags row and issue #615.")
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e?.stderr?.toString() || e?.message || e); process.exit(1) })
}
