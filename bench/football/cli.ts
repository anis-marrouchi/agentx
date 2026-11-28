// Football bench CLI (#2567).
//
//   pnpm bench:football                                   # free-talk vs cue, seed 1
//   pnpm bench:football --home cue --away free-talk --seed 7 --ticks 300 --budget 2
//   pnpm bench:football --experiment --seed 7             # same seed, both talk styles, side by side
//   pnpm bench:football --out match.json                  # keep the full record
//   pnpm bench:football --replay match.json               # re-apply the record, check it, rescore
//
// No model is called: the seats are scripted baselines (policies.ts).

import { readFileSync, writeFileSync } from "node:fs"
import { measure, type TeamMeasures } from "./measures"
import { POLICIES } from "./policies"
import { playMatch, replayMatch, type MatchLog } from "./referee"

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const num = (name: string, d: number) => (flag(name) === undefined ? d : Number(flag(name)))

const ROWS: [string, (m: TeamMeasures) => string][] = [
  ["goals", (m) => String(m.goals)],
  ["passes landed / tried", (m) => `${m.passesLanded} / ${m.passesTried}`],
  ["messages (dropped)", (m) => `${m.messages} (${m.dropped})`],
  ["goals per 100 messages", (m) => (m.goalsPer100Messages === null ? "-" : m.goalsPer100Messages.toFixed(2))],
  ["collisions", (m) => String(m.collisions)],
  ["turnovers lost", (m) => String(m.turnoversLost)],
  ["awareness (ticks)", (m) => (m.awarenessTicks === null ? "-" : m.awarenessTicks.toFixed(2))],
]

function table(log: MatchLog): string {
  const m = measure(log)
  const head = `seed ${log.options.seed}, ${log.ticks.length} ticks, budget ${log.options.messageBudget}/tick`
  const lines = [head, `| measure | A: ${log.teams.A} | B: ${log.teams.B} |`, "|---|---|---|"]
  for (const [label, f] of ROWS) lines.push(`| ${label} | ${f(m.A)} | ${f(m.B)} |`)
  return lines.join("\n")
}

async function main() {
  const replay = flag("--replay")
  if (replay) {
    const log = JSON.parse(readFileSync(replay, "utf8")) as MatchLog
    const r = replayMatch(log)
    process.stdout.write(`${table(log)}\nreplay: ${r.mismatchAt === null ? "identical" : `differs at tick ${r.mismatchAt}`}\n`)
    process.exit(r.mismatchAt === null ? 0 : 1)
  }
  const opts = { seed: num("--seed", 1), ticks: num("--ticks", 200), messageBudget: num("--budget", 2) }
  const pick = (name: string) => {
    const p = POLICIES[name]
    if (!p) { process.stderr.write(`unknown policy ${name}; known: ${Object.keys(POLICIES).join(", ")}\n`); process.exit(2) }
    return p
  }
  if (args.includes("--experiment")) {
    // Same seed, each talk style plays the same opponent from the same side.
    const opponent = pick(flag("--away") ?? "free-talk")
    for (const home of ["free-talk", "cue"]) process.stdout.write(`${table(await playMatch(pick(home), opponent, opts))}\n\n`)
    return
  }
  const log = await playMatch(pick(flag("--home") ?? "free-talk"), pick(flag("--away") ?? "cue"), opts)
  const out = flag("--out")
  if (out) writeFileSync(out, JSON.stringify(log))
  process.stdout.write(`${table(log)}\n`)
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1) })
