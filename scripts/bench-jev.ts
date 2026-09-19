// A/B harness for the JEV session-continuity seat.
//
// The question it answers: does routing the resume/rotate decision through
// Jev cost fewer tokens than the mechanical thresholds do, and does it stay
// correct while doing it?
//
// Run with:
//   pnpm tsx scripts/bench-jev.ts --agent <id>
//   pnpm tsx scripts/bench-jev.ts --agent <id> --jev on --scenario single-thread
//
// --jev is THE flag. `both` (default) runs the A/B back to back in one
// process; `on` / `off` run a single arm when you want to bisect a result.
// --limit N trims the scenario for smoke-testing the harness itself.
//
// TWO ENVIRONMENT REQUIREMENTS, both of which fail quietly if missed.
//
// 1. The claude-code tier spawns the `claude` CLI, which lives in
//    ~/.local/bin and is NOT on a non-login shell's PATH. Without it every
//    turn fails instantly at zero tokens — which would read as the
//    cheapest arm, so `report` refuses to compare when any turn errored.
// 2. better-sqlite3 is a native addon built against the Node the daemon
//    runs (v22). Under a newer Node the decision store will not open, and
//    the seat then answers without recording, so every seat-cost column
//    reads 0. That is refused too.
//
// Both are satisfied by:
//   PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.local/bin:$PATH" \
//     pnpm tsx scripts/bench-jev.ts --agent <id> --yes
//
// WHY THIS SHAPE.
//
// The seat lives inside AgentRegistry.maybeRotateForContinuity, so nothing
// short of a real dispatch exercises it. That means this harness spawns
// real agent turns and spends real tokens — there is no dry-run mode,
// because a dry run would measure the harness rather than the seat.
//
// getSeatMode() reads process.env on every call and never caches, so an
// arm is selected simply by setting the seat's env var before replaying.
// That is also why this cannot drive the daemon over HTTP: the daemon's
// env is fixed at ITS start, not ours. Same reasoning as AgentTask's
// contextStrategy override, which exists for exactly this kind of A/B.
//
// WHAT IT MEASURES, AND THE ONE THAT MATTERS.
//
//   tokens        cumulative input + output + cache across every turn.
//                 Cache reads dominate: --resume replays the transcript,
//                 so this IS the bill the seat is trying to cut.
//   turns         conversation turns replayed (identical across arms, by
//                 construction — it is the denominator, not a result) and
//                 provider turns, the agentic-loop iterations inside them.
//   tokens/turn   the headline number.
//   rotations     the mechanism. Tokens moving without rotations moving
//                 means something other than the seat caused it.
//   correctness   rotations scored against each scenario's `expect`
//                 labels. Read this FIRST. A rotate-on-everything policy
//                 wins on tokens and is useless, and the seat's own header
//                 warns that optimising the measurable side is how the
//                 original amnesia incident happened. An arm that saves
//                 tokens by rotating where the label says "continue" has
//                 not won; it has relocated the cost to the user.

import { resolve } from "path"
import { randomUUID } from "crypto"
import { loadDaemonConfig } from "@/daemon/config"
import { AgentRegistry } from "@/agents/registry"
import { getEventBus, type AgentXEvents } from "@/events/bus"
import {
  configureDecisions,
  registerBuiltinDecisionBackends,
  DecisionStore,
} from "@/decisions"
import {
  SESSION_CONTINUITY_SEAT,
  shouldRotateEarly,
  type SessionContinuityAnswers,
} from "@/decisions/seats/session-continuity"
import { seatEnvVar } from "@/decisions/seat"
import { getScenario, SCENARIOS, type BenchScenario, type Expectation } from "./bench-jev-scenarios"

type Arm = "on" | "off"

interface TurnMetric {
  index: number
  message: string
  expect?: Expectation
  /** Did a continuity rotation fire before this turn dispatched? */
  rotated: boolean
  /** Any rotation, including the mechanical ones the seat cannot override. */
  rotationReason?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  contextTokens?: number
  providerTurns?: number
  durationMs: number
  error?: string
}

interface ArmResult {
  arm: Arm
  chatId: string
  turns: TurnMetric[]
  seatCalls: number
  seatInputTokens: number
  seatOutputTokens: number
  seatLatencyMsTotal: number
  seatErrors: number
  /** One entry per seat call, joined back to the turn it decided. Feeds
   *  the threshold sweep — see sweepPolicy. */
  seatAnswers: Array<{ message: string; continues: number; needsHistory: number }>
}

// --- args ---------------------------------------------------------------

function parseArgs(argv: string[]) {
  const get = (name: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1]
    const inline = argv.find((a) => a.startsWith(`--${name}=`))
    if (inline) return inline.slice(name.length + 3)
    return fallback
  }
  const jev = (get("jev", "both") ?? "both").toLowerCase()
  if (!["on", "off", "both"].includes(jev)) {
    throw new Error(`--jev must be on|off|both, got "${jev}"`)
  }
  return {
    jev: jev as Arm | "both",
    agent: get("agent"),
    scenario: get("scenario", "mixed-subjects")!,
    backend: get("backend"),
    limit: get("limit") ? Number(get("limit")) : undefined,
    json: argv.includes("--json"),
    yes: argv.includes("--yes"),
  }
}

// --- decisions wiring ---------------------------------------------------

/**
 * Point the seat at an arm.
 *
 * Both halves matter. The env var decides whether the seat runs at all,
 * and the runtime decides which backend answers it — a seat flipped to
 * `active` while defaultBackend still resolves to the local model would
 * benchmark the local model and call the result Jev.
 */
function configureArm(arm: Arm, backend: string, store: DecisionStore): void {
  process.env[seatEnvVar(SESSION_CONTINUITY_SEAT)] = arm === "on" ? "active" : "off"
  configureDecisions({
    enabled: true,
    defaultBackend: backend,
    store,
    seats: {
      [SESSION_CONTINUITY_SEAT]: {
        mode: arm === "on" ? "active" : "off",
        backend,
      },
    },
  })
}

// --- one arm ------------------------------------------------------------

async function runArm(
  registry: AgentRegistry,
  agentId: string,
  scenario: BenchScenario,
  arm: Arm,
  backend: string,
  store: DecisionStore,
): Promise<ArmResult> {
  // A fresh chatId per arm. Both arms must start from zero session state or
  // the second one inherits the first one's transcript and the comparison
  // is meaningless.
  const chatId = `jev-${scenario.name}-${arm}-${randomUUID().slice(0, 8)}`
  const channel = "bench"

  configureArm(arm, backend, store)

  // Rotations are observed off the bus rather than inferred from tokens.
  // A token drop with no rotation behind it is some other effect wearing
  // the seat's credit.
  let pendingRotation: { reason: string } | null = null
  const bus = getEventBus()
  const onRotate = (e: AgentXEvents["session:rotated"]) => {
    if (e.chatId === chatId) pendingRotation = { reason: e.reason }
  }
  bus.on("session:rotated", onRotate)

  const since = Date.now()
  const turns: TurnMetric[] = []

  console.error(`\n── arm: jev=${arm} · chat ${chatId} ──`)

  for (let i = 0; i < scenario.turns.length; i++) {
    const t = scenario.turns[i]
    pendingRotation = null
    const started = Date.now()

    const response = await registry.execute({
      agentId,
      message: t.message,
      context: { channel, chatId, sender: "bench" },
    })

    const u = response.usage
    const rotation = pendingRotation as { reason: string } | null
    const metric: TurnMetric = {
      index: i + 1,
      message: t.message,
      expect: t.expect,
      rotated: rotation?.reason === "continuity",
      rotationReason: rotation?.reason,
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      cacheReadTokens: u?.cacheReadTokens ?? 0,
      cacheCreateTokens: u?.cacheCreateTokens ?? 0,
      contextTokens: response.contextTokens,
      providerTurns: response.numTurns,
      durationMs: Date.now() - started,
      error: response.error,
    }
    turns.push(metric)

    const mark = metric.rotated ? "⟳" : " "
    const total = metric.inputTokens + metric.outputTokens + metric.cacheReadTokens + metric.cacheCreateTokens
    console.error(
      `  ${String(i + 1).padStart(2)} ${mark} ${fmt(total).padStart(9)} tok` +
        `  ctx ${fmt(metric.contextTokens ?? 0).padStart(7)}` +
        `  pturns ${String(metric.providerTurns ?? "?").padStart(3)}` +
        `  ${(metric.durationMs / 1000).toFixed(1)}s` +
        (metric.error ? `  ERROR: ${metric.error.slice(0, 60)}` : ""),
    )
  }

  bus.off("session:rotated", onRotate)

  // The seat's own cost, straight from the rows it wrote during this arm.
  // Self-reported by the backend, so it is what Jev billed us for, not an
  // estimate — and it belongs in the comparison: a seat that saves 300K
  // agent tokens while spending 400K of its own has not saved anything.
  let seatCalls = 0, seatInputTokens = 0, seatOutputTokens = 0, seatLatencyMsTotal = 0, seatErrors = 0
  const seatAnswers: ArmResult["seatAnswers"] = []
  {
    // Scoped to THIS arm's session link, not just a time window.
    //
    // The decision store is shared with the running daemon, which has this
    // same seat active on live traffic. A time-windowed query silently
    // folds any telegram / cron / github turn that happened to land during
    // the arm into the arm's seat cost. It reads as a plausible number, so
    // nothing looks wrong — the longer the run, the more contamination and
    // the more convincing the result.
    //
    // askSeat records a session link per call, so scoping to this arm's
    // own chat is exact and makes the harness safe to run beside a live
    // daemon (and beside another bench).
    const link = `${agentId}:${channel}:${chatId}`
    try {
      const rows = store.db
        .prepare(
          `SELECT c.input_tokens, c.output_tokens, c.latency_ms, c.error
             FROM decision_calls c
             JOIN decision_links l ON l.call_id = c.id
            WHERE c.seat = ? AND c.ts >= ? AND l.ref_kind = 'session' AND l.ref_id = ?`,
        )
        .all(SESSION_CONTINUITY_SEAT, since, link) as Array<{
        input_tokens: number
        output_tokens: number
        latency_ms: number | null
        error: string | null
      }>
      seatCalls = rows.length
      for (const r of rows) {
        seatInputTokens += r.input_tokens || 0
        seatOutputTokens += r.output_tokens || 0
        seatLatencyMsTotal += r.latency_ms || 0
        if (r.error) seatErrors++
      }

      // Pull the answers back out for the sweep. Joined on the request
      // text, which is unique within a scenario.
      const answered = store.db
        .prepare(
          `SELECT json_extract(c.state_json, '$.newRequest') AS message,
                  MAX(CASE WHEN a.question = 'continues'
                           THEN json_extract(a.answer_json, '$.noul') END) AS continues,
                  MAX(CASE WHEN a.question = 'needsHistory'
                           THEN json_extract(a.answer_json, '$.noul') END) AS needsHistory
             FROM decision_calls c
             JOIN decision_answers a ON a.call_id = c.id
             JOIN decision_links l ON l.call_id = c.id
            WHERE c.seat = ? AND c.ts >= ? AND c.error IS NULL
              AND l.ref_kind = 'session' AND l.ref_id = ?
            GROUP BY c.id ORDER BY c.ts`,
        )
        .all(SESSION_CONTINUITY_SEAT, since, link) as Array<{
        message: string | null
        continues: number | null
        needsHistory: number | null
      }>
      for (const a of answered) {
        if (a.message == null || a.continues == null || a.needsHistory == null) continue
        seatAnswers.push({ message: a.message, continues: a.continues, needsHistory: a.needsHistory })
      }
    } catch {
      /* the seat's own accounting is nice to have; the arm still counts */
    }
  }

  return { arm, chatId, turns, seatCalls, seatInputTokens, seatOutputTokens, seatLatencyMsTotal, seatErrors, seatAnswers }
}

// --- scoring ------------------------------------------------------------

function totals(r: ArmResult) {
  const sum = (f: (t: TurnMetric) => number) => r.turns.reduce((a, t) => a + f(t), 0)
  const input = sum((t) => t.inputTokens)
  const output = sum((t) => t.outputTokens)
  const cacheRead = sum((t) => t.cacheReadTokens)
  const cacheCreate = sum((t) => t.cacheCreateTokens)
  const total = input + output + cacheRead + cacheCreate
  const convTurns = r.turns.length
  const providerTurns = sum((t) => t.providerTurns ?? 0)
  return {
    input, output, cacheRead, cacheCreate, total,
    convTurns,
    providerTurns,
    perConvTurn: convTurns ? Math.round(total / convTurns) : 0,
    perProviderTurn: providerTurns ? Math.round(total / providerTurns) : 0,
    rotations: r.turns.filter((t) => t.rotated).length,
    mechanical: r.turns.filter((t) => t.rotationReason && t.rotationReason !== "continuity").length,
    durationMs: sum((t) => t.durationMs),
    errors: r.turns.filter((t) => t.error).length,
  }
}

/**
 * Score rotations against the labels.
 *
 * The two error types are not symmetric and are never summed into one
 * accuracy number. A missed rotation costs tokens, which the tokens column
 * already shows. A wrong rotation costs the user their context, which no
 * token column will ever show — so it gets its own line, and it is the one
 * that disqualifies an arm.
 */
function correctness(r: ArmResult) {
  let shouldRotate = 0, didRotateCorrectly = 0, amnesia = 0, missed = 0
  for (const t of r.turns) {
    if (!t.expect) continue
    if (t.expect === "rotate") {
      shouldRotate++
      if (t.rotated) didRotateCorrectly++
      else missed++
    } else if (t.rotated) {
      amnesia++ // rotated where the turn depended on earlier context
    }
  }
  return {
    shouldRotate,
    caught: didRotateCorrectly,
    missed,
    amnesia,
    recall: shouldRotate ? didRotateCorrectly / shouldRotate : null,
  }
}

/**
 * What the seat WOULD have done at other policy thresholds.
 *
 * Every recorded call carries its raw nouls, so the rotate/don't-rotate
 * decision can be replayed against any threshold without dispatching a
 * single extra agent turn. That matters: an arm costs real tokens and
 * minutes, and sweeping a two-dimensional policy grid by re-running would
 * be unaffordable, so it would not get done and the thresholds would stay
 * unexamined — which is how they got picked under pressure in the first
 * place.
 *
 * It calls the real shouldRotateEarly rather than reimplementing the
 * comparison, so a sweep can never disagree with what production would do.
 */
function sweepPolicy(r: ArmResult, scenario: BenchScenario): void {
  if (r.seatAnswers.length === 0) return

  const expected = new Map(scenario.turns.map((t) => [t.message, t.expect]))
  // One dimension, because the policy has one knob.
  //
  // This swept minConfidence too, and reported it as the gate that bound
  // every cell. That reading was right about the arithmetic and wrong
  // about the cause: a Noul carries no confidence to gate on, so the
  // second "knob" was a misuse of the primitive that silently halved this
  // threshold. It has been removed rather than tuned, and sweeping it
  // would now be sweeping a number nothing reads.
  const grid = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]

  console.log(`\n  policy sweep (replayed from ${r.seatAnswers.length} recorded calls, no extra dispatches)`)
  console.log(`  ${"-".repeat(58)}`)
  console.log(`  ${"maxContinuity".padEnd(16)}${"caught".padStart(12)}${"amnesia".padStart(12)}`)

  for (const maxContinuity of grid) {
    let caught = 0, amnesia = 0, shouldRotate = 0
    for (const a of r.seatAnswers) {
      const expect = expected.get(a.message)
      if (!expect) continue
      if (expect === "rotate") shouldRotate++
      const answers = {
        continues: { type: "noul", noul: a.continues },
        needsHistory: { type: "noul", noul: a.needsHistory },
      } as unknown as SessionContinuityAnswers
      const rotate = shouldRotateEarly(answers, { mechanicalRotation: false, maxContinuity })
      if (!rotate) continue
      if (expect === "rotate") caught++
      else amnesia++
    }
    // Amnesia is never traded off against recall here — it is its own
    // column so a threshold that buys rotations with lost context cannot
    // hide inside a single score.
    const marker = maxContinuity === 0.2 ? "  <- current" : amnesia > 0 ? "  <- amnesia" : ""
    console.log(
      `  ${String(maxContinuity).padEnd(16)}${`${caught}/${shouldRotate}`.padStart(12)}${String(amnesia).padStart(12)}${marker}`,
    )
  }
  console.log(`  ${"-".repeat(58)}`)
  console.log(`  caught = subject changes rotated on. amnesia = rotations on turns`)
  console.log(`  that needed earlier context; any non-zero disqualifies the row.`)
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function pct(a: number, b: number): string {
  if (b === 0) return "—"
  const d = ((a - b) / b) * 100
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`
}

function report(scenario: BenchScenario, results: ArmResult[]): void {
  const line = "─".repeat(72)
  console.log(`\n${line}`)
  console.log(`JEV session-continuity benchmark · scenario "${scenario.name}"`)
  console.log(scenario.description)
  console.log(line)

  const rows = results.map((r) => ({ r, t: totals(r), c: correctness(r) }))

  console.log(`\n  ${"metric".padEnd(26)}${rows.map((x) => `jev=${x.r.arm}`.padStart(14)).join("")}`)
  console.log(`  ${"-".repeat(26 + 14 * rows.length)}`)
  const row = (label: string, pick: (x: typeof rows[0]) => string) =>
    console.log(`  ${label.padEnd(26)}${rows.map((x) => pick(x).padStart(14)).join("")}`)

  row("conversation turns", (x) => String(x.t.convTurns))
  row("provider turns", (x) => String(x.t.providerTurns || "—"))
  row("input tokens", (x) => fmt(x.t.input))
  row("output tokens", (x) => fmt(x.t.output))
  row("cache read", (x) => fmt(x.t.cacheRead))
  row("cache create", (x) => fmt(x.t.cacheCreate))
  row("TOTAL tokens", (x) => fmt(x.t.total))
  row("tokens / conv turn", (x) => fmt(x.t.perConvTurn))
  row("tokens / provider turn", (x) => (x.t.perProviderTurn ? fmt(x.t.perProviderTurn) : "—"))
  row("continuity rotations", (x) => String(x.t.rotations))
  row("mechanical rotations", (x) => String(x.t.mechanical))
  row("wall clock", (x) => `${(x.t.durationMs / 1000).toFixed(0)}s`)
  row("turn errors", (x) => String(x.t.errors))

  console.log(`\n  ${"correctness".padEnd(26)}${rows.map((x) => `jev=${x.r.arm}`.padStart(14)).join("")}`)
  console.log(`  ${"-".repeat(26 + 14 * rows.length)}`)
  row("subject changes", (x) => String(x.c.shouldRotate))
  row("  caught", (x) => String(x.c.caught))
  row("  missed", (x) => String(x.c.missed))
  row("AMNESIA (wrong rotate)", (x) => String(x.c.amnesia))
  row("recall", (x) => (x.c.recall == null ? "—" : `${(x.c.recall * 100).toFixed(0)}%`))

  console.log(`\n  ${"seat cost (jev itself)".padEnd(26)}${rows.map((x) => `jev=${x.r.arm}`.padStart(14)).join("")}`)
  console.log(`  ${"-".repeat(26 + 14 * rows.length)}`)
  row("seat calls", (x) => String(x.r.seatCalls))
  row("seat input tokens", (x) => fmt(x.r.seatInputTokens))
  row("seat failures", (x) => String(x.r.seatErrors))
  row("seat mean latency", (x) =>
    x.r.seatCalls ? `${Math.round(x.r.seatLatencyMsTotal / x.r.seatCalls)}ms` : "—")

  // A failed turn spends no tokens, so an arm that could not dispatch
  // reports as the cheapest one on every column above. Refuse to compare
  // rather than hand back a number that reads like a win.
  const broken = rows.filter((x) => x.t.errors > 0)
  if (broken.length > 0) {
    console.log(`\n${line}`)
    for (const x of broken) {
      console.log(`  ✗  jev=${x.r.arm}: ${x.t.errors}/${x.t.convTurns} turns failed.`)
      const first = x.r.turns.find((t) => t.error)
      if (first) console.log(`     first error: ${first.error}`)
    }
    console.log(`\n  No comparison drawn — a turn that never dispatched costs zero tokens,`)
    console.log(`  which would score as the cheapest arm. Fix the failures and re-run.`)
    console.log(line)
    return
  }

  for (const x of rows) if (x.r.arm === "on") sweepPolicy(x.r, scenario)

  const on = rows.find((x) => x.r.arm === "on")
  const off = rows.find((x) => x.r.arm === "off")
  if (on && off) {
    console.log(`\n${line}`)
    console.log(`  tokens        ${pct(on.t.total, off.t.total)}   (${fmt(off.t.total)} → ${fmt(on.t.total)})`)
    console.log(`  tokens/turn   ${pct(on.t.perConvTurn, off.t.perConvTurn)}   (${fmt(off.t.perConvTurn)} → ${fmt(on.t.perConvTurn)})`)
    console.log(`  rotations     ${off.t.rotations} → ${on.t.rotations}`)
    console.log(
      `  seat overhead ${fmt(on.r.seatInputTokens)} tokens across ${on.r.seatCalls} calls` +
        ` (${on.t.total ? ((on.r.seatInputTokens / on.t.total) * 100).toFixed(2) : "0"}% of the arm's own total)`,
    )
    // The verdict is gated on the MECHANISM, not on the token delta.
    //
    // Two arms of the same scenario are not deterministic: the agent
    // writes a different-length answer each time, and that alone moves the
    // total by double-digit percentages. When the rotation counts are
    // equal, the seat did nothing, so whatever the tokens did is variance
    // wearing the seat's credit — and a "✓ cheaper" on that is a false
    // positive the harness would hand its own author.
    if (on.c.amnesia > 0) {
      console.log(
        `\n  ⚠  jev=on rotated on ${on.c.amnesia} turn(s) labelled "continue". Any token saving` +
          `\n     above is partly paid for in lost context — treat this run as a FAIL and look` +
          `\n     at the turns marked ⟳ that should not have been.`,
      )
    } else if (on.t.rotations === off.t.rotations) {
      console.log(
        `\n  ~  NOT ATTRIBUTABLE. Both arms rotated ${on.t.rotations} time(s), so the seat changed` +
          `\n     nothing and the ${pct(on.t.total, off.t.total)} token delta is run-to-run variance` +
          `\n     (answer length differs between arms). The seat cost ${fmt(on.r.seatInputTokens)} tokens` +
          `\n     across ${on.r.seatCalls} calls and bought no rotation on this scenario.`,
      )
    } else if (on.t.total < off.t.total) {
      console.log(
        `\n  ✓  cheaper with zero amnesia, and ${on.t.rotations - off.t.rotations} more rotation(s) to attribute it to.`,
      )
    }
    console.log(line)
  }
}

// --- main ---------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const scenario = getScenario(args.scenario)
  if (!scenario) {
    console.error(`unknown scenario "${args.scenario}". available: ${SCENARIOS.map((s) => s.name).join(", ")}`)
    process.exit(1)
  }

  // --limit trims the scenario so the harness itself can be smoke-tested
  // for two dispatches instead of twenty-four. Results from a trimmed run
  // are for checking the plumbing, not for drawing conclusions: the seat
  // only has something to decide once a transcript exists to drop.
  const scenarioToRun: BenchScenario =
    args.limit && args.limit < scenario.turns.length
      ? { ...scenario, name: `${scenario.name} (first ${args.limit})`, turns: scenario.turns.slice(0, args.limit) }
      : scenario

  const config = loadDaemonConfig()

  const agentId =
    args.agent ??
    Object.entries(config.agents).find(([, a]) => (a as { tier?: string }).tier === "claude-code")?.[0]
  if (!agentId || !config.agents[agentId]) {
    console.error(`no such agent "${agentId}". available: ${Object.keys(config.agents).join(", ")}`)
    process.exit(1)
  }

  // The seat's configured backend is the right default: benchmarking a
  // backend the fleet does not actually run would measure nothing anyone
  // is paying for.
  const backend =
    args.backend ??
    (config as { decisions?: { seats?: Record<string, { backend?: string }> } })
      .decisions?.seats?.[SESSION_CONTINUITY_SEAT]?.backend ??
    "jev"

  const arms: Arm[] = args.jev === "both" ? ["off", "on"] : [args.jev]
  const dispatches = arms.length * scenarioToRun.turns.length

  console.error(`agent      ${agentId} (${(config.agents[agentId] as { model?: string }).model ?? "?"})`)
  console.error(`scenario   ${scenarioToRun.name} — ${scenarioToRun.turns.length} turns`)
  console.error(`arms       ${arms.map((a) => `jev=${a}`).join(", ")}`)
  console.error(`backend    ${backend}`)
  console.error(
    `cost       ${dispatches} real agent dispatches against the shared OAuth quota.\n` +
      `           This harness runs its own process, so it cannot see the daemon's\n` +
      `           dispatch counter — the quota it spends is real either way.`,
  )
  if (!args.yes) {
    console.error(`\nre-run with --yes to start.`)
    process.exit(0)
  }

  registerBuiltinDecisionBackends()

  // Hard failure, not a warning. Without the store the seat still answers
  // and still rotates — it just records nothing, so every seat-cost column
  // reads 0 and the run looks like Jev decided for free. A benchmark that
  // silently drops the cost side of the comparison is worse than no
  // benchmark. better-sqlite3 is a native addon built against the Node the
  // daemon runs; a newer Node in this shell is the usual cause.
  let store: DecisionStore
  try {
    store = new DecisionStore({ path: resolve(process.cwd(), ".agentx/decisions/decisions.sqlite") })
  } catch (e: unknown) {
    console.error(`\n[bench] cannot open the decision store: ${(e as Error)?.message?.split("\n")[0]}`)
    console.error(
      `\nSeat cost would silently read as 0, so this run is refused.\n` +
        `If that is a NODE_MODULE_VERSION mismatch, run under the Node the daemon uses:\n` +
        `  PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.local/bin:$PATH" pnpm tsx scripts/bench-jev.ts ...`,
    )
    process.exit(1)
  }

  const registry = new AgentRegistry(config, () => {})

  const results: ArmResult[] = []
  for (const arm of arms) {
    results.push(await runArm(registry, agentId, scenarioToRun, arm, backend, store))
  }

  report(scenarioToRun, results)

  if (args.json) {
    console.log(JSON.stringify({ scenario: scenarioToRun.name, agentId, backend, results }, null, 2))
  }
  store.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
