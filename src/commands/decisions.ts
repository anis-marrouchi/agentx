import { Command } from "commander"
import chalk from "chalk"
import { existsSync } from "fs"
import { resolve } from "path"
import { DecisionStore, type GradedRowFilter } from "@/decisions/store"
import { calibrationReport, coverageCurve } from "@/decisions/calibration"
import { getDecisionBackend, listDecisionBackends } from "@/decisions/backend"
import { registerBuiltinDecisionBackends } from "@/decisions"
import { choice, noul } from "@/decisions/questions"
import { backfillMonitorLabels } from "@/decisions/seats/monitor-prefilter"
import Database from "better-sqlite3"

// --- agentx decisions ---
//
// Read-mostly triage CLI for the shadow store at
// .agentx/decisions/decisions.sqlite. Built for the soak that has to happen
// before any seat is promoted from `shadow` to `active`.
//
// `calibrate` is the command that decides whether a seat gets promoted, and
// `coverage` is the one that says what threshold to promote it at. The rest
// exist to feed those two.
//
// Only `label` writes. Everything else opens read-only.

export const decisions = new Command()
  .name("decisions")
  .description("inspect the typed-decision shadow store (.agentx/decisions/decisions.sqlite)")

const DEFAULT_PATH = ".agentx/decisions/decisions.sqlite"

interface OpenOpts {
  cwd?: string
  path?: string
}

function storePath(opts: OpenOpts): string {
  return resolve(resolve(opts.cwd ?? process.cwd()), opts.path ?? DEFAULT_PATH)
}

function open(opts: OpenOpts, writable = false): DecisionStore {
  const path = storePath(opts)
  if (!existsSync(path)) {
    console.log(chalk.red(`  No decision store at ${path}`))
    console.log(
      chalk.dim(
        `  Set decisions.enabled and give a seat mode "shadow" (or export ` +
          `AGENTX_DECISION_SEAT_<SEAT>=shadow). The file is created on the first recorded call.`,
      ),
    )
    process.exit(1)
  }
  try {
    return new DecisionStore({ path, readonly: !writable })
  } catch (e: any) {
    console.log(chalk.red(`  Could not open ${path}: ${e.message}`))
    if (/NODE_MODULE_VERSION/.test(e.message)) {
      console.log(chalk.dim(`  Run \`pnpm rebuild better-sqlite3\` under the daemon's Node version.`))
    }
    process.exit(1)
  }
}

function emit(rows: any[], asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log(chalk.dim("  (no rows)"))
    return
  }
  const cols = Object.keys(rows[0])
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)))
  const fmt = (cells: any[]) => cells.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ")
  console.log(chalk.bold(fmt(cols)))
  for (const row of rows) console.log(fmt(cols.map((c) => row[c])))
}

/** `--since 7d` / `12h` / `30m`, or an ISO date. */
function parseSince(value?: string): number | undefined {
  if (!value) return undefined
  const rel = value.match(/^(\d+)([dhm])$/)
  if (rel) {
    const n = Number(rel[1])
    const ms = rel[2] === "d" ? 86_400_000 : rel[2] === "h" ? 3_600_000 : 60_000
    return Date.now() - n * ms
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function filterFrom(opts: any): GradedRowFilter {
  return {
    seat: opts.seat,
    question: opts.question,
    backend: opts.backend,
    model: opts.model,
    structureMode: opts.structureMode,
    since: parseSince(opts.since),
    labeledOnly: Boolean(opts.labeled),
    exploredOnly: Boolean(opts.explored),
    limit: opts.limit ? Number(opts.limit) : undefined,
  }
}

decisions
  .command("stats")
  .description("per-seat call counts, failure rate, repair rate and latency")
  .option("--path <file>", "store path", DEFAULT_PATH)
  .option("--since <window>", "e.g. 7d, 12h, or an ISO date")
  .option("--json", "raw JSON")
  .action((opts) => {
    const store = open(opts)
    const since = parseSince(opts.since) ?? 0
    const rows = store.db
      .prepare(
        `SELECT seat, mode, backend, model, structure_mode AS structureMode,
                COUNT(*) AS calls,
                SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
                SUM(retries) AS retries,
                SUM(truncated) AS truncated,
                ROUND(AVG(latency_ms)) AS avgMs,
                SUM(input_tokens) AS inTokens
           FROM decision_calls
          WHERE ts >= ?
          GROUP BY seat, mode, backend, model, structure_mode
          ORDER BY calls DESC`,
      )
      .all(since)
    emit(rows, opts.json)

    const policy = store.db
      .prepare(
        `SELECT seat, mode, COALESCE(action,'(none)') AS action, explored, COUNT(*) AS calls
           FROM decision_calls WHERE ts >= ? GROUP BY seat, mode, action, explored
          ORDER BY calls DESC`,
      )
      .all(since) as Array<Record<string, unknown>>
    if (!opts.json && policy.length > 0) {
      console.log(chalk.bold("\n  policy"))
      emit(policy, false)
      console.log(
        chalk.dim(
          "\n  explored=1 means the policy wanted to skip and the expensive path ran anyway.\n" +
            "  Those are the only rows in the skip region that can ever be graded.",
        ),
      )
    }
    store.close()
  })

decisions
  .command("calls")
  .description("recent calls")
  .option("--path <file>", "store path", DEFAULT_PATH)
  .option("--seat <seat>")
  .option("--since <window>")
  .option("--limit <n>", "default 20", "20")
  .option("--json")
  .action((opts) => {
    const store = open(opts)
    const where: string[] = ["ts >= ?"]
    const params: unknown[] = [parseSince(opts.since) ?? 0]
    if (opts.seat) (where.push("seat = ?"), params.push(opts.seat))
    const rows = store.db
      .prepare(
        `SELECT id, datetime(ts/1000, 'unixepoch') AS at, seat, mode, backend, model,
                structure_mode AS structure, latency_ms AS ms, retries, truncated, error
           FROM decision_calls WHERE ${where.join(" AND ")}
          ORDER BY ts DESC LIMIT ?`,
      )
      .all(...params, Number(opts.limit))
    emit(rows, opts.json)
    store.close()
  })

decisions
  .command("answers <callId>")
  .description("every answer on one call, with its incumbent and label")
  .option("--path <file>", "store path", DEFAULT_PATH)
  .option("--json")
  .action((callId, opts) => {
    const store = open(opts)
    const rows = store.gradedRows({}).filter((r) => r.callId === callId)
    if (rows.length === 0) {
      console.log(chalk.dim(`  (no answers for ${callId} — check \`decisions calls\`)`))
      store.close()
      return
    }
    emit(
      rows.map((r) => ({
        question: r.question,
        type: r.type,
        predicted: r.predicted,
        confidence: r.confidence.toFixed(3),
        incumbent: r.incumbent ?? "",
        truth: r.truth ?? "",
      })),
      opts.json,
    )
    store.close()
  })

decisions
  .command("label <callId> <question> <value>")
  .description("attach ground truth to one answer (append-only; newest wins)")
  .option("--path <file>", "store path", DEFAULT_PATH)
  .option("--kind <kind>", "human | outcome | replay", "human")
  .option("--by <who>")
  .option("--note <text>")
  .action((callId, question, value, opts) => {
    const store = open(opts, true)
    store.label(callId, question, value, {
      kind: opts.kind,
      labeledBy: opts.by,
      note: opts.note,
    })
    console.log(chalk.green(`  labeled ${callId}.${question} = ${value}`))
    store.close()
  })

decisions
  .command("unlabeled")
  .description("lowest-confidence unlabeled answers first — the most informative to label")
  .option("--path <file>", "store path", DEFAULT_PATH)
  .option("--seat <seat>")
  .option("--limit <n>", "default 20", "20")
  .option("--json")
  .action((opts) => {
    const store = open(opts)
    const rows = store
      .gradedRows({ seat: opts.seat })
      .filter((r) => r.truth === undefined)
      .sort((a, b) => a.confidence - b.confidence)
      .slice(0, Number(opts.limit))
    emit(
      rows.map((r) => ({
        callId: r.callId,
        question: r.question,
        predicted: r.predicted,
        confidence: r.confidence.toFixed(3),
        incumbent: r.incumbent ?? "",
      })),
      opts.json,
    )
    store.close()
  })

decisions
  .command("backfill-labels")
  .description("derive ground truth from what actually happened (monitor-prefilter seat)")
  .option("--path <file>", "store path", DEFAULT_PATH)
  .option("--db <file>", "observability db holding session_reviews", ".agentx/db.sqlite")
  .action((opts) => {
    const store = open(opts, true)
    const dbPath = resolve(process.cwd(), opts.db)
    if (!existsSync(dbPath)) {
      console.log(chalk.red(`  No observability db at ${dbPath}`))
      store.close()
      process.exit(1)
    }
    const db = new Database(dbPath, { readonly: true })
    try {
      const n = backfillMonitorLabels(db, store)
      console.log(chalk.green(`  wrote ${n} label(s)`))
      if (n === 0) {
        console.log(
          chalk.dim(
            "  Rows whose outcome is genuinely ambiguous stay unlabeled on purpose —\n" +
              "  label those by hand: agentx decisions unlabeled --seat monitor-prefilter",
          ),
        )
      }
    } finally {
      db.close()
      store.close()
    }
  })

decisions
  .command("calibrate")
  .description("is this seat's confidence worth anything? reliability, ECE, Brier, temperature")
  .option("--path <file>", "store path", DEFAULT_PATH)
  .requiredOption("--seat <seat>")
  .option("--question <name>")
  .option("--backend <name>", "grade one backend in isolation")
  .option("--model <id>")
  .option("--structure-mode <mode>", "never pool verbalized and logprob rows")
  .option("--since <window>")
  .option("--explored", "only rows the policy wanted to skip — the unbiased skip-region sample")
  .option("--min-n <n>", "refuse to report below this many labeled rows", "100")
  .option("--bins <n>", "default 10", "10")
  .option("--json")
  .action((opts) => {
    const store = open(opts)
    const rows = store.gradedRows(filterFrom(opts))
    const report = calibrationReport(rows, {
      minN: Number(opts.minN),
      bins: Number(opts.bins),
    })

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2))
      store.close()
      return
    }

    console.log(chalk.bold(`\n  ${opts.seat}${opts.question ? `.${opts.question}` : ""}`))
    console.log(
      `  ${report.n} answers, ${report.nLabeled} labeled` +
        (report.agreement.n > 0
          ? `, ${report.agreement.n} with an incumbent (agree ${(report.agreement.rate * 100).toFixed(1)}%, kappa ${report.agreement.kappa.toFixed(3)})`
          : ""),
    )

    if (report.insufficient) {
      console.log(
        chalk.yellow(
          `\n  Not enough ground truth: ${report.nLabeled} labeled rows, need ${report.minN}.`,
        ),
      )
      console.log(
        chalk.dim(
          `  An ECE on this little data is noise, and a noisy number on a dashboard gets acted on.`,
        ),
      )
      console.log(chalk.dim(`  Label the most informative rows: agentx decisions unlabeled --seat ${opts.seat}`))
      store.close()
      return
    }

    console.log(`\n  accuracy      ${(report.accuracy! * 100).toFixed(1)}%`)
    console.log(
      `  ECE           ${report.ece!.toFixed(4)}  ` +
        chalk.dim(`[95% CI ${report.eceInterval!.lo.toFixed(4)}–${report.eceInterval!.hi.toFixed(4)}]`),
    )
    console.log(`  ECE (mass)    ${report.eceEqualMass!.toFixed(4)}  ${chalk.dim("equal-mass bins")}`)
    console.log(`  MCE           ${report.mce!.toFixed(4)}  ${chalk.dim("worst single bin")}`)
    console.log(`  Brier         ${report.brier!.toFixed(4)}  ${chalk.dim("proper score, lower is better")}`)
    console.log(`  log loss      ${report.logLoss!.toFixed(4)}`)

    const fit = report.temperature!
    console.log(
      `\n  fitted temperature ${fit.temperature}  ` +
        chalk.dim(`(NLL ${fit.nllBefore.toFixed(4)} → ${fit.nll.toFixed(4)})`),
    )
    if (fit.temperature > 1.15) {
      console.log(
        chalk.dim(
          `  T > 1 means the backend is overconfident. Set decisions.seats.${opts.seat}.temperature = ${fit.temperature}.`,
        ),
      )
    }

    const skipRegion = rows.filter((r) => r.action === "skip")
    const gradeable = skipRegion.filter((r) => r.explored && r.truth !== undefined)
    if (skipRegion.length > 0) {
      console.log(
        `\n  skip region   ${skipRegion.length} answers ` +
          `(${((skipRegion.length / rows.length) * 100).toFixed(1)}% of traffic), ` +
          `${gradeable.length} gradeable`,
      )
      if (gradeable.length === 0) {
        console.log(
          chalk.yellow(
            "  Nothing in the skip region has been graded. Everything below describes\n" +
              "  only the decisions this policy chose NOT to skip — it cannot tell you\n" +
              "  what skipping would cost. Raise decisions.seats.<seat>.explore.",
          ),
        )
      }
    }

    console.log(chalk.bold("\n  reliability (equal-width bins)"))
    emit(
      report.bins!.map((b) => ({
        bin: `${b.lo.toFixed(2)}–${b.hi.toFixed(2)}`,
        n: b.n,
        claimed: b.meanConfidence.toFixed(3),
        actual: b.accuracy.toFixed(3),
        gap: (b.accuracy - b.meanConfidence).toFixed(3),
      })),
      false,
    )
    store.close()
  })

decisions
  .command("coverage")
  .description("accuracy at each threshold against the traffic it keeps — read this to pick one")
  .option("--path <file>", "store path", DEFAULT_PATH)
  .requiredOption("--seat <seat>")
  .option("--question <name>")
  .option("--since <window>")
  .option("--explored", "only rows the policy wanted to skip")
  .option("--steps <n>", "default 20", "20")
  .option("--json")
  .action((opts) => {
    const store = open(opts)
    const rows = store.gradedRows({ ...filterFrom(opts), labeledOnly: true })
    const curve = coverageCurve(rows, Number(opts.steps))
    if (curve.length === 0) {
      console.log(chalk.yellow(`  No labeled rows for seat "${opts.seat}".`))
      store.close()
      return
    }
    emit(
      curve.map((p) => ({
        threshold: p.threshold.toFixed(2),
        coverage: `${(p.coverage * 100).toFixed(1)}%`,
        accuracy: `${(p.accuracy * 100).toFixed(1)}%`,
        n: p.n,
      })),
      opts.json,
    )
    store.close()
  })

decisions
  .command("backends")
  .description("registered decision backends and what they claim")
  .action(() => {
    registerBuiltinDecisionBackends()
    const rows = listDecisionBackends().map((name) => {
      const caps = getDecisionBackend(name).capabilities
      return {
        backend: name,
        calibrated: caps.calibratedProbabilities ? "yes" : "no",
        maxOptions: caps.maxChoiceOptions,
        maxStateChars: caps.maxStateChars,
      }
    })
    emit(rows, false)
    console.log(
      chalk.dim(
        `\n  "calibrated: no" is the honest value for any backend that asks a chat model to\n` +
          `  write out its own probabilities. Calibration comes from a temperature fitted on\n` +
          `  your own labeled rows — see \`agentx decisions calibrate\`.`,
      ),
    )
  })

decisions
  .command("ask")
  .description("one-off smoke test against a backend (does not record)")
  .requiredOption("--state <text>", "the state to evaluate")
  .option("--backend <name>", "default mock", "mock")
  .option("--model <id>")
  .option("--choice <labels>", "comma-separated options for a choice question")
  .option("--noul <question>", "a yes/no question")
  .action(async (opts) => {
    registerBuiltinDecisionBackends()
    const questions: Record<string, any> = {}
    if (opts.choice) {
      const criteria: Record<string, null> = {}
      for (const label of String(opts.choice).split(",").map((s) => s.trim())) {
        if (label) criteria[label] = null
      }
      questions.answer = choice(criteria, "Which option fits this state?")
    }
    if (opts.noul) questions.verdict = noul(String(opts.noul))
    if (Object.keys(questions).length === 0) {
      console.log(chalk.red("  Give at least one of --choice or --noul."))
      process.exit(1)
    }

    const backend = getDecisionBackend(opts.backend)
    const res = await backend.decide({ state: opts.state, questions, model: opts.model })
    console.log(JSON.stringify(res, null, 2))
  })
