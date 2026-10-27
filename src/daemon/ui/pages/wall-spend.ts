// --- Month spend on the Wall agent profile (#1393) ---
//
// One line under the profile's stats: what the agent spent this month (UTC)
// against its cap, from the row GET /api/admin/observability/budgets
// already returns for the Wall's Cost page. No second sum.
//
// Shipped to the browser through injectFns, so it is self-contained: it
// formats on its own, with the same money format as the Cost page
// (wall-cost.ts) so the two figures match. It prints only numbers and fixed text, so nothing needs
// escaping. Read-only: a cap is raised on the Wall's Cost page.

/** The part of a budgets row the line reads (BudgetRow in src/agents/agent-budget.ts). */
export interface SpendRow {
  spentUsd: number
  capUsd?: number
  state: "ok" | "warn" | "paused" | "uncapped"
  unpricedRuns?: number
}

/**
 * The profile's spend line. `row` is the agent's budgets row (missing when
 * it has no spend and no cap this month); `fleet` is the fleet row, whose
 * cap pauses every agent; `agentIds` are the agents in this machine's
 * config. `null` budgets (not loaded, or the read failed) show nothing.
 * Spend is summed per machine, so an agent with no row that is not in
 * `agentIds` runs on another machine: say so rather than show $0.
 */
export function profileSpendHtml(budgets: { agents?: Array<SpendRow & { agentId: string }>; fleet?: SpendRow; agentIds?: string[] } | null, id: string): string {
  if (!budgets) return ""
  // The Cost page's money format (wall-cost.ts), kept the same.
  const usd = (v: number): string => {
    let n = Number(v)
    if (!isFinite(n)) n = 0
    if (Math.abs(n) >= 10000) return "$" + (n / 1000).toFixed(1) + "K"
    if (n === 0) return "$0"
    if (Math.abs(n) < 0.01) return "$" + n.toFixed(4)
    return "$" + n.toFixed(2)
  }
  const found = (budgets.agents || []).find((r) => r.agentId === id)
  if (!found && budgets.agentIds && budgets.agentIds.indexOf(id) < 0) {
    return '<div class="wpf__spend">Spend this month is kept on the machine this agent runs on.</div>'
  }
  const row: SpendRow = found || { spentUsd: 0, state: "uncapped" }
  const text = row.capUsd
    ? "Spent <b>" + usd(row.spentUsd) + "</b> of " + usd(row.capUsd) + " this month"
    : "Spent <b>" + usd(row.spentUsd) + "</b> this month · no cap"
  const chip = row.state === "paused" ? '<span class="chip chip--err">paused: cap reached</span>'
    : budgets.fleet && budgets.fleet.state === "paused" ? '<span class="chip chip--err">paused: fleet cap reached</span>'
    : row.state === "warn" ? '<span class="chip chip--warn">near cap</span>'
    : ""
  const unpriced = row.unpricedRuns
    ? ' <span title="Runs on a model with no price, such as a local model. The cap does not count them.">· ' + Number(row.unpricedRuns) + " not priced</span>"
    : ""
  return '<div class="wpf__spend">' + text + unpriced + (chip ? " " + chip : "") +
    ' <a href="#status=open&amp;view=cost" title="Spend and caps for every agent; raise a cap there">Cost</a></div>'
}
