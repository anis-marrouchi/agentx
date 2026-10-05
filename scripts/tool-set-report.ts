// Report on the tool-set seat's shadow rows (#455): for fresh claude-code
// sessions, which bundle of built-in tools the policy would have started
// with, against the smallest bundle the run actually needed. Reads the
// decision store only; changes nothing.
//
//   pnpm exec tsx scripts/tool-set-report.ts                 # from the daemon's folder
//   pnpm exec tsx scripts/tool-set-report.ts --since 7d --path .agentx/decisions/decisions.sqlite
//
// A "miss" is a session the policy would have started with too few tools:
// in active mode the agent would have reached for a tool it did not have.
// The miss rate decides whether the seat may ever go active.

import { resolve } from "node:path"
import { DecisionStore } from "../src/decisions/store"
import { TOOL_BUNDLES, TOOL_SET_SEAT, bundleFor, isMiss, type ToolBundle } from "../src/decisions/seats/tool-set"

export interface Row { probabilities: Record<string, number>; truth?: string; predicted: string }

export interface RiskLine {
  risk: number
  graded: number
  picked: Record<ToolBundle, number>
  misses: number
  missRate: number
  /** Sessions that would have started with fewer tools than "full". */
  smaller: number
}

export function summarize(rows: Row[], risks: number[]): { total: number; graded: number; needed: Record<ToolBundle, number>; lines: RiskLine[] } {
  const graded = rows.filter((r) => r.truth && (TOOL_BUNDLES as readonly string[]).includes(r.truth))
  const needed = { answer: 0, code: 0, full: 0 } as Record<ToolBundle, number>
  for (const r of graded) needed[r.truth as ToolBundle]++
  const lines = risks.map((risk) => {
    const picked = { answer: 0, code: 0, full: 0 } as Record<ToolBundle, number>
    let misses = 0
    for (const r of graded) {
      const b = bundleFor({ bundle: { probabilities: r.probabilities } }, risk)
      picked[b]++
      if (isMiss(b, r.truth as ToolBundle)) misses++
    }
    return {
      risk, graded: graded.length, picked, misses,
      missRate: graded.length ? misses / graded.length : 0,
      smaller: picked.answer + picked.code,
    }
  })
  return { total: rows.length, graded: graded.length, needed, lines }
}

export function render(s: ReturnType<typeof summarize>): string {
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "-")
  const out: string[] = []
  out.push(`tool-set shadow rows: ${s.total}, graded (run finished and streamed its tool calls): ${s.graded}`)
  out.push(`Needed, by the tools the runs called: answer ${s.needed.answer}, code ${s.needed.code}, full ${s.needed.full}`)
  out.push("")
  out.push("| Risk limit | Would start: answer / code / full | Started smaller than full | Misses (too few tools) |")
  out.push("|---|---|---|---|")
  for (const l of s.lines) {
    out.push(`| ${l.risk} | ${l.picked.answer} / ${l.picked.code} / ${l.picked.full} | ${l.smaller} (${pct(l.smaller, l.graded)}) | ${l.misses} (${pct(l.misses, l.graded)}) |`)
  }
  return out.join("\n")
}

function parseSince(v?: string): number | undefined {
  if (!v) return undefined
  const m = /^(\d+)([dh])$/.exec(v)
  if (m) return Date.now() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000)
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

function main(): void {
  const args = process.argv.slice(2)
  const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const path = resolve(opt("--path") ?? ".agentx/decisions/decisions.sqlite")
  const store = new DecisionStore({ path })
  const rows = store.gradedRows({ seat: TOOL_SET_SEAT, question: "bundle", since: parseSince(opt("--since")) })
  console.log(render(summarize(rows, [0.05, 0.1, 0.2])))
  store.close()
}

if (process.argv[1]?.endsWith("tool-set-report.ts")) main()
