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
import { HELPER, readScreen, rectFor } from "@/computer-use/screen"
import { daemon } from "@/commands/call"
import { GUIDE_HOLD, GUIDE_MARKS } from "@/voice/guide"

const run = promisify(execFile)

// --- `agentx point "<what you mean>"` ---
//
// Reads the focused window's accessibility tree, asks the ui-element seat
// which control the request names, and moves the cursor there with a
// highlight. It does NOT click. With the character on screen (`voice.look`
// "character", AgentX Voice running) the character goes there and marks
// it instead (#482), and the person's cursor stays where it is.
//
// This lives in agentx rather than inside the voice widget on purpose: the
// capability then belongs to every agent — the secretary by voice, devops
// over WhatsApp, a cron job — instead of to one app. Swift owns only the
// parts Node cannot reach.



interface Snapshot {
  app: string
  window?: string | null
  elements: Array<UICandidate & { x: number; y: number; width: number; height: number }>
  truncated: boolean
  note?: string | null
}

type ScreenRect = { x: number; y: number; width: number; height: number }

/** Show `rect`: the character when it is on screen, else the cursor. */
async function show(rect: ScreenRect, label: string, opts: { mark: string; hold?: string; text?: string }): Promise<void> {
  const shown = await daemon("POST", "/voice/guide", {
    rect, mark: opts.mark, ...(opts.hold ? { hold: Number(opts.hold) } : {}), ...(opts.text ? { text: opts.text } : {}),
  })
    .then((r) => r?.shown === true, () => false)
  if (shown) return
  await run(HELPER, ["point", "--x", String(rect.x), "--y", String(rect.y),
                     "--w", String(rect.width), "--h", String(rect.height), "--label", label])
}

export const point = new Command()
  .name("point")
  .description("point at the on-screen control matching a description (does not click)")
  .argument("<request>", 'what you mean, e.g. "the send button"')
  .option("--max <n>", "candidates to consider", "40")
  .option("--json", "emit the decision as JSON instead of pointing")
  .option("--min-present <p>", "refuse below this P(control exists)", "0.5")
  .option("--mark <kind>", `how the character marks it: ${GUIDE_MARKS.join(", ")}`, "box")
  .option("--hold <seconds>", "how long the character stays there (8 by default)")
  .option("--text <words>", "what the character's bubble says there (no bubble without it)")
  .action(async (request: string, opts) => {
    if (!(GUIDE_MARKS as readonly string[]).includes(opts.mark)) {
      console.log(chalk.red(`  --mark is one of: ${GUIDE_MARKS.join(", ")}`))
      process.exit(1)
    }
    if (opts.hold !== undefined && !(Number(opts.hold) > 0 && Number(opts.hold) <= GUIDE_HOLD.max)) {
      console.log(chalk.red(`  --hold is a number of seconds, up to ${GUIDE_HOLD.max}`))
      process.exit(1)
    }
    if (!existsSync(HELPER)) {
      console.log(chalk.red(`  helper not built — run apps/mac-helper/build.sh`))
      process.exit(1)
    }

    let screen
    try {
      // Reads the accessibility tree, and falls back to local OCR when the
      // tree is too thin to choose from — which is the only thing that
      // makes Electron apps addressable at all.
      screen = await readScreen({ max: Number(opts.max) || 40 })
    } catch (e: any) {
      console.log(chalk.red(`  could not read the screen: ${e?.message ?? e}`))
      process.exit(1)
    }
    const candidates = screen.candidates

    if (candidates.length === 0) {
      console.log(chalk.yellow(`  ${screen.app} exposes no usable controls and no readable text`))
      process.exit(2)
    }
    if (candidates.length === 1) {
      const only = rectFor(screen, candidates[0].id)
      if (only) {
        console.log(chalk.yellow(`  ${screen.app} exposes exactly one target — pointing at it: `) +
                    chalk.bold(candidates[0].label))
        await show(only, candidates[0].label, opts)
      }
      return
    }

    const result = await askSeat(
      UI_ELEMENT_SEAT,
      uiElementState({ request, app: screen.app, window: screen.window, candidates }),
      uiElementQuestions(candidates),
      { features: { app: screen.app, candidates: candidates.length, ocr: screen.usedOCR } },
    )
    if (!result) {
      console.log(chalk.red(`  the ui-element seat is unavailable — set decisions.seats.${UI_ELEMENT_SEAT}.mode`))
      process.exit(1)
    }

    const sel = toSelection(result.answers as UIElementAnswers, candidates)
    const chosen = rectFor(screen, sel.id)
    const chosenLabel = candidates.find((c) => c.id === sel.id)?.label ?? ""
    const fromOCR = screen.ocrRects.has(sel.id)

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
        app: screen.app, request, chosen: { ...chosen, label: chosenLabel, fromOCR }, present: sel.present,
        confidence: sel.confidence,
        ranked: sel.ranked.slice(0, 5).map((r) => ({
          ...r, label: candidates.find((c) => c.id === r.id)?.label,
        })),
      }, null, 2))
      return
    }

    const name = chosenLabel
    console.log(
      `  ${chalk.green("→")} ${chalk.bold(name)} ` +
      chalk.dim(`(${fromOCR ? "read from screen" : "control"}, confidence ${sel.confidence.toFixed(2)}, P(exists) ${sel.present.toFixed(2)})`),
    )
    await show(chosen, name, opts)
  })

function tryError(stdout: string): string {
  try { return JSON.parse(stdout).error ?? stdout } catch { return stdout }
}
