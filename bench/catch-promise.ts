// How well the promise catcher (#1138 step E) reads replies, and what a
// call costs.
//
//   pnpm bench:catch <labelled.jsonl>                       # Haiku, a table
//   pnpm bench:catch <labelled.jsonl> --model <id> --json   # one JSON object
//   pnpm bench:catch <labelled.jsonl> --concurrency 2 --out verdicts.jsonl
//   pnpm bench:catch <labelled.jsonl> --think              # the CLI's default thinking on
//
// Input: one JSON object per line, {reply, asked?, label, at?}, label one
// of "promise", "waiting_owner", "none". Keep a set made of real replies
// outside the repo: it holds private text.
//
// Each reply runs through the same word check, prompt and reader as the
// daemon (src/requests/catch.ts), as one bare `claude -p` call on the
// operator's own auth. A reply the word check skips counts as "none"
// with no call. Prints precision and recall per kind (the proof of done
// asks precision of at least 0.8 for "promise"), the confusion table,
// and the cost and time of one call as `claude -p` reports them.

import { readFileSync, writeFileSync } from "node:fs"
import { execa } from "execa"
import { buildCliGenerateArgs } from "../src/agent/providers/claude-code"
import { CATCH_KINDS, CATCH_SYSTEM, catchPrompt, mayCatch, readVerdict, type CatchKind } from "../src/requests/catch"

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const VALUED = new Set(["--model", "--concurrency", "--out"])
const file = args.find((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1]))
if (!file) {
  process.stderr.write("usage: pnpm bench:catch <labelled.jsonl> [--model <id>] [--concurrency <n>] [--out <file>] [--json]\n")
  process.exit(2)
}
const MODEL = flag("--model") ?? "claude-haiku-4-5-20251001"
const CONCURRENCY = Math.max(1, Number(flag("--concurrency")) || 4)
const OUT = flag("--out")
const JSON_OUT = args.includes("--json")
/** Let the CLI think, as it does by default: to compare. */
const THINK = args.includes("--think")

interface Item { reply: string; asked?: string; label: CatchKind; at?: number; n?: number }
interface Row { n: number; label: CatchKind; got: CatchKind | "error"; called: boolean; costUsd: number; inTokens: number; outTokens: number; ms: number; raw?: string }

const items: Item[] = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
for (const it of items) {
  if (!(CATCH_KINDS as readonly string[]).includes(it.label)) throw new Error(`unlabelled item: ${JSON.stringify(it).slice(0, 120)}`)
}

async function judge(it: Item, n: number): Promise<Row> {
  const base = { n: it.n ?? n, label: it.label }
  if (!mayCatch(it.reply)) return { ...base, got: "none", called: false, costUsd: 0, inTokens: 0, outTokens: 0, ms: 0 }
  // Read as of the reply's own time, so "tomorrow" means what it meant then.
  const now = it.at ?? Date.now()
  const t0 = performance.now()
  const res = await execa("claude", buildCliGenerateArgs({ model: MODEL, systemPrompt: CATCH_SYSTEM, prompt: catchPrompt({ reply: it.reply, asked: it.asked, now }), bare: true }), {
    reject: false, timeout: 120_000, stdin: "ignore", cwd: "/tmp",
    // As the daemon calls it: no thinking (ProviderOptions.noThinking).
    env: THINK ? {} : { MAX_THINKING_TOKENS: "0" },
  })
  const ms = performance.now() - t0
  let out: any = {}
  try { out = JSON.parse(res.stdout) } catch { out = { result: res.stdout } }
  const usage = out.usage ?? {}
  const verdict = res.exitCode === 0 ? readVerdict(String(out.result ?? ""), now, it.reply) : null
  return {
    ...base, got: verdict?.kind ?? "error", called: true, ms,
    costUsd: Number(out.total_cost_usd) || 0,
    inTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outTokens: usage.output_tokens ?? 0,
    raw: String(res.exitCode === 0 ? out.result ?? "" : res.stderr || `claude exited ${res.exitCode}`).slice(0, 400),
  }
}

const rows: Row[] = new Array(items.length)
let next = 0
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < items.length) {
    const i = next++
    rows[i] = await judge(items[i], i)
    if (!JSON_OUT) process.stderr.write(".")
  }
}))
if (!JSON_OUT) process.stderr.write("\n")

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d
const perKind = Object.fromEntries(CATCH_KINDS.map((k) => {
  const tp = rows.filter((r) => r.got === k && r.label === k).length
  const said = rows.filter((r) => r.got === k).length
  const truth = rows.filter((r) => r.label === k).length
  return [k, { precision: said ? round(tp / said) : null, recall: truth ? round(tp / truth) : null, predicted: said, labelled: truth, correct: tp }]
}))
const confusion = Object.fromEntries(CATCH_KINDS.map((l) => [l, Object.fromEntries([...CATCH_KINDS, "error"].map((g) => [g, rows.filter((r) => r.label === l && r.got === g).length]))]))
const called = rows.filter((r) => r.called)
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const summary = {
  file, model: MODEL, items: rows.length, calls: called.length, errors: rows.filter((r) => r.got === "error").length,
  accuracy: round(rows.filter((r) => r.got === r.label).length / rows.length),
  perKind, confusion,
  perCall: { costUsd: round(mean(called.map((r) => r.costUsd)), 5), inputTokens: Math.round(mean(called.map((r) => r.inTokens))), outputTokens: Math.round(mean(called.map((r) => r.outTokens))), seconds: round(mean(called.map((r) => r.ms)) / 1000, 1) },
  totalCostUsd: round(called.reduce((a, r) => a + r.costUsd, 0), 4),
}
if (OUT) writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n")
} else {
  console.log(`${summary.items} replies, ${summary.calls} calls on ${MODEL}, ${summary.errors} without a verdict, accuracy ${summary.accuracy}`)
  console.log("")
  console.log("kind            precision  recall  predicted  labelled")
  for (const k of CATCH_KINDS) {
    const p = perKind[k]
    console.log(`${k.padEnd(16)}${String(p.precision ?? "-").padEnd(11)}${String(p.recall ?? "-").padEnd(8)}${String(p.predicted).padEnd(11)}${p.labelled}`)
  }
  console.log("")
  console.log(`labelled \\ got  ${[...CATCH_KINDS, "error"].map((g) => g.padEnd(14)).join("")}`)
  for (const l of CATCH_KINDS) console.log(`${l.padEnd(16)}${[...CATCH_KINDS, "error"].map((g) => String(confusion[l][g]).padEnd(14)).join("")}`)
  console.log("")
  console.log(`per call: $${summary.perCall.costUsd}, ${summary.perCall.inputTokens} tokens in, ${summary.perCall.outputTokens} out, ${summary.perCall.seconds} s; total $${summary.totalCostUsd}`)
  const promise = perKind.promise
  console.log(`proof of done (promise precision >= 0.8): ${promise.precision !== null && promise.precision >= 0.8 ? "MET" : "NOT MET"}`)
}
