// Does a wider state make the continuity seat's question answerable?
//
//   pnpm tsx scripts/bench-jev-state.ts [--turns 3] [--backend typesafe]
//
// The full harness (bench-jev.ts) spawns real agent turns, because it is
// measuring what the seat does to an agent's token bill. This one is not.
// The question here is narrower — can Jev SEPARATE a subject change from a
// follow-up — and that is answered by asking Jev, with no agent in the
// loop at all. Sixty agent dispatches and half an hour become forty
// decision calls and about a minute, so the experiment is cheap enough to
// actually iterate on.
//
// It is a probe, not a benchmark. A win here means the numbers separate,
// which is a precondition for the seat working, not proof that it saves
// tokens. Confirm any win with bench-jev.ts before believing it.
//
// WHY THIS EXISTS.
//
// The full benchmark found that on subject changes with no lexical
// signpost, Jev was genuinely unsure — `continues` 0.58 where a clean,
// signposted change scored 0.22. No policy threshold recovers a number
// that never separated in the first place, so the thresholds were the
// wrong thing to tune. The suspect is the state: two message texts is a
// thin basis for "is this the same piece of work".
//
// WHAT IT REPORTS.
//
// Accuracy is not the headline — SEPARATION is. The gap between the mean
// noul on turns that should rotate and on turns that should not is what
// any threshold has to live inside. A change that lifts accuracy while
// narrowing that gap has made the seat more brittle, not better, and
// would look like progress on an accuracy-only report.

import { resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"
import {
  registerBuiltinDecisionBackends,
  getDecisionBackend,
  type NoulAnswer,
} from "@/decisions"
import {
  continuityState,
  sessionContinuityQuestions,
  shouldRotateEarly,
  SESSION_CONTINUITY_SEAT,
  type ContinuityInput,
  type SessionContinuityAnswers,
} from "@/decisions/seats/session-continuity"
import { SCENARIOS, type BenchScenario, type Expectation } from "./bench-jev-scenarios"

interface Probe {
  scenario: string
  message: string
  expect: Expectation
  continues: number
  needsHistory: number
  rotates: boolean
  latencyMs: number
}

function parseArgs(argv: string[]) {
  const get = (n: string, d?: string) => {
    const i = argv.indexOf(`--${n}`)
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1]
    const inline = argv.find((a) => a.startsWith(`--${n}=`))
    return inline ? inline.slice(n.length + 3) : d
  }
  return {
    turns: Number(get("turns", "3")),
    backend: get("backend"),
    json: argv.includes("--json"),
  }
}

/** Replay a scenario as a conversation, asking the seat's question at each
 *  labelled turn. `width` is how many requests BEFORE the immediate
 *  predecessor go into the state; 0 reproduces today's call exactly. */
async function probeScenario(
  scenario: BenchScenario,
  width: number,
  backendName: string,
  model: string | undefined,
): Promise<Probe[]> {
  const backend = getDecisionBackend(backendName)
  const out: Probe[] = []
  const asked: string[] = [] // every request so far, oldest first

  for (const turn of scenario.turns) {
    if (turn.expect && asked.length >= 1) {
      const previousMessage = asked[asked.length - 1]
      const earlier = width > 0 ? asked.slice(Math.max(0, asked.length - 1 - width), asked.length - 1) : []

      const input: ContinuityInput = {
        message: turn.message,
        previousMessage,
        recentRequests: earlier,
        // Held fixed across both arms. These are covariates, not the thing
        // under test, and varying them would confound the comparison.
        minutesSinceLastTurn: 1,
        turnCount: asked.length,
        lastTurnContextTokens: 50_000,
        agentId: "bench-agent",
        channel: "bench",
      }

      const started = Date.now()
      const res = await backend.decide({
        state: continuityState(input),
        questions: sessionContinuityQuestions,
        model,
      })
      const answers = res.answers as SessionContinuityAnswers
      const continues = (answers.continues as NoulAnswer).noul
      const needsHistory = (answers.needsHistory as NoulAnswer).noul

      out.push({
        scenario: scenario.name,
        message: turn.message,
        expect: turn.expect,
        continues,
        needsHistory,
        // Default policy, so "rotates" means what production would do.
        rotates: shouldRotateEarly(answers, { mechanicalRotation: false }),
        latencyMs: Date.now() - started,
      })
    }
    asked.push(turn.message)
  }
  return out
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

/** Separation for ONE question, over the two labelled populations. */
function separation(
  rotate: Probe[],
  cont: Probe[],
  pick: (p: Probe) => number,
) {
  const meanRotate = mean(rotate.map(pick))
  const meanCont = mean(cont.map(pick))
  // Worst case is what actually decides: the most continuation-looking
  // subject change vs the most change-looking continuation. When these
  // cross, no single threshold separates them and tuning is theatre.
  const worstRotate = Math.max(...rotate.map(pick))
  const worstCont = Math.min(...cont.map(pick))
  return {
    meanRotate,
    meanCont,
    gap: meanCont - meanRotate,
    worstRotate,
    worstCont,
    separable: worstCont > worstRotate,
    margin: worstCont - worstRotate,
  }
}

function summarise(label: string, probes: Probe[]) {
  const rotate = probes.filter((p) => p.expect === "rotate")
  const cont = probes.filter((p) => p.expect === "continue")

  return {
    label,
    n: probes.length,
    // Both questions, because the seat's own header says needsHistory is
    // the labelled one — it is the question whose error costs the user
    // their context, and reporting only `continues` would hide a seat that
    // separates on the cheap question and not on the expensive one.
    continues: separation(rotate, cont, (p) => p.continues),
    needsHistory: separation(rotate, cont, (p) => p.needsHistory),
    caught: rotate.filter((p) => p.rotates).length,
    shouldRotate: rotate.length,
    amnesia: cont.filter((p) => p.rotates).length,
    latency: Math.round(mean(probes.map((p) => p.latencyMs))),
  }
}

function fmtN(x: number): string {
  return Number.isNaN(x) ? "—" : x.toFixed(2)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = loadDaemonConfig()
  registerBuiltinDecisionBackends()

  const backendName =
    args.backend ??
    (config as { decisions?: { seats?: Record<string, { backend?: string }> } })
      .decisions?.seats?.[SESSION_CONTINUITY_SEAT]?.backend ??
    "jev"
  const model = (config as { decisions?: { seats?: Record<string, { model?: string }> } })
    .decisions?.seats?.[SESSION_CONTINUITY_SEAT]?.model

  const labelled = SCENARIOS.reduce((n, s) => n + s.turns.filter((t) => t.expect).length, 0)
  console.error(
    `probing ${labelled} labelled turns x 2 state widths on backend "${backendName}"\n` +
      `no agent dispatches — decision calls only\n`,
  )

  const arms: Array<{ label: string; width: number }> = [
    { label: `narrow (today)`, width: 0 },
    { label: `wide (+${args.turns})`, width: args.turns },
  ]

  const results: Array<ReturnType<typeof summarise> & { probes: Probe[] }> = []
  for (const arm of arms) {
    const probes: Probe[] = []
    for (const scenario of SCENARIOS) {
      probes.push(...(await probeScenario(scenario, arm.width, backendName, model)))
    }
    results.push({ ...summarise(arm.label, probes), probes })
  }

  const line = "─".repeat(70)
  console.log(line)
  console.log(`Continuity state-width probe · backend ${backendName}`)
  console.log(line)

  const row = (label: string, pick: (r: typeof results[0]) => string) =>
    console.log(`  ${label.padEnd(30)}${results.map((r) => pick(r).padStart(18)).join("")}`)

  console.log(`\n  ${"".padEnd(30)}${results.map((r) => r.label.padStart(18)).join("")}`)
  console.log(`  ${"-".repeat(30 + 18 * results.length)}`)
  row("labelled turns", (r) => String(r.n))
  console.log(`\n  continues`)
  row("  mean — rotate", (r) => fmtN(r.continues.meanRotate))
  row("  mean — continue", (r) => fmtN(r.continues.meanCont))
  row("  mean gap", (r) => fmtN(r.continues.gap))
  row("  worst-case margin", (r) => fmtN(r.continues.margin))
  row("  separable?", (r) => (r.continues.separable ? "yes" : "NO — overlap"))
  console.log(`\n  needsHistory  (the labelled question)`)
  row("  mean — rotate", (r) => fmtN(r.needsHistory.meanRotate))
  row("  mean — continue", (r) => fmtN(r.needsHistory.meanCont))
  row("  mean gap", (r) => fmtN(r.needsHistory.gap))
  row("  worst-case margin", (r) => fmtN(r.needsHistory.margin))
  row("  separable?", (r) => (r.needsHistory.separable ? "yes" : "NO — overlap"))
  console.log("")
  row("caught @ default policy", (r) => `${r.caught}/${r.shouldRotate}`)
  row("amnesia @ default policy", (r) => String(r.amnesia))
  row("mean latency", (r) => `${r.latency}ms`)

  // Per-turn detail for the turns that moved, so a summary number can be
  // traced to the requests that produced it.
  const [narrow, wide] = results
  console.log(`\n  turns where the wider state changed \`continues\` by >0.10:`)
  console.log(`  ${"-".repeat(68)}`)
  let moved = 0
  for (let i = 0; i < narrow.probes.length; i++) {
    const a = narrow.probes[i], b = wide.probes[i]
    if (!b || a.message !== b.message) continue
    const delta = b.continues - a.continues
    if (Math.abs(delta) <= 0.1) continue
    moved++
    const good = a.expect === "rotate" ? delta < 0 : delta > 0
    console.log(
      `  ${good ? "+" : "-"} [${a.expect.padEnd(8)}] ${a.continues.toFixed(2)} → ${b.continues.toFixed(2)}` +
        `  ${a.message.slice(0, 44)}`,
    )
  }
  if (moved === 0) console.log(`  (none — the wider state changed nothing material)`)
  console.log(`\n  "+" = moved toward the correct answer, "-" = away from it.`)
  console.log(line)

  if (args.json) console.log(JSON.stringify(results, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
