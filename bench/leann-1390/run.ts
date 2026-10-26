// Arms A and B of the LEANN vs BM25 spike (#1390).
//
//   pnpm bench:leann run <state-dir> --arm A          # BM25 as shipped (src/memory/bm25.ts)
//   pnpm bench:leann run <state-dir> --arm B          # same BM25, Unicode tokenizer
//   pnpm bench:leann run <state-dir> --arm B --k 10 --run-id <id>
//
// Reads <state-dir>/snapshot/{corpus,questions}.jsonl. Writes
// <state-dir>/results-<run_id>.jsonl (one line per question: ids, scores,
// timings, never text) and appends the exact command to
// <state-dir>/COMMANDS.md (no host name or cwd: it may go on screen).
// Prints a per-question table of ids and scores.
// Arm C is bench/leann-1390/arm_c_leann.py; grading is `pnpm bench:leann grade`.

import { appendFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { buildIndex, scoreAll } from "../../src/memory/bm25"
import { bm25, firstHitRank, loadSnapshot, newRunId, tokenizeUnicode, type ResultLine } from "./lib"

export function runArm(argv: string[]): void {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const VALUED = new Set(["--arm", "--k", "--run-id"])
  const dir = argv.find((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]))
  const arm = (flag("--arm") ?? "").toUpperCase()
  if (!dir || (arm !== "A" && arm !== "B")) {
    process.stderr.write("usage: pnpm bench:leann run <state-dir> --arm A|B [--k <n>] [--run-id <id>]\n")
    process.exit(2)
  }
  const k = Math.max(1, Number(flag("--k")) || 10)
  const runId = flag("--run-id") ?? newRunId(arm)
  const snap = loadSnapshot(join(dir, "snapshot"))

  // One index per pool, built before the clock starts: the product loads
  // a cached index too, so latency is the query alone.
  const pools = new Map<string, { ids: string[]; query: (q: string) => Array<{ docIndex: number; score: number }> }>()
  const poolFor = (kind?: string) => {
    const key = kind ?? "*"
    let pool = pools.get(key)
    if (!pool) {
      const docs = snap.docs.filter((d) => !kind || d.kind === kind)
      const texts = docs.map((d) => d.text)
      const query = arm === "A"
        ? (() => { const index = buildIndex(texts); return (q: string) => scoreAll(q, index) })()
        : bm25(texts, tokenizeUnicode)
      pool = { ids: docs.map((d) => d.id), query }
      pools.set(key, pool)
    }
    return pool
  }

  const variant = arm === "A" ? "bm25-ascii" : "bm25-unicode"
  // Written as .partial and renamed at the end: the grader reads only
  // finished runs, so an interrupted one cannot pass for a complete one.
  const outPath = join(dir, `results-${runId}.jsonl`)
  const partial = `${outPath}.partial`
  writeFileSync(partial, "")
  process.stdout.write(`run ${runId}  arm ${arm} (${variant})  snapshot ${snap.hash}  ${snap.questions.length} questions  k=${k}\n`)
  for (const q of snap.questions) {
    const pool = poolFor(q.kind)
    const t0 = performance.now()
    const ranked = pool.query(q.query)
    const latency = performance.now() - t0
    const hits = ranked.slice(0, k).map((r) => ({ id: pool.ids[r.docIndex], score: round(r.score) }))
    const line: ResultLine = {
      ts: new Date().toISOString(), run_id: runId, arm, variant, snapshot: snap.hash,
      qid: q.qid, lang: q.lang, type: q.type ?? null, k, latency_ms: round(latency),
      hits, expected: q.expected, first_hit_rank: firstHitRank(hits, q.expected),
    }
    appendFileSync(partial, JSON.stringify(line) + "\n")
    const top = hits.slice(0, 3).map((h) => `${h.id}:${h.score}`).join(" ") || "(no results)"
    process.stdout.write(`${q.qid.padEnd(10)} ${String(q.lang).padEnd(6)} rank ${String(line.first_hit_rank ?? "-").padEnd(3)} ${top}\n`)
  }

  renameSync(partial, outPath)
  appendFileSync(join(dir, "COMMANDS.md"), commandEntry(runId, ["pnpm", "bench:leann", ...process.argv.slice(2)], snap.hash))
  process.stdout.write(`wrote ${outPath}\n`)
}

function round(n: number): number { return Math.round(n * 10000) / 10000 }

function commandEntry(runId: string, cmd: string[], snapshot: string): string {
  let commit = "unknown"
  try { commit = execFileSync("git", ["describe", "--always", "--dirty"], { encoding: "utf-8" }).trim() } catch { /* not a checkout */ }
  const quoted = cmd.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ")
  return `\n## ${runId}\n\n- when: ${new Date().toISOString()}\n- agentx commit: ${commit}\n- snapshot: ${snapshot}\n\n\`\`\`bash\n${quoted}\n\`\`\`\n`
}
