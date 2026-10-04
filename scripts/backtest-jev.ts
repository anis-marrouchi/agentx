// Backtest the Jev wake gate and model tier on recorded traces (#621,
// steps 1-2). Replays an export of GET /traces through the two seats and
// reports what they WOULD have decided. Changes no runtime behaviour: no
// run is blocked, skipped or downgraded by anything in this file.
//
// Run with:
//   curl -s "http://127.0.0.1:4202/traces?since=<msEpoch>&limit=1000" > traces.json
//   pnpm exec tsx scripts/backtest-jev.ts --traces traces.json
//   pnpm exec tsx scripts/backtest-jev.ts --traces traces.json --backend typesafe --skip-below 0.1
//
// Reads agentx.json from the current directory for the decision backends,
// their keys (.env) and each agent's model; falls back to the built-in
// defaults without one (then --backend is required, and a seat that needs
// a key reads it from its key file or the environment).
//
// Output, under --out (default .agentx/reports/jev-backtest/):
//   report.json   every number the table shows, plus the threshold sweep
//   sample.csv    skipped and downgraded events for a person to grade
//
// Cost: two cheap decision calls per trace (one when the tier is blocked
// for the row). No agent is dispatched. The seats' own calls are recorded
// only with --record, into a separate store under --out, never into the
// daemon's decision store — a backtest must not pollute the calibration
// rows of the live seats.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { configureDecisions, registerBuiltinDecisionBackends, DecisionStore } from "../src/decisions"
import { seatEnvVar } from "../src/decisions/seat"
import { WAKE_GATE_SEAT, SKIP_BELOW } from "../src/decisions/seats/wake-gate"
import { TASK_TIER_SEAT } from "../src/decisions/seats/task-tier"
import { DOWNGRADE_BELOW, cheapModelForEngine } from "../src/agents/routing"
import { loadPricingWithOverrides } from "../src/daemon/token-tracker"
import {
  buildReport,
  decideTraces,
  parseTraceExport,
  renderReport,
  sampleRows,
  toCsv,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_PROXY,
  DEFAULT_SWEEP,
  type PricingTable,
  type ProxyOptions,
} from "./backtest-jev-lib"

const DEFAULT_OUT = ".agentx/reports/jev-backtest"
const DEFAULT_CHEAP_MODEL = "claude-haiku-4-5"
const DEFAULT_MODEL = "claude-opus-5"

function parseArgs(argv: string[]) {
  const get = (name: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) return argv[i + 1]
    const inline = argv.find((a) => a.startsWith(`--${name}=`))
    if (inline) return inline.slice(name.length + 3)
    return fallback
  }
  const number = (name: string, fallback: number): number => {
    const raw = get(name)
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${raw}"`)
    return n
  }
  const list = (name: string): string[] | undefined =>
    get(name)?.split(",").map((s) => s.trim()).filter(Boolean)

  return {
    help: argv.includes("--help") || argv.includes("-h"),
    traces: get("traces"),
    backend: get("backend"),
    out: get("out", DEFAULT_OUT)!,
    skipBelow: number("skip-below", SKIP_BELOW),
    downgradeBelow: number("downgrade-below", DOWNGRADE_BELOW),
    sweep: list("sweep")?.map(Number) ?? DEFAULT_SWEEP,
    cheapModel: get("cheap-model"),
    defaultModel: get("default-model", DEFAULT_MODEL)!,
    prices: get("prices"),
    cacheTtlMs: number("cache-ttl-minutes", DEFAULT_CACHE_TTL_MS / 60_000) * 60_000,
    channels: list("channel"),
    agents: list("agent"),
    limit: get("limit") ? number("limit", 0) : undefined,
    sample: number("sample", 50),
    concurrency: number("concurrency", 4),
    timeoutMs: number("timeout-ms", 10_000),
    record: argv.includes("--record"),
    json: argv.includes("--json"),
    proxy: {
      noopMaxTurns: number("noop-max-turns", DEFAULT_PROXY.noopMaxTurns),
      noopMaxOutputTokens: number("noop-max-output", DEFAULT_PROXY.noopMaxOutputTokens),
      workedMinTurns: number("worked-min-turns", DEFAULT_PROXY.workedMinTurns),
      workedMinOutputTokens: number("worked-min-output", DEFAULT_PROXY.workedMinOutputTokens),
    } as ProxyOptions,
  }
}

const HELP = `
Backtest the Jev wake gate and model tier on an export of GET /traces.

  pnpm exec tsx scripts/backtest-jev.ts --traces <file> [options]

  --traces <file>            JSON from GET /traces (required)
  --backend <name>           decision backend: jev, typesafe, local, simple-jev, mock
                             (default: the wake-gate seat's backend in agentx.json,
                             else decisions.defaultBackend, else jev)
  --out <dir>                where report.json and sample.csv go (${DEFAULT_OUT})
  --skip-below <p>           gate skips when P(needs run) <= p (${SKIP_BELOW})
  --downgrade-below <p>      tier downgrades when P(needs flagship) < p (${DOWNGRADE_BELOW})
  --sweep <p,p,...>          thresholds to replay the answers at (${DEFAULT_SWEEP.join(",")})
  --cheap-model <id>         model a downgraded run is priced at
                             (default: decisions.routing.cheapModels.claude-code, else ${DEFAULT_CHEAP_MODEL})
  --default-model <id>       model for rows with no model and an unknown agent (${DEFAULT_MODEL})
  --prices <file>            JSON price table per million tokens, same shape as
                             .agentx/pricing/custom.json (default: built-in list prices
                             merged with .agentx/pricing/custom.json when present)
  --cache-ttl-minutes <n>    a follow-up this soon after the previous run keeps the
                             flagship, as live routing does (60)
  --channel <a,b>            only these channels      --agent <a,b>   only these agents
  --limit <n>                only the first n traces (smoke test)
  --sample <n>               rows per kind in sample.csv (50)
  --concurrency <n>          parallel seat calls (4)   --timeout-ms <n>  per call (10000)
  --noop-max-turns <n>       proxy: a run with <= n provider turns used no tool (1)
  --noop-max-output <n>      proxy: ...and <= n output tokens did nothing (200)
  --worked-min-turns <n>     proxy: a run with >= n provider turns did real work (3)
  --worked-min-output <n>    proxy: ...or >= n output tokens (1500)
  --record                   also keep every seat call in <out>/decisions.sqlite
  --json                     print the report as JSON to stdout instead of the table
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.traces) {
    console.log(HELP.trim())
    process.exit(args.help ? 0 : 1)
  }

  // --- config: backends, keys, agent models, cheap model ---------------
  let config: any = null
  try {
    const { loadDaemonConfig } = await import("../src/daemon/config")
    config = loadDaemonConfig()
  } catch (e: unknown) {
    console.error(`[backtest] no agentx.json read (${(e as Error)?.message?.split("\n")[0]}); using built-in backend defaults`)
  }
  const b = config?.decisions?.backends ?? {}
  registerBuiltinDecisionBackends(b.local, b.simpleJev, b.jev, b.typesafe)

  const backend: string =
    args.backend ??
    config?.decisions?.seats?.[WAKE_GATE_SEAT]?.backend ??
    (config?.decisions?.enabled ? config.decisions.defaultBackend : undefined) ??
    "jev"

  const cheapModel: string =
    args.cheapModel ??
    cheapModelForEngine("claude-code", config?.decisions?.routing) ??
    DEFAULT_CHEAP_MODEL

  const agentModels: Record<string, string | undefined> = {}
  for (const [id, agent] of Object.entries(config?.agents ?? {})) {
    agentModels[id] = (agent as { model?: string }).model
  }

  // --- the seats: shadow, on the chosen backend, recorded only on request
  //
  // Shadow rather than active because nothing here acts on the answer, and
  // the per-seat env vars are cleared so an operator's AGENTX_DECISION_SEAT_
  // _TASK_TIER=off (a sensible thing to have set) cannot silently empty the
  // tier column of this report.
  for (const seat of [WAKE_GATE_SEAT, TASK_TIER_SEAT]) delete process.env[seatEnvVar(seat)]
  mkdirSync(resolve(process.cwd(), args.out), { recursive: true })
  const store = args.record ? new DecisionStore({ path: resolve(process.cwd(), args.out, "decisions.sqlite") }) : null
  configureDecisions({
    enabled: true,
    defaultBackend: backend,
    store,
    seats: {
      [WAKE_GATE_SEAT]: { mode: "shadow", backend, timeoutMs: args.timeoutMs },
      [TASK_TIER_SEAT]: { mode: "shadow", backend, timeoutMs: args.timeoutMs },
    },
  })

  // --- prices ------------------------------------------------------------
  let pricing: PricingTable
  let pricingSource: string
  if (args.prices) {
    const p = resolve(process.cwd(), args.prices)
    pricing = loadPricingWithOverrides(p)
    pricingSource = `built-in list prices merged with ${args.prices}`
  } else {
    pricing = loadPricingWithOverrides()
    pricingSource = existsSync(resolve(process.cwd(), ".agentx/pricing/custom.json"))
      ? "built-in list prices merged with .agentx/pricing/custom.json"
      : "built-in list prices (src/daemon/token-tracker.ts)"
  }

  // --- traces ------------------------------------------------------------
  const tracesPath = resolve(process.cwd(), args.traces!)
  let traces = parseTraceExport(JSON.parse(readFileSync(tracesPath, "utf-8")))
  if (args.channels) traces = traces.filter((t) => args.channels!.includes(t.channel ?? "unknown"))
  if (args.agents) traces = traces.filter((t) => args.agents!.includes(t.agentId))
  if (args.limit) traces = traces.slice(0, args.limit)
  if (traces.length === 0) {
    console.error(`[backtest] no finished traces in ${args.traces} after filters`)
    process.exit(1)
  }

  console.error(`traces     ${traces.length} from ${args.traces}`)
  console.error(`backend    ${backend}`)
  console.error(`cheap      ${cheapModel}`)
  console.error(`prices     ${pricingSource}`)
  console.error(`calls      up to ${traces.length * 2} decision calls, no agent dispatches`)

  let lastShown = 0
  const verdicts = await decideTraces(traces, {
    cheapModel,
    pricing,
    agentModels,
    defaultModel: args.defaultModel,
    cacheTtlMs: args.cacheTtlMs,
    proxy: args.proxy,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    onProgress: (done, total) => {
      if (done === total || done - lastShown >= 25) {
        lastShown = done
        process.stderr.write(`  ${done}/${total}\r`)
      }
    },
  })
  process.stderr.write("\n")

  const report = buildReport(verdicts, {
    backend,
    skipBelow: args.skipBelow,
    downgradeBelow: args.downgradeBelow,
    cheapModel,
    pricing,
    pricingSource,
    cacheTtlMs: args.cacheTtlMs,
    proxy: args.proxy,
    sweep: args.sweep,
  })
  const sample = sampleRows(verdicts, {
    skipBelow: args.skipBelow,
    downgradeBelow: args.downgradeBelow,
    perKind: args.sample,
  })

  const outDir = resolve(process.cwd(), args.out)
  writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2))
  writeFileSync(resolve(outDir, "sample.csv"), toCsv(sample))

  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderReport(report))
  console.error(`report     ${resolve(outDir, "report.json")}`)
  console.error(`sample     ${resolve(outDir, "sample.csv")} (${sample.length} rows)`)
  if (store) console.error(`decisions  ${store.path}`)

  const failed = verdicts.filter((v) => v.errors.length > 0).length
  if (failed > 0) {
    console.error(`\n[backtest] ${failed}/${verdicts.length} traces got no answer from "${backend}" on at least one seat.`)
    console.error(`           They count as "would run on the flagship". Check the backend with: agentx decisions backends`)
  }
  store?.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
