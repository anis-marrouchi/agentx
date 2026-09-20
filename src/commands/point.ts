import { Command } from "commander"
import { execFile } from "child_process"
import { promisify } from "util"
import { existsSync } from "fs"
import { resolve } from "path"
import chalk from "chalk"
import { askSeat } from "@/decisions/seat"
import {
  UI_ELEMENT_SEAT,
  uiElementQuestions,
  uiElementState,
  toSelection,
  type UICandidate,
  type UIElementAnswers,
} from "@/decisions/seats/ui-element"
import { buildCandidates } from "@/computer-use/candidates"

const run = promisify(execFile)

// --- `agentx point "<what you mean>"` ---
//
// Reads the focused window's accessibility tree, asks the ui-element seat
// which control the request names, and moves the cursor there with a
// highlight. It does NOT click.
//
// This lives in agentx rather than inside the voice widget on purpose: the
// capability then belongs to every agent — the secretary by voice, devops
// over WhatsApp, a cron job — instead of to one app. Swift owns only the
// parts Node cannot reach.

const HELPER = resolve(
  process.cwd(),
  "apps/mac-helper/build/AgentX Helper.app/Contents/MacOS/agentx-mac-helper",
)

interface Snapshot {
  app: string
  window?: string | null
  elements: Array<UICandidate & { x: number; y: number; width: number; height: number }>
  truncated: boolean
  note?: string | null
}

/** Controls a person could plausibly mean. The raw tree is mostly groups
 *  and static text scaffolding; handing forty of those to a model buys
 *  nothing and crowds out the real candidates. */


export const point = new Command()
  .name("point")
  .description("point at the on-screen control matching a description (does not click)")
  .argument("<request>", 'what you mean, e.g. "the send button"')
  .option("--max <n>", "candidates to consider", "40")
  .option("--json", "emit the decision as JSON instead of pointing")
  .option("--min-present <p>", "refuse below this P(control exists)", "0.5")
  .action(async (request: string, opts) => {
    if (!existsSync(HELPER)) {
      console.log(chalk.red(`  helper not built — run apps/mac-helper/build.sh`))
      process.exit(1)
    }

    let snap: Snapshot
    try {
      const { stdout } = await run(HELPER, ["read", "--max", "400"])
      snap = JSON.parse(stdout)
    } catch (e: any) {
      const detail = e?.stdout ? tryError(e.stdout) : e?.message
      console.log(chalk.red(`  could not read the screen: ${detail}`))
      process.exit(1)
    }

    // Page-scoped: in a browser the tree holds the page AND the browser
    // around it, and the browser's own search bar beats the page's.
    const candidates: UICandidate[] = buildCandidates(snap.elements as never, Number(opts.max) || 40)

    // A Choice needs at least two options to be a choice. One or zero is
    // not a model problem and must not reach the model — with a single
    // candidate there is nothing to decide, and with none the honest
    // answer is that this app exposes nothing usable.
    if (candidates.length === 0) {
      console.log(chalk.yellow(`  ${snap.app} exposes no usable controls${snap.note ? ` — ${snap.note}` : ""}`))
      process.exit(2)
    }
    if (candidates.length === 1) {
      const only = snap.elements.find((e) => e.id === candidates[0].id)!
      console.log(
        chalk.yellow(`  ${snap.app} exposes exactly one control — pointing at it without asking: `) +
        chalk.bold(candidates[0].label),
      )
      await run(HELPER, [
        "point", "--x", String(only.x), "--y", String(only.y),
        "--w", String(only.width), "--h", String(only.height), "--label", candidates[0].label,
      ])
      return
    }

    const result = await askSeat(
      UI_ELEMENT_SEAT,
      uiElementState({ request, app: snap.app, window: snap.window, candidates }),
      uiElementQuestions(candidates),
      { features: { app: snap.app, candidates: candidates.length } },
    )
    if (!result) {
      console.log(chalk.red(`  the ui-element seat is unavailable — set decisions.seats.${UI_ELEMENT_SEAT}.mode`))
      process.exit(1)
    }

    const sel = toSelection(result.answers as UIElementAnswers, candidates)
    const chosen = snap.elements.find((e) => e.id === sel.id)

    // `present` is read BEFORE `target`, always. A Choice over a candidate
    // set will always name something; this is the question that can say
    // the thing simply is not on screen.
    const minPresent = Number(opts.minPresent) || 0.5
    if (sel.present < minPresent || !chosen) {
      console.log(
        chalk.yellow(`  nothing on screen matches "${request}"`) +
        chalk.dim(` (P(exists)=${sel.present.toFixed(2)} below ${minPresent})`),
      )
      process.exit(2)
    }

    if (opts.json) {
      console.log(JSON.stringify({
        app: snap.app, request, chosen: { ...chosen }, present: sel.present,
        confidence: sel.confidence,
        ranked: sel.ranked.slice(0, 5).map((r) => ({
          ...r, label: candidates.find((c) => c.id === r.id)?.label,
        })),
      }, null, 2))
      return
    }

    const name = chosen.label || chosen.value || chosen.role
    console.log(
      `  ${chalk.green("→")} ${chalk.bold(name)} ` +
      chalk.dim(`(${chosen.role.replace(/^AX/, "")}, confidence ${sel.confidence.toFixed(2)}, P(exists) ${sel.present.toFixed(2)})`),
    )
    await run(HELPER, [
      "point",
      "--x", String(chosen.x), "--y", String(chosen.y),
      "--w", String(chosen.width), "--h", String(chosen.height),
      "--label", name,
    ])
  })

function tryError(stdout: string): string {
  try { return JSON.parse(stdout).error ?? stdout } catch { return stdout }
}
