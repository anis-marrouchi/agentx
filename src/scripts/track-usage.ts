#!/usr/bin/env tsx
import { TokenTracker } from "../daemon/token-tracker"

const date = process.argv[2] // optional: specific date (YYYY-MM-DD)
const tracker = new TokenTracker()
const report = tracker.generateDailyReport(date)

if (!report || report.totalTasks === 0) {
  console.log(`No usage data for ${date || "today"}`)
  process.exit(0)
}

tracker.appendToTokenCosts(report)

const fmt = (n: number) => n < 0.01 ? n.toFixed(4) : n.toFixed(2)

console.log(`Appended to TOKEN_COSTS.md:`)
console.log(`  Date:      ${report.date}`)
console.log(`  Tasks:     ${report.totalTasks}`)
console.log(`  Cost:      $${fmt(report.totalCost)}`)
console.log(`  Top agent: ${report.topAgent} ($${fmt(report.topCost)})`)
console.log(`  Breakdown:`)
for (const [id, cost] of Object.entries(report.agentCosts).sort(([, a], [, b]) => b - a)) {
  console.log(`    ${id}: $${fmt(cost)}`)
}
