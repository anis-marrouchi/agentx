import { Command } from "commander"
import chalk from "chalk"
import { daemon } from "@/commands/call"
import { GUIDE_EXPRESSIONS, GUIDE_HOLD } from "@/voice/guide"

// --- `agentx express <name>` (#570) ---
//
// Has the character show one of its nine states where it rests, for a
// number of seconds, then its real state again. For a recorded demo, or
// an agent that wants to be seen listening or speaking. To show a state
// at something on screen, use `agentx point --expression <name>`.
//
// Someone who starts talking, a ringing call and a call between turns
// still show: the real turn comes first.

export const express = new Command()
  .name("express")
  .description(`have the character show one of its states for a few seconds: ${GUIDE_EXPRESSIONS.join(", ")}`)
  .argument("<name>", `the state: ${GUIDE_EXPRESSIONS.join(", ")}`)
  .option("--hold <seconds>", `how long it shows it (${GUIDE_HOLD.default} by default)`)
  .action(async (name: string, opts) => {
    if (!(GUIDE_EXPRESSIONS as readonly string[]).includes(name)) {
      console.log(chalk.red(`  the state is one of: ${GUIDE_EXPRESSIONS.join(", ")}`))
      process.exit(1)
    }
    if (opts.hold !== undefined && !(Number(opts.hold) > 0 && Number(opts.hold) <= GUIDE_HOLD.max)) {
      console.log(chalk.red(`  --hold is a number of seconds, up to ${GUIDE_HOLD.max}`))
      process.exit(1)
    }
    try {
      await daemon("POST", "/voice/guide", { expression: name, ...(opts.hold ? { hold: Number(opts.hold) } : {}) })
      console.log(`  ${chalk.green("→")} ${chalk.bold(name)} ${chalk.dim(`for ${opts.hold ?? GUIDE_HOLD.default} seconds`)}`)
    } catch (e: any) {
      console.log(chalk.red(`  ${e?.message ?? e}`))
      process.exit(1)
    }
  })
