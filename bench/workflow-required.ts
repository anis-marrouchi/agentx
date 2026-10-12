// What `workflows.required` (#858) costs a one-step task: the `linear` wrap.
//
//   pnpm bench:required                # 200 tasks, a table
//   pnpm bench:required --runs 1000    # more samples
//   pnpm bench:required --json         # one JSON object
//
// No model is called. A wrapped task runs exactly the turn it would run
// anyway; what the wrap adds is
//   time    creating the run before the turn and closing it after (run
//           store writes on the local disk), measured here for real;
//   tokens  the one context block that names the run, sent on every
//           wrapped turn, and the plan/step sentence in the agentx_workflow
//           tool description (estimated, ~4 characters per token, the same
//           estimate the context planner uses).
// A plan the agent writes adds tool calls of its own: 1 plan + 1 per step
// reported, each an extra model round-trip inside the same turn. Only
// their run-store side is timed here (plan of 3 steps, each reported done);
// the model side needs a real agent and is measured on a live install.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { RunStore } from "../src/workflows/run-store"
import { finishWrap, PLAN_TOOL_TEXT, reportStep, startWrap, wrapHintText, writePlan } from "../src/workflows/required"
import { estimateTokens } from "../src/agents/context"

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const RUNS = Math.max(10, Number(flag("--runs")) || 200)
const JSON_OUT = args.includes("--json")

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const round = (n: number) => Math.round(n * 100) / 100

const dir = mkdtempSync(join(tmpdir(), "agentx-bench-required-"))
try {
  const runs = new RunStore({ baseDir: dir, nodeId: "bench" })
  const outcome = { durationMs: 1000, readOnly: false, exemptQuestions: true, inputTokens: 1000, outputTokens: 100 }
  const message = "Rename the March report to Q1 and tell me when it is done."

  const linear: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    const runId = randomUUID()
    startWrap(runs, { runId, agentId: "bench", channel: "api", chatId: "c", message })
    finishWrap(runs, runId, outcome)
    linear.push(performance.now() - t0)
  }

  const plan: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    const runId = randomUUID()
    startWrap(runs, { runId, agentId: "bench", channel: "api", chatId: "c", message })
    writePlan(runs, runId, { steps: ["Find the report", "Rename it", "Tell the owner"] })
    for (const step of ["step1", "step2", "step3"]) reportStep(runs, runId, { step, status: "done" })
    finishWrap(runs, runId, outcome)
    plan.push(performance.now() - t0)
  }

  const hintTokens = estimateTokens(wrapHintText(randomUUID()))
  const toolTokens = estimateTokens(PLAN_TOOL_TEXT)
  const result = {
    runs: RUNS,
    linearMs: { p50: round(pct(linear, 50)), p95: round(pct(linear, 95)), max: round(Math.max(...linear)) },
    planOf3Ms: { p50: round(pct(plan, 50)), p95: round(pct(plan, 95)), max: round(Math.max(...plan)) },
    tokens: { hintPerTurn: hintTokens, toolDescription: toolTokens, perWrappedTurn: hintTokens + toolTokens },
    extraModelCalls: { linear: 0, planOf3: "4 tool calls (1 plan + 3 step reports), each a model round-trip inside the same turn; not measured here" },
  }
  if (JSON_OUT) {
    console.log(JSON.stringify(result))
  } else {
    console.log(`workflows.required overhead, ${RUNS} tasks each (no model called)\n`)
    console.log(`  linear wrap (one-step task)   p50 ${result.linearMs.p50} ms   p95 ${result.linearMs.p95} ms   max ${result.linearMs.max} ms`)
    console.log(`  plan of 3, each reported      p50 ${result.planOf3Ms.p50} ms   p95 ${result.planOf3Ms.p95} ms   max ${result.planOf3Ms.max} ms`)
    console.log(`  tokens per wrapped turn       ~${result.tokens.perWrappedTurn} (hint ${hintTokens} + tool text ${toolTokens}), input only`)
    console.log(`  extra model calls (linear)    0`)
    console.log(`  extra model calls (plan of 3) 4 tool calls in the same turn (not measured here)`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
