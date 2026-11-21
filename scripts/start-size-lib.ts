// Pure part of scripts/start-size.ts (#2002): start size per agent from the
// task_traces.start_tokens column (#2009). No I/O here, so it is tested.

export interface StartRow { agent_id: string; start_tokens: number }

export interface AgentStartSize {
  agent: string
  starts: number
  median: number
  mean: number
  p90: number
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[i]
}

/** One line per agent, most starts first. Rows with no size are skipped. */
export function startSizes(rows: StartRow[]): AgentStartSize[] {
  const byAgent = new Map<string, number[]>()
  for (const r of rows) {
    if (typeof r.start_tokens !== "number" || !Number.isFinite(r.start_tokens)) continue
    const list = byAgent.get(r.agent_id) ?? []
    list.push(r.start_tokens)
    byAgent.set(r.agent_id, list)
  }
  return [...byAgent.entries()].map(([agent, sizes]) => {
    const sorted = [...sizes].sort((a, b) => a - b)
    return {
      agent,
      starts: sorted.length,
      median: quantile(sorted, 0.5),
      mean: Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length),
      p90: quantile(sorted, 0.9),
    }
  }).sort((a, b) => b.starts - a.starts || a.agent.localeCompare(b.agent))
}

/** A markdown table, ready to paste on the issue. */
export function startSizeTable(sizes: AgentStartSize[]): string {
  const lines = ["| Agent | Starts | Median | Mean | p90 |", "|---|---:|---:|---:|---:|"]
  for (const s of sizes) lines.push(`| ${s.agent} | ${s.starts} | ${s.median} | ${s.mean} | ${s.p90} |`)
  return lines.join("\n")
}
