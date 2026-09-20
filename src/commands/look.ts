import { Command } from "commander"
import chalk from "chalk"
import { look as lookAtScreen, type Region } from "@/computer-use/look"
import { verify } from "@/computer-use/verify"

// --- `agentx look "<what you want to know>"` ---
//
// The third sense, next to `read` (the accessibility tree) and the OCR
// fallback inside `point`. Use it for what the other two cannot answer:
// whether something is covering something else, whether a page has
// finished loading, whether a toggle is on, whether an action visibly
// happened.
//
// Two modes, and the difference is whether a judgement is wanted:
//
//   agentx look "is the compose box covering the timeline?"
//       -> reports what is visible.
//
//   agentx look --verify "a recording is in progress"
//       -> takes a CLAIM and answers confirmed / refuted / unknown,
//          exiting non-zero for the last two so a script can rely on it.
//
// Exit codes are the contract: 0 confirmed, 3 refuted, 4 unknown. `unknown`
// is deliberately not 0. This whole path exists because a run once reported
// success for a recording that never started, and the way that happened was
// treating "could not tell" as "fine".

export const look = new Command()
  .name("look")
  .description("look at the screen with a vision model — for state the tree and OCR cannot see")
  .argument("<question>", 'what you want to know, e.g. "is a dialog covering the page?"')
  .option("--verify", "treat the argument as a claim and judge it (exit 3 refuted, 4 unknown)")
  .option("--menubar", "capture the menu bar instead of the focused window")
  .option("--screen", "capture the whole screen instead of the focused window")
  .option("--rect <x,y,w,h>", "capture an explicit region")
  .option("--model <id>", "vision model to use")
  .option("--json", "emit the result as JSON")
  .action(async (question: string, opts) => {
    let region: Region = { kind: "window" }
    if (opts.menubar) region = { kind: "menubar" }
    else if (opts.screen) region = { kind: "screen" }
    else if (opts.rect) {
      const parts = String(opts.rect).split(",").map(Number)
      if (parts.length !== 4 || parts.some(Number.isNaN)) {
        console.log(chalk.red("  --rect wants x,y,w,h"))
        process.exit(1)
      }
      region = { kind: "rect", x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
    }

    try {
      if (opts.verify) {
        const v = await verify(question, { region, model: opts.model })
        if (opts.json) {
          console.log(JSON.stringify({
            claim: v.claim, outcome: v.outcome, ok: v.ok,
            observable: v.observable, holds: v.holds, calibrated: v.calibrated,
            reason: v.reason, evidence: v.sighting.evidence, probes: v.probes,
            observation: v.sighting.observation, shot: v.sighting.shot.path,
            model: v.sighting.model, latencyMs: v.sighting.latencyMs,
          }, null, 2))
        } else {
          const mark = v.outcome === "confirmed" ? chalk.green("✓")
            : v.outcome === "refuted" ? chalk.red("✗")
            : chalk.yellow("?")
          console.log(`  ${mark} ${chalk.bold(v.claim)}`)
          console.log(`    ${v.reason}`)
          if (!v.calibrated) {
            console.log(chalk.dim(`    (screen-state seat off — set AGENTX_DECISION_SEAT_SCREEN_STATE=active)`))
          }
          console.log(chalk.dim(`    ${v.sighting.model} · ${v.sighting.latencyMs}ms · ${v.sighting.shot.path}`))
        }
        process.exit(v.outcome === "confirmed" ? 0 : v.outcome === "refuted" ? 3 : 4)
      }

      const s = await lookAtScreen(question, { region, model: opts.model })
      if (opts.json) {
        console.log(JSON.stringify(s, null, 2))
        return
      }
      console.log(`  ${chalk.bold(s.observation)}`)
      if (s.evidence) console.log(chalk.dim(`    evidence: ${s.evidence}`))
      console.log(`    reading: ${readingColour(s.reading)}`)
      console.log(chalk.dim(
        `    ${s.model} · ${s.latencyMs}ms · ${Math.round(s.shot.bytes / 1024)}KB · ${s.shot.path}`,
      ))
    } catch (e: any) {
      console.log(chalk.red(`  ${e?.message ?? e}`))
      process.exit(1)
    }
  })

function readingColour(r: string): string {
  if (r === "yes") return chalk.green(r)
  if (r === "no") return chalk.red(r)
  return chalk.yellow(r)
}
