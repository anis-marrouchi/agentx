import { Command } from "commander"
import { execFile } from "child_process"
import { promisify } from "util"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"
import chalk from "chalk"
import { askSeat } from "@/decisions/seat"
import {
  PASTE_TRANSFORM_SEAT,
  pasteQuestions,
  pasteState,
  toPasteChoice,
  type PasteAnswers,
} from "@/decisions/seats/paste-transform"
import { applicable, previewFor, looksSecret, TRANSFORMS } from "@/clipboard/transforms"
import { HELPER } from "@/computer-use/screen"

const run = promisify(execFile)

// --- `agentx paste` — put the clipboard in the shape the destination wants ---
//
// Reads the clipboard, sees where the caret is, asks the paste-transform
// seat which shape fits, and applies a DETERMINISTIC transform. No model
// writes any of the text that lands.
//
// Three orderings that are load bearing:
//
//   1. The secret check runs in code, before anything is sent anywhere.
//      The clipboard is where passwords and tokens live for the seconds
//      between copy and paste. "Do not mangle my password" is not a
//      judgement to delegate, and a preview of one should not leave the
//      machine to ask.
//   2. `worthChanging` is read before `shape`. A Choice always returns
//      something; the Noul is what can say "paste it exactly as copied",
//      which is the right answer most of the time.
//   3. The original is printed whenever it is replaced, so a surprising
//      transform is recoverable without an undo stack.
//
// Default is a dry run. Nothing touches the clipboard without --apply.

export const paste = new Command()
  .name("paste")
  .description("reshape the clipboard to fit where it is being pasted")
  .option("--apply", "write the result back to the clipboard")
  .option("--paste", "apply, then press cmd-V into the focused control")
  .option("--as <id>", `force a transform (${TRANSFORMS.map((t) => t.id).join(", ")})`)
  // 0.45 sits between the measured cases: a shell command scored 0.07 and
  // the four shapes this exists for scored 0.47-0.50. Provisional, from
  // five samples on one machine — it is a policy knob, not a calibrated
  // number, and `agentx decisions recalibrate` is what would replace it.
  // A wrong call is cheap because the original is stashed; see --undo.
  .option("--min <p>", "minimum P(worth changing) before transforming", "0.45")
  .option("--undo", "restore the clipboard as it was before the last apply")
  .option("--json", "emit the decision as JSON")
  .action(async (opts) => {
    if (opts.undo) {
      const previous = takeStash()
      if (previous === null) {
        console.log(chalk.yellow("  nothing to undo"))
        process.exit(2)
      }
      await writeClipboard(previous)
      console.log(`  ${chalk.green("→")} clipboard restored`)
      return
    }

    const text = await readClipboard()
    if (!text) {
      console.log(chalk.yellow("  clipboard is empty"))
      process.exit(2)
    }

    // Before anything else, and before any preview leaves this process.
    if (looksSecret(text)) {
      report(opts, {
        applied: "asIs", reason: "looks like a credential — left untouched", worthChanging: 0,
      })
      return
    }

    const options = applicable(text)
    const destination = await focusedDestination()

    if (opts.as) {
      const forced = options.find((o) => o.transform.id === opts.as)
      if (!forced) {
        console.log(chalk.red(`  "${opts.as}" does not apply to this clipboard`))
        console.log(chalk.dim(`  available: ${options.map((o) => o.transform.id).join(", ")}`))
        process.exit(1)
      }
      await finish(opts, forced.transform.id, forced.result, text, "forced", 1)
      return
    }

    // Only asIs applies: there is nothing to decide.
    if (options.length < 2) {
      await finish(opts, "asIs", text, text, "nothing else applies", 0)
      return
    }

    const result = await askSeat(
      PASTE_TRANSFORM_SEAT,
      pasteState({
        preview: previewFor(text),
        length: text.length,
        lineCount: text.split("\n").length,
        app: destination.app,
        destination: destination.role,
        destinationLabel: destination.label,
      }),
      pasteQuestions(options.map((o) => o.transform)),
      {
        // Without the seat this command pastes unchanged, which is also
        // the incumbent it has to beat.
        incumbent: { shape: "asIs" },
        features: { app: destination.app, options: options.length, chars: text.length },
      },
    )

    if (!result) {
      await finish(opts, "asIs", text, text, `seat unavailable — set decisions.seats.${PASTE_TRANSFORM_SEAT}.mode`, 0)
      return
    }

    const chosen = toPasteChoice(result.answers as PasteAnswers)
    const min = Number(opts.min) || 0.6
    if (chosen.worthChanging < min) {
      await finish(opts, "asIs", text, text,
        `paste as copied (P(worth changing) ${chosen.worthChanging.toFixed(2)} below ${min})`,
        chosen.worthChanging)
      return
    }

    const picked = options.find((o) => o.transform.id === chosen.id)
    if (!picked) {
      // The seat named something outside the option set. Refuse rather
      // than guess — a transform nobody offered is not a transform.
      await finish(opts, "asIs", text, text, `seat chose "${chosen.id}", which was not offered`, chosen.worthChanging)
      return
    }
    await finish(opts, picked.transform.id, picked.result, text,
      `${picked.transform.label} (confidence ${chosen.confidence.toFixed(2)})`,
      chosen.worthChanging)
  })

async function finish(
  opts: any, id: string, result: string, original: string, reason: string, worth: number,
) {
  const changed = result !== original
  if (changed && (opts.apply || opts.paste)) {
    // Stash BEFORE overwriting. This command is the only thing that will
    // take the original away, so it is the only thing that can hand it
    // back — and being able to hand it back is what makes a lower
    // threshold defensible.
    stash(original)
    await writeClipboard(result)
  }

  report(opts, { applied: id, reason, worthChanging: worth, result, original, changed })

  if (opts.paste) {
    // Into whatever has focus. The helper's own gate still applies.
    await run(HELPER, ["key", "--name", "v", "--mod", "command"]).catch((e: any) => {
      console.log(chalk.red(`  could not paste: ${e?.message ?? e}`))
    })
  }
}

function report(opts: any, r: any) {
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  if (!r.changed) {
    console.log(`  ${chalk.dim("→")} ${chalk.bold("unchanged")} ${chalk.dim(`· ${r.reason}`)}`)
    return
  }
  console.log(`  ${chalk.green("→")} ${chalk.bold(r.applied)} ${chalk.dim(`· ${r.reason}`)}`)
  console.log(chalk.dim("  ─── before ───"))
  console.log(chalk.dim(clip(r.original)))
  console.log(chalk.dim("  ─── after ────"))
  console.log(clip(r.result))
  if (!opts.apply && !opts.paste) console.log(chalk.dim("\n  (dry run — pass --apply to write it back)"))
}

const clip = (s: string, max = 400) =>
  (s.length > max ? `${s.slice(0, max)}…` : s).split("\n").map((l) => `  ${l}`).join("\n")

/** Where the pre-transform clipboard is kept, for exactly one undo. */
const STASH = join(homedir(), ".agentx", "paste-undo.txt")

function stash(text: string): void {
  try {
    mkdirSync(dirname(STASH), { recursive: true })
    writeFileSync(STASH, text, { mode: 0o600 })
  } catch {
    /* an undo that cannot be saved must not fail the paste */
  }
}

/** Reads and clears: an undo restores one step, not a history. */
function takeStash(): string | null {
  try {
    const text = readFileSync(STASH, "utf-8")
    writeFileSync(STASH, "", { mode: 0o600 })
    return text.length ? text : null
  } catch {
    return null
  }
}

async function readClipboard(): Promise<string> {
  const { stdout } = await run("pbpaste", [], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function writeClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("pbcopy", [], (err) => (err ? reject(err) : resolve()))
    child.stdin?.end(text)
  })
}

/** Where the caret is. Unknown is a fine answer — it just makes the
 *  destination carry less weight in the decision. */
async function focusedDestination(): Promise<{ app: string; role: string; label: string | null }> {
  if (!existsSync(HELPER)) return { app: "unknown", role: "an unknown control", label: null }
  try {
    const { stdout } = await run(HELPER, ["focused"])
    const f = JSON.parse(stdout) as {
      ok?: boolean; app?: string; role?: string; label?: string; editable?: boolean
    }
    // "nothing focused" is a successful answer to a different question.
    if (f.ok === false || !f.role) return { app: "unknown", role: "an unknown control", label: null }
    return {
      app: f.app ?? "unknown",
      role: humanRole(f.role ?? "", f.editable),
      label: f.label || null,
    }
  } catch {
    return { app: "unknown", role: "an unknown control", label: null }
  }
}

function humanRole(role: string, editable?: boolean): string {
  const map: Record<string, string> = {
    AXTextField: "a single-line text field",
    AXTextArea: "a multi-line text area",
    AXSearchField: "a search field",
    AXComboBox: "a combo box",
    AXSecureTextField: "a password field",
  }
  return map[role] ?? (editable ? "an editable control" : `a ${role || "unknown"} control`)
}
