// Grades results-*.jsonl from every arm of the LEANN vs BM25 spike (#1390).
//
//   pnpm bench:leann grade <state-dir>                  # every results-*.jsonl in it
//   pnpm bench:leann grade <state-dir> --by lang        # one row per run × language
//   pnpm bench:leann grade <state-dir> --by type        # one row per run × question type
//   pnpm bench:leann grade <state-dir> --questions      # per question: rank and top id per run
//   pnpm bench:leann grade <state-dir> --json
//
// Output is ids, scores and numbers only, so it can go on screen. Every
// row names its run id; the run's file and COMMANDS.md entry share it.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { grade, type ResultLine } from "./lib"

export function gradeRuns(argv: string[]): void {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const dir = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--by")
  if (!dir) {
    process.stderr.write("usage: pnpm bench:leann grade <state-dir> [--by lang|type] [--questions] [--json]\n")
    process.exit(2)
  }
  const files = readdirSync(dir).filter((f) => /^results-.*\.jsonl$/.test(f)).sort()
  const lines: ResultLine[] = files.flatMap((f) =>
    readFileSync(join(dir, f), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ResultLine))
  if (!lines.length) {
    process.stderr.write(`no results-*.jsonl in ${dir}\n`)
    process.exit(1)
  }
  const snapshots = new Set(lines.map((l) => l.snapshot))
  if (snapshots.size > 1) process.stderr.write(`warning: runs cover ${snapshots.size} different snapshots: ${[...snapshots].join(", ")}\n`)

  const runs = [...new Set(lines.map((l) => l.run_id))]
  const runOf = (id: string) => lines.find((l) => l.run_id === id)!

  if (argv.includes("--questions")) {
    const qids = [...new Set(lines.map((l) => l.qid))]
    const header = ["qid", "lang", "type", ...runs.map((r) => `${runOf(r).arm} ${r}`)]
    const rows = qids.map((qid) => {
      const any = lines.find((l) => l.qid === qid)!
      return [qid, any.lang, any.type ?? "", ...runs.map((r) => {
        const l = lines.find((x) => x.run_id === r && x.qid === qid)
        if (!l) return "n/a"
        const top = l.hits[0] ? `${l.hits[0].id} ${l.hits[0].score}` : "no results"
        return `${l.first_hit_rank ?? "miss"} · ${top}`
      })]
    })
    if (argv.includes("--json")) process.stdout.write(JSON.stringify({ header, rows }, null, 2) + "\n")
    else process.stdout.write(table(header, rows))
    return
  }

  const by = flag("--by") as "lang" | "type" | undefined
  const json = argv.includes("--json")
  // Tables show the count next to each rate: with 10 questions a group,
  // one question is 10 points, and a reader must see that.
  const rate = (r: number, n: number) => (json ? fix(r) : `${fix(r)} (${Math.round(r * n)}/${n})`)
  const out: Array<Record<string, string | number>> = []
  for (const r of runs) {
    const mine = lines.filter((l) => l.run_id === r)
    const groups = by ? [...new Set(mine.map((l) => String(l[by] ?? "")))].sort() : ["all"]
    for (const g of groups) {
      const sel = by ? mine.filter((l) => String(l[by] ?? "") === g) : mine
      const s = grade(sel)
      out.push({
        run: r, arm: mine[0].arm, variant: mine[0].variant, [by ?? "group"]: g, n: s.n,
        "recall@3": rate(s.recall3, s.n), "recall@5": rate(s.recall5, s.n), mrr: fix(s.mrr),
        "zero-result": rate(s.zero, s.n), "p50 ms": fix(s.p50), "p95 ms": fix(s.p95),
      })
    }
  }
  if (json) process.stdout.write(JSON.stringify({ snapshots: [...snapshots], rows: out }, null, 2) + "\n")
  else process.stdout.write(table(Object.keys(out[0]), out.map((o) => Object.values(o).map(String))))
}

function fix(n: number, d = 3): number { return Number(n.toFixed(d)) }

function table(header: string[], rows: string[][]): string {
  const esc = (c: string) => c.replace(/\|/g, "\\|")
  return [
    `| ${header.map(esc).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n") + "\n"
}
