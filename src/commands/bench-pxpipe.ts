import { Command } from "commander"
import chalk from "chalk"
import { writeFileSync, readFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"

// --- agentx bench pxpipe: A/B the same workload with and without the
//     pxpipe image-context compression proxy ---
//
// Two modes:
//  - cost (default): send the same message N times per arm, fresh chat each
//    run, compare billed tokens / cost / latency.
//  - --fidelity: per run, turn 1 makes the agent Read a dense generated
//    payload file (the tool_result is what pxpipe images), turn 2+ probes
//    verbatim recall of 12-char hex ids from that payload — exactly the
//    documented pxpipe failure mode. Exact-match rate per arm is the score.
//
// Honesty notes baked into the design: each run uses a fresh chatId +
// freshSession so neither arm inherits the other's prompt cache; usage is
// what the API actually billed (image tokens land in inputTokens); the
// proxy's own ~/.pxpipe/events.jsonl accounting is printed separately as
// a secondary (self-reported) source.

interface ArmTotals {
  label: string
  runs: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheCreate: number
  durationMs: number
  cost: number
  fidelityHits: number
  fidelityProbes: number
  lastResponse: string
  lastError?: string
}

export const benchPxpipe = new Command()
  .name("pxpipe")
  .description("A/B the same workload with and without the pxpipe image-context proxy")
  .requiredOption("--agent <id>", "agent id (claude-code tier)")
  .option("--message <text>", "message for cost mode", "Summarize your operating rules and current capabilities in 5 bullet points.")
  .option("--runs <n>", "runs per arm", "2")
  .option("--fidelity", "verbatim-recall probe mode (Read a dense payload, then recall hex ids)", false)
  .option("--workspace <dir>", "agent workspace dir — fidelity mode writes the payload file here")
  .option("--payload-chars <n>", "approx payload size in chars (fidelity)", "30000")
  .option("--queries <n>", "recall probes per run (fidelity)", "6")
  .option("--url <url>", "daemon URL", "http://127.0.0.1:18800")
  .option("--chat-prefix <p>", "chatId prefix", "bench-px")
  .action(async (opts) => {
    const runs = Math.max(1, parseInt(opts.runs, 10) || 1)
    const benchStart = Date.now()

    console.log()
    console.log(chalk.bold(`  pxpipe benchmark — ${opts.fidelity ? "fidelity (verbatim recall)" : "cost"} mode`))
    console.log(chalk.dim(`  agent=${opts.agent}, runs=${runs}/arm, daemon=${opts.url}`))
    console.log()

    const off = await runArm(false, opts, runs)
    const on = await runArm(true, opts, runs)

    printComparison(off, on, Boolean(opts.fidelity))
    printPxpipeEvents(benchStart)
    printCaveats()
  })

async function runArm(pxpipe: boolean, opts: Record<string, any>, runs: number): Promise<ArmTotals> {
  const t: ArmTotals = {
    label: pxpipe ? "pxpipe ON" : "pxpipe OFF",
    runs, errors: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0,
    durationMs: 0, cost: 0, fidelityHits: 0, fidelityProbes: 0, lastResponse: "",
  }
  for (let i = 0; i < runs; i++) {
    const chatId = `${opts.chatPrefix}-${pxpipe ? "on" : "off"}-${Date.now()}-${i}`
    process.stdout.write(chalk.dim(`  [${t.label}] run ${i + 1}/${runs} (${chatId}) ... `))
    try {
      if (opts.fidelity) {
        await runFidelityRun(pxpipe, chatId, opts, t)
      } else {
        const r = await postTask(opts.url, opts.agent, opts.message, chatId, pxpipe, true)
        accumulate(t, r)
        t.lastResponse = r.content ?? ""
      }
      console.log(chalk.green("done"))
    } catch (e: any) {
      t.errors++
      t.lastError = e.message ?? String(e)
      console.log(chalk.red(`error: ${t.lastError}`))
    }
  }
  return t
}

/** Deterministic dense payload: N records with 12-char hex ids. Same seed
 *  every bench → both arms read byte-identical data. */
function generatePayload(chars: number): { text: string; records: Map<number, string> } {
  let s = 0x2f6e1c3d
  const rand = () => {
    // LCG (Numerical Recipes) — deterministic across runs and platforms.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s
  }
  const records = new Map<number, string>()
  const lines: string[] = ["# bench payload — service inventory export (synthetic)"]
  let n = 0
  while (lines.join("\n").length < chars) {
    n++
    const hex = Array.from({ length: 12 }, () => (rand() % 16).toString(16)).join("")
    records.set(n, hex)
    lines.push(
      `record ${String(n).padStart(4, "0")} | id=${hex} | qty=${rand() % 10000} | ` +
      `shard=${rand() % 64} | region=r${rand() % 9} | flags=0x${(rand() % 65536).toString(16).padStart(4, "0")}`,
    )
  }
  return { text: lines.join("\n"), records }
}

async function runFidelityRun(pxpipe: boolean, chatId: string, opts: Record<string, any>, t: ArmTotals): Promise<void> {
  if (!opts.workspace) throw new Error("--workspace <agent workspace dir> is required with --fidelity")
  const payloadChars = Math.max(5_000, parseInt(opts.payloadChars, 10) || 30_000)
  const queries = Math.max(1, parseInt(opts.queries, 10) || 6)
  const { text, records } = generatePayload(payloadChars)
  const fname = "bench-payload.txt"
  writeFileSync(join(resolve(opts.workspace), fname), text)

  // Turn 1 — load the payload through the Read tool. The tool_result body
  // is the dense block pxpipe images on the ON arm.
  const load = await postTask(
    opts.url, opts.agent,
    `Use the Read tool to read the file ./${fname} in this workspace completely (all lines). After reading, reply with exactly: LOADED`,
    chatId, pxpipe, true,
  )
  accumulate(t, load)
  if (load.error) throw new Error(`load turn failed: ${load.error}`)

  // Turn 2 — verbatim recall probes, same session (resume replays the
  // turn-1 tool_result — imaged on the ON arm, text on the OFF arm).
  const ids = pickProbeIds(records.size, queries)
  const question =
    `Without re-reading the file, answer from the file content you already read. ` +
    `For each record number below, give its exact 12-character hex id. ` +
    `Reply with one line per record in the format "NNNN: hex", nothing else.\n` +
    ids.map((n) => String(n).padStart(4, "0")).join("\n")
  const probe = await postTask(opts.url, opts.agent, question, chatId, pxpipe, false)
  accumulate(t, probe)
  if (probe.error) throw new Error(`probe turn failed: ${probe.error}`)
  t.lastResponse = probe.content ?? ""

  for (const n of ids) {
    t.fidelityProbes++
    const expected = records.get(n)!
    const line = (probe.content ?? "").split("\n").find((l: string) => l.includes(String(n).padStart(4, "0")))
    const hex = line?.match(/\b[0-9a-f]{12}\b/i)?.[0]?.toLowerCase()
    if (hex === expected) t.fidelityHits++
  }
}

/** Spread probes across the payload — early, middle, late records. */
function pickProbeIds(max: number, count: number): number[] {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    ids.push(Math.max(1, Math.min(max, Math.round(((i + 0.5) / count) * max))))
  }
  return Array.from(new Set(ids))
}

async function postTask(url: string, agent: string, message: string, chatId: string, pxpipe: boolean, fresh: boolean) {
  const r = await fetch(`${url}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent, message, pxpipe,
      freshSession: fresh,
      context: { channel: "bench", chatId, sender: "bench" },
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  })
  return (await r.json()) as {
    content?: string; error?: string; duration?: number
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreateTokens?: number }
  }
}

function accumulate(t: ArmTotals, r: Awaited<ReturnType<typeof postTask>>): void {
  t.inputTokens += r.usage?.inputTokens ?? 0
  t.outputTokens += r.usage?.outputTokens ?? 0
  t.cacheRead += r.usage?.cacheReadTokens ?? 0
  t.cacheCreate += r.usage?.cacheCreateTokens ?? 0
  t.durationMs += r.duration ?? 0
  // Sonnet-class API rates — directional only; subscription (OAuth) runs
  // don't bill per-token, but relative deltas still hold.
  t.cost +=
    (r.usage?.inputTokens ?? 0) * 3 / 1e6 +
    (r.usage?.outputTokens ?? 0) * 15 / 1e6 +
    (r.usage?.cacheReadTokens ?? 0) * 0.3 / 1e6 +
    (r.usage?.cacheCreateTokens ?? 0) * 3.75 / 1e6
}

function printComparison(a: ArmTotals, b: ArmTotals, fidelity: boolean): void {
  const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length))
  const fmt = (n: number) => Math.round(n).toLocaleString()
  const na = Math.max(1, a.runs - a.errors)
  const nb = Math.max(1, b.runs - b.errors)

  console.log()
  console.log(chalk.bold("  " + pad("metric (avg/run)", 24) + pad(a.label, 16) + pad(b.label, 16) + "delta"))
  console.log(chalk.dim("  " + "-".repeat(72)))
  const rows: Array<[string, number, number, (n: number) => string]> = [
    ["input tokens", a.inputTokens / na, b.inputTokens / nb, fmt],
    ["output tokens", a.outputTokens / na, b.outputTokens / nb, fmt],
    ["cache read", a.cacheRead / na, b.cacheRead / nb, fmt],
    ["cache create", a.cacheCreate / na, b.cacheCreate / nb, fmt],
    ["total input", (a.inputTokens + a.cacheRead + a.cacheCreate) / na, (b.inputTokens + b.cacheRead + b.cacheCreate) / nb, fmt],
    ["est. cost ($)", a.cost / na, b.cost / nb, (n) => n.toFixed(4)],
    ["duration (ms)", a.durationMs / na, b.durationMs / nb, fmt],
  ]
  for (const [label, av, bv, f] of rows) {
    const d = bv - av
    const pct = av === 0 ? 0 : (d / av) * 100
    const ds = d === 0 ? chalk.dim("±0") : d < 0 ? chalk.green(`${f(d)} (${pct.toFixed(0)}%)`) : chalk.red(`+${f(d)} (+${pct.toFixed(0)}%)`)
    console.log("  " + pad(label, 24) + pad(f(av), 16) + pad(f(bv), 16) + ds)
  }
  if (fidelity) {
    const fa = a.fidelityProbes ? `${a.fidelityHits}/${a.fidelityProbes}` : "n/a"
    const fb = b.fidelityProbes ? `${b.fidelityHits}/${b.fidelityProbes}` : "n/a"
    const degraded = b.fidelityProbes > 0 && b.fidelityHits / b.fidelityProbes < (a.fidelityProbes ? a.fidelityHits / a.fidelityProbes : 1)
    console.log("  " + pad("verbatim recall", 24) + pad(fa, 16) + pad(fb, 16) + (degraded ? chalk.red("DEGRADED") : chalk.green("ok")))
  }
  console.log(chalk.dim("  " + "-".repeat(72)))
  if (a.errors || b.errors) {
    console.log(chalk.yellow(`  errors: OFF=${a.errors} (${a.lastError ?? ""}) ON=${b.errors} (${b.lastError ?? ""})`))
  }
  console.log()
}

/** Secondary, self-reported accounting from the proxy itself. */
function printPxpipeEvents(sinceMs: number): void {
  const path = join(homedir(), ".pxpipe", "events.jsonl")
  if (!existsSync(path)) return
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").slice(-500)
    let conversions = 0, baseline = 0, billed = 0
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        const ts = Date.parse(e.ts ?? "")
        if (Number.isFinite(ts) && ts < sinceMs) continue
        if (e.path !== "/v1/messages" || e.compressed !== true) continue
        conversions++
        baseline += e.baseline_tokens ?? 0
        billed += (e.input_tokens ?? 0) + (e.cache_create_tokens ?? 0) + (e.cache_read_tokens ?? 0)
      } catch { /* skip malformed */ }
    }
    if (conversions > 0) {
      console.log(chalk.dim(
        `  pxpipe self-reported (events.jsonl, this bench window): ${conversions} compressed requests,\n` +
        `  counterfactual text baseline ${baseline.toLocaleString()} tokens vs ${billed.toLocaleString()} billed ` +
        `(${baseline > 0 ? Math.round((1 - billed / baseline) * 100) : 0}% claimed saving — compare against the A/B table above, which is ground truth)`,
      ))
      console.log()
    }
  } catch { /* best-effort */ }
}

function printCaveats(): void {
  console.log(chalk.dim(
    "  Caveats: image tokens bill as input tokens (savings show as smaller input/cache\n" +
    "  numbers, not a separate line). pxpipe is lossy on byte-exact strings — run with\n" +
    "  --fidelity before enabling for agents that quote hashes/IDs or apply diffs.\n" +
    "  Cost column uses API rates; on OAuth/subscription only relative deltas matter.",
  ))
  console.log()
}
