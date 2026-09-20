import { Command } from "commander"
import chalk from "chalk"
import { readFileSync } from "fs"
import { askSeat, seatEnvVar, configureDecisions } from "@/decisions/seat"
import { registerBuiltinDecisionBackends } from "@/decisions"
import { DecisionStore } from "@/decisions/store"
import { validateQuestions } from "@/decisions/questions"
import type { AnyQuestion, StateValue } from "@/decisions/types"

// --- `agentx decide` — the general-purpose typed decision, for agents ---
//
// `decisions ask` is a smoke test: it does not record, it cannot express a
// boundary, and it defaults to the mock backend. This is the one an agent
// is meant to reach for, so it records by default and takes questions in
// their real shape.
//
// WHY AN AGENT SHOULD USE THIS AT ALL.
//
// An agent asked to classify two hundred items will otherwise reason about
// each one in its own context — slowly, expensively, and with an answer
// that is prose rather than a number. Routing that judgment here returns a
// typed answer with a probability, in a few hundred milliseconds, for a
// fraction of a cent, and writes a row that can be calibrated later. The
// agent keeps the workflow; only the judgment moves.
//
// Reads a spec on stdin or from --file:
//
//   {
//     "seat": "youtube-demand",
//     "state": { "title": "...", "views": 120000, "channelSubs": 800000 },
//     "questions": {
//       "trending": {
//         "type": "noul",
//         "instructions": "This video is being watched unusually heavily right now.",
//         "criteria": {
//           "true":  "Views in the first week already exceed the channel's typical view count.",
//           "false": "Views are in line with or below what this channel usually gets."
//         }
//       }
//     }
//   }
//
// Several questions in one spec run in ONE request and cannot see each
// other's answers, which is what makes them cheap — ask everything
// independent together.

export const decide = new Command()
  .name("decide")
  .description("ask a typed question about some state and get a calibrated answer back")
  .option("--file <path>", "spec JSON file (default: stdin)")
  .option("--backend <name>", "decision backend", "typesafe")
  .option("--seat <name>", "seat name the answers are recorded under", "adhoc")
  .option("--no-record", "answer without writing a row")
  .option("--timeout <ms>", "abandon the call after this long", "20000")
  .action(async (opts) => {
    let raw: string
    try {
      raw = opts.file ? readFileSync(opts.file, "utf8") : await readStdin()
    } catch (e: any) {
      fail(`could not read the spec: ${e?.message ?? e}`)
      return
    }
    if (!raw.trim()) return fail("no spec given — pipe JSON on stdin or pass --file")

    let spec: { seat?: string; state?: StateValue; questions?: Record<string, AnyQuestion> }
    try {
      spec = JSON.parse(raw)
    } catch (e: any) {
      return fail(`spec is not valid JSON: ${e?.message ?? e}`)
    }
    if (!spec.state) return fail("spec needs a `state`")
    if (!spec.questions || Object.keys(spec.questions).length === 0) {
      return fail("spec needs at least one entry in `questions`")
    }
    // Fail here rather than after a round trip — a choice with one option
    // or a score with one level is a spec bug, not a model problem.
    try {
      validateQuestions(spec.questions)
    } catch (e: any) {
      return fail(e?.message ?? String(e))
    }

    const seat = spec.seat || opts.seat
    registerBuiltinDecisionBackends()

    // Ad-hoc seats are not in agentx.json, and a seat nobody configured is
    // "off". The per-seat env override is read before config precisely so
    // a caller can turn one on for its own process.
    process.env[seatEnvVar(seat)] = "active"

    let store: DecisionStore | null = null
    if (opts.record !== false) {
      try {
        store = new DecisionStore({})
      } catch (e: any) {
        // Recording is the nice-to-have; answering is the job.
        process.stderr.write(`[decide] not recording (${e?.message ?? e})\n`)
      }
    }
    configureDecisions({
      enabled: true,
      defaultBackend: opts.backend,
      store,
      seats: { [seat]: { mode: "active", backend: opts.backend } },
    })

    const result = await askSeat(seat, spec.state, spec.questions, {
      timeoutMs: Number(opts.timeout) || 20_000,
      features: { via: "cli" },
    })

    if (!result) {
      return fail(
        `the ${opts.backend} backend did not answer — check the key and that the seat is reachable`,
      )
    }

    // One JSON object on stdout, because the caller is a program.
    console.log(JSON.stringify({ ok: true, seat, callId: result.callId, answers: result.answers }, null, 2))
    store?.close()
  })

function fail(message: string): void {
  console.log(JSON.stringify({ ok: false, error: message }, null, 2))
  process.exitCode = 1
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString("utf8")
}
