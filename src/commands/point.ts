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
import { HELPER, readScreen, rectFor, type ScreenRead } from "@/computer-use/screen"
import { buildCandidates } from "@/computer-use/candidates"
import { daemon } from "@/commands/call"
import { GUIDE_EXPRESSIONS, GUIDE_HOLD, GUIDE_MARKS } from "@/voice/guide"

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

/**
 * Who holds the floor when it is not this command's, else null. The holder
 * itself (`AGENTX_FLOOR` still answered 200) gets the cursor when no
 * character is on screen: the floor is its turn, not a ban (#924).
 */
export async function floorHeldByOther(
  call: typeof daemon = daemon,
  own: string | undefined = process.env.AGENTX_FLOOR,
): Promise<string | null> {
  const floor = await call("GET", "/voice/floor").catch(() => null)
  if (!floor?.held) return null
  if (own && await call("GET", `/voice/floor/${own}`).then(() => true, () => false)) return null
  return floor.holder ?? "someone"
}

/** Show `rect`: the character when it is on screen, else the cursor. */
async function show(rect: ScreenRect, label: string, opts: { mark: string; hold?: string; text?: string; expression?: string }): Promise<void> {
  const shown = await daemon("POST", "/voice/guide", {
    rect, mark: opts.mark, ...(opts.hold ? { hold: Number(opts.hold) } : {}), ...(opts.text ? { text: opts.text } : {}),
    ...(opts.expression ? { expression: opts.expression } : {}),
    // Inside `agentx voice floor run`, the character obeys this command.
    ...(process.env.AGENTX_FLOOR ? { floor: process.env.AGENTX_FLOOR } : {}),
  })
    .then((r) => r?.shown === true, () => false)
  if (shown) return
  // Someone else holds the floor: the cursor would draw over them too (#924).
  const other = await floorHeldByOther()
  if (other) {
    console.log(chalk.yellow(`  the floor is held by ${other}: nothing is pointed at until it is free`))
    process.exit(3)
  }
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
  .option("--expression <name>", `the state the character shows there: ${GUIDE_EXPRESSIONS.join(", ")}`)
  .action(async (request: string, opts) => {
    if (!(GUIDE_MARKS as readonly string[]).includes(opts.mark)) {
      console.log(chalk.red(`  --mark is one of: ${GUIDE_MARKS.join(", ")}`))
      process.exit(1)
    }
    if (opts.expression !== undefined && !(GUIDE_EXPRESSIONS as readonly string[]).includes(opts.expression)) {
      console.log(chalk.red(`  --expression is one of: ${GUIDE_EXPRESSIONS.join(", ")}`))
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

    let screen: ScreenRead
    try {
      // Reads the accessibility tree, and falls back to local OCR when the
      // tree is too thin to choose from — which is the only thing that
      // makes Electron apps addressable at all.
      screen = await readScreen({ max: Number(opts.max) || 40, request })
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

    const ask = (offered: UICandidate[]) => askSeat(
      UI_ELEMENT_SEAT,
      uiElementState({ request, app: screen.app, window: screen.window, candidates: offered }),
      uiElementQuestions(offered),
      { features: { app: screen.app, candidates: offered.length, ocr: screen.usedOCR } },
    )
    const result = await ask(candidates)
    if (!result) {
      console.log(chalk.red(`  the ui-element seat is unavailable — set decisions.seats.${UI_ELEMENT_SEAT}.mode`))
      process.exit(1)
    }

    // `present` is read BEFORE `target`, always. A Choice over a candidate
    // set will always name something; this is the question that can say
    // the thing simply is not on screen.
    const minPresent = Number(opts.minPresent) || 0.5
    let offered = candidates
    let sel = toSelection(result.answers as UIElementAnswers, candidates)

    // Second look, at the browser this time (#1092). The page had no match
    // and the chrome was held back, so the thing asked for may well be the
    // browser's own: its reload, its star, a tab's close button. Asked
    // separately rather than mixed into the first set (unless the request
    // named the browser) — mixed in, Chrome's address bar wins "the search
    // box" on a page that has one.
    if (sel.present < minPresent && !candidates.some((c) => c.area === "browser")) {
      const chrome = buildCandidates(screen.elements, Number(opts.max) || 40, { request, scope: "browser" })
      // A choice needs two options; one lone browser control is no evidence.
      const second = chrome.length >= 2 ? await ask(chrome) : null
      const again = second ? toSelection(second.answers as UIElementAnswers, chrome) : null
      if (again && again.present >= minPresent) { offered = chrome; sel = again }
    }

    const chosen = rectFor(screen, sel.id)
    const chosenLabel = offered.find((c) => c.id === sel.id)?.label ?? ""
    const inBrowser = offered.find((c) => c.id === sel.id)?.area === "browser"
    const fromOCR = screen.ocrRects.has(sel.id)

    if (sel.present < minPresent || !chosen) {
      console.log(
        chalk.yellow(`  nothing on screen matches "${request}"`) +
        chalk.dim(` (P(exists)=${sel.present.toFixed(2)} below ${minPresent})`),
      )
      process.exit(2)
    }

    if (opts.json) {
      console.log(JSON.stringify({
        app: screen.app, request, chosen: { ...chosen, label: chosenLabel, fromOCR, inBrowser }, present: sel.present,
        confidence: sel.confidence,
        ranked: sel.ranked.slice(0, 5).map((r) => ({
          ...r, label: offered.find((c) => c.id === r.id)?.label,
        })),
      }, null, 2))
      return
    }

    const name = chosenLabel
    console.log(
      `  ${chalk.green("→")} ${chalk.bold(name)} ` +
      chalk.dim(`(${fromOCR ? "read from screen" : inBrowser ? "browser control" : "control"}, confidence ${sel.confidence.toFixed(2)}, P(exists) ${sel.present.toFixed(2)})`),
    )
    await show(chosen, name, opts)
  })

function tryError(stdout: string): string {
  try { return JSON.parse(stdout).error ?? stdout } catch { return stdout }
}
