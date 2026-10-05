// Backtest the Jev wake gate and model tier on recorded traces (#621,
// steps 1-2). Replays an export of GET /traces through the two seats and
// reports what they WOULD have decided. Changes no runtime behaviour: no
// run is blocked, skipped or downgraded by anything in this file.
//
// Run with (the daemon serves /traces on node.bind, 18800 by default):
//   curl -s "http://127.0.0.1:18800/traces?since=<msEpoch>&limit=1000" > traces.json
//   pnpm exec tsx scripts/backtest-jev.ts --traces traces.json
//   pnpm exec tsx scripts/backtest-jev.ts --traces traces.json --backend typesafe --skip-below 0.1
//   pnpm exec tsx scripts/backtest-jev.ts --traces traces.json --config ~/agentx/agentx.json
//
// Run it from the source checkout that holds this file: the imports below
// use the "@/" alias from tsconfig.json, which tsx resolves only from the
// folder it starts in. Reads agentx.json from that folder, or from --config
// when the configuration lives elsewhere (a worktree, say), for the decision
// backends, their keys (.env next to agentx.json) and each agent's model;
// falls back to the built-in defaults without one (then --backend is
// required, and a seat that needs a key reads it from its key file or the
// environment).
//
// Zero-cost workflow rows (the dispatcher's own step traces, which never
// ran an agent) are left out before any seat is asked and counted in the
// report. Skipping them would save nothing, and counting them as skips
// overstated the gate's share (#626).
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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, resolve } from "path"
import { configureDecisions, registerBuiltinDecisionBackends, DecisionStore } from "../src/decisions"
import { seatEnvVar } from "../src/decisions/seat"
import { WAKE_GATE_SEAT, SKIP_BELOW } from "../src/decisions/seats/wake-gate"
import { TASK_TIER_SEAT } from "../src/decisions/seats/task-tier"
import { DOWNGRADE_BELOW, cheapModelForEngine } from "../src/agents/routing"
import { loadPricingWithOverrides } from "../src/daemon/token-tracker"
import { loadEnvFileIntoProcess } from "../src/utils/workspace-env"
import {
  buildReport,
  decideTraces,
  dropZeroCostWorkflowRows,
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
const PRICING_OVERRIDES = ".agentx/pricing/custom.json"

/**
 * Where agentx.json lives, and so where .env, .agentx/pricing/custom.json
 * and the default report folder are looked up. Without --config that is the
 * current folder, as before. --config may name the file or its folder; a
 * folder is searched the way the daemon searches (agentx.json, then
 * .agentx/config.json).
 */
function resolveConfigHome(arg: string | undefined): { home: string; configPath: string | undefined } {
  if (!arg) return { home: process.cwd(), configPath: undefined }
  const expanded = arg === "~" || arg.startsWith("~/") ? resolve(homedir(), arg.slice(2)) : arg
  const p = resolve(process.cwd(), expanded)
  if (existsSync(p) && statSync(p).isDirectory()) {
    const candidates = [resolve(p, "agentx.json"), resolve(p, ".agentx/config.json")]
    const found = candidates.find((c) => existsSync(c))
    // Hand the first candidate on when none exists, so loadDaemonConfig
    // names the file it looked for in its error.
    return { home: p, configPath: found ?? candidates[0] }
  }
  return { home: dirname(p), configPath: p }
}

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
    config: get("config"),
    backend: get("backend"),
    out: get("out"),
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
  --config <path>            agentx.json, or the folder that holds it (default: the
                             current folder). Its .env and ${PRICING_OVERRIDES}
                             are read from the same folder.
  --backend <name>           decision backend: jev, typesafe, local, simple-jev, mock
                             (default: the wake-gate seat's backend in agentx.json,
                             else decisions.defaultBackend, else jev)
  --out <dir>                where report.json and sample.csv go
                             (default: ${DEFAULT_OUT} under the agentx.json folder)
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
  //
  // Paths the person typed (--traces, --prices, --out) are relative to
  // where they typed them; what belongs to the installation (.env, pricing
  // overrides, the default report folder) is relative to agentx.json.
  const { home, configPath } = resolveConfigHome(args.config)
  const outDir = args.out ? resolve(process.cwd(), args.out) : resolve(home, DEFAULT_OUT)
  // Without --config, loadDaemonConfig searches the current folder itself;
  // this is the same search, for the "config" line below.
  const configRead =
    configPath ?? [resolve(home, "agentx.json"), resolve(home, ".agentx/config.json")].find((p) => existsSync(p))
  let config: any = null
  try {
    // loadDaemonConfig reads .env from the current folder only; with
    // --config the keys sit next to agentx.json instead.
    if (home !== process.cwd()) loadEnvFileIntoProcess(resolve(home, ".env"))
    const { loadDaemonConfig } = await import("../src/daemon/config")
    config = loadDaemonConfig(configPath)
  } catch (e: unknown) {
    // The whole message: a validation failure lists the fields that are
    // wrong on the lines after the first, and that is what the person needs.
    const detail = String((e as Error)?.message ?? e).trim().replace(/\n/g, "\n           ")
    console.error(`[backtest] no agentx.json read; using built-in backend defaults\n           ${detail}`)
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
  mkdirSync(outDir, { recursive: true })
  const store = args.record ? new DecisionStore({ path: resolve(outDir, "decisions.sqlite") }) : null
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
    const overrides = resolve(home, PRICING_OVERRIDES)
    pricing = loadPricingWithOverrides(overrides)
    pricingSource = existsSync(overrides)
      ? `built-in list prices merged with ${PRICING_OVERRIDES}`
      : "built-in list prices (src/daemon/token-tracker.ts)"
  }

  // --- traces ------------------------------------------------------------
  const tracesPath = resolve(process.cwd(), args.traces!)
  const { kept, dropped } = dropZeroCostWorkflowRows(parseTraceExport(JSON.parse(readFileSync(tracesPath, "utf-8"))))
  let traces = kept
  if (args.channels) traces = traces.filter((t) => args.channels!.includes(t.channel ?? "unknown"))
  if (args.agents) traces = traces.filter((t) => args.agents!.includes(t.agentId))
  if (args.limit) traces = traces.slice(0, args.limit)
  if (traces.length === 0) {
    console.error(`[backtest] no finished traces in ${args.traces} after filters`)
    process.exit(1)
  }

  console.error(`traces     ${traces.length} from ${args.traces}`)
  if (dropped.length > 0) console.error(`left out   ${dropped.length} zero-cost workflow rows (no agent ran, nothing to save)`)
  console.error(`config     ${config && configRead ? configRead : "none read"}`)
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
    droppedZeroCostWorkflow: dropped.length,
  })
  const sample = sampleRows(verdicts, {
    skipBelow: args.skipBelow,
    downgradeBelow: args.downgradeBelow,
    perKind: args.sample,
  })

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
