import { execFile } from "child_process"
import { soundPath } from "@/notify/local"
import { draftFor } from "./choices"
import { showCardWindow } from "./card-window"
import type { DecisionCard } from "./cards"

// --- The Mac popup: answer a decision card in one click ---
//
// A soft sound, one short spoken line, then the card: a small web window
// (card-window.ts, style "card", the default) or native dialogs (style
// "dialog", and the fallback when the window can't open):
//
//   card with choices   a list to pick from, then (with a draft) the
//                       suggested message in an editable box: Send or Cancel
//   card with a draft   the message in an editable box: Send, No or Not now
//   plain card          the question: Yes, No or Not now
//
// The dialogs are plain osascript, like `agentx notify`'s fallback banner. Every
// piece of card text travels as argv, never spliced into the script, so a
// quote in a title cannot turn into AppleScript.
//
// Nothing here decides or sends. It returns what the operator clicked; the
// runner records it through decideCard, and the agent that raised the card
// does the sending when it hears the result.

export type PopupAnswer =
  | { action: "yes"; choice?: string; text?: string }
  | { action: "no" }
  /** Not now, Cancel, closed, or no answer in time: the card keeps waiting. */
  | { action: "dismiss" }

export interface PopupSettings {
  /** "card": the web card window; "dialog": native dialogs. Default "card". */
  style?: "card" | "dialog"
  /** The card's colours. Default: follow the system. */
  theme?: "system" | "light" | "dark"
  /** Speak `say` (or the title) aloud. */
  speak: boolean
  /** A macOS voice for `say -v`. Unset: the system voice. */
  voice?: string
  /** "chime" (a soft chime, played by the card), a system sound name, or "" for none. */
  sound: string
  volume: number
  /** How long the popup stays up before it gives up. */
  timeoutSeconds: number
}

export interface RunResult { ok: boolean; stdout: string }
export type Run = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>

const run: Run = (file, args, timeoutMs) =>
  new Promise((done) => {
    try {
      execFile(file, args, { timeout: timeoutMs }, (err, stdout) => done({ ok: !err, stdout: String(stdout ?? "") }))
    } catch {
      done({ ok: false, stdout: "" })
    }
  })

/** Spoken lines are short; a long one is cut rather than read for a minute. */
const SAY_MAX = 160
/** Sound and speech must not hold the dialog back. */
const CUE_TIMEOUT_MS = 15_000

export function spokenLine(card: Pick<DecisionCard, "say" | "title">): string {
  const line = (card.say || card.title).replace(/\s+/g, " ").trim()
  return line.length > SAY_MAX ? line.slice(0, SAY_MAX) : line
}

/** The sound, then the spoken line. Never fatal. The card window plays
 *  "chime" itself; the dialogs have no chime, so they get Glass. */
async function cue(card: DecisionCard, s: PopupSettings, exec: Run, inCard: boolean): Promise<void> {
  const name = s.sound === "chime" ? (inCard ? "" : "Glass") : s.sound
  const path = name ? soundPath(name) : null
  if (path) await exec("/usr/bin/afplay", ["-v", String(Math.min(1, Math.max(0, s.volume))), path], CUE_TIMEOUT_MS)
  if (s.speak) {
    const voice = s.voice && /^[\w .()-]+$/.test(s.voice) ? ["-v", s.voice] : []
    await exec("/usr/bin/say", [...voice, "--", spokenLine(card)], CUE_TIMEOUT_MS)
  }
}

function osa(lines: string[], args: string[]): string[] {
  return [...lines.flatMap((l) => ["-e", l]), ...args]
}

/** argv: title, prompt, then the choices. Prints the pick, or nothing. */
export function chooseArgs(title: string, prompt: string, choices: string[]): string[] {
  return osa([
    "on run argv",
    "activate",
    "set opts to items 3 thru -1 of argv",
    "set pick to choose from list opts with title (item 1 of argv) with prompt (item 2 of argv) OK button name \"Next\" cancel button name \"Not now\"",
    "if pick is false then return \"\"",
    "return item 1 of pick",
    "end run",
  ], [title, prompt, ...choices])
}

/**
 * argv: title, prompt, buttons (joined by newlines), default button,
 * seconds, and the editable text ("" for none). Prints
 * "<button>\n<text>", or "" when it gave up.
 */
export function dialogArgs(title: string, prompt: string, buttons: string[], seconds: number, text?: string): string[] {
  return osa([
    "on run argv",
    "activate",
    "set AppleScript's text item delimiters to linefeed",
    "set btns to text items of (item 3 of argv)",
    "set secs to (item 5 of argv) as integer",
    "if (count of argv) > 5 then",
    "set r to display dialog (item 2 of argv) with title (item 1 of argv) default answer (item 6 of argv) buttons btns default button (item 4 of argv) giving up after secs",
    "else",
    "set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons btns default button (item 4 of argv) giving up after secs",
    "end if",
    "if gave up of r then return \"\"",
    "if (count of argv) > 5 then return (button returned of r) & linefeed & (text returned of r)",
    "return button returned of r",
    "end run",
  ], [title, prompt, buttons.join("\n"), buttons[buttons.length - 1], String(seconds), ...(text !== undefined ? [text] : [])])
}

/** "<button>\n<text…>" → the button and the text (which may span lines). */
export function parseDialog(stdout: string): { button: string; text: string } | null {
  const out = stdout.replace(/\n$/, "")
  if (!out) return null
  const i = out.indexOf("\n")
  return i < 0 ? { button: out, text: "" } : { button: out.slice(0, i), text: out.slice(i + 1) }
}

function promptFor(card: DecisionCard): string {
  return [card.ask, card.recommend ? `Recommended: ${card.recommend}` : "", `From ${card.raised_by}`].filter(Boolean).join("\n\n")
}

export interface ShowOptions {
  run?: Run
  /** The agent's display name, e.g. "Sam". */
  from?: string
  /** Docs and tests: save a PNG of the card window. */
  capture?: string
  /** Previews: start with this option (1-based) picked. */
  pick?: number
}

/** Show one card and return what the operator did. */
export async function showPopup(card: DecisionCard, settings: PopupSettings, deps: ShowOptions = {}): Promise<PopupAnswer> {
  const exec = deps.run ?? run
  const inCard = (settings.style ?? "card") === "card"
  // The spoken line runs beside the window, so the card is on screen while it speaks.
  const spoken = cue(card, settings, exec, inCard).catch(() => undefined)
  if (inCard) {
    const answer = await showCardWindow(card, {
      timeoutSeconds: settings.timeoutSeconds, sound: settings.sound, volume: settings.volume,
      theme: settings.theme, from: deps.from, capture: deps.capture, pick: deps.pick,
    }, exec).catch(() => null)
    if (answer) return answer
  }
  await spoken
  return showDialogs(card, settings, exec)
}

async function showDialogs(card: DecisionCard, settings: PopupSettings, exec: Run): Promise<PopupAnswer> {
  const seconds = Math.max(10, Math.round(settings.timeoutSeconds))
  // A little past giving-up, so osascript can close its own dialog first.
  const limit = (seconds + 5) * 1000
  const title = `${card.raised_by}: ${card.title}`

  let choice: string | undefined
  if (card.choices?.length) {
    const r = await exec("/usr/bin/osascript", chooseArgs(title, promptFor(card), card.choices), limit)
    choice = r.stdout.replace(/\n$/, "")
    if (!r.ok || !card.choices.includes(choice)) return { action: "dismiss" }
    if (!card.draft) return { action: "yes", choice }
  }

  if (card.draft) {
    const prompt = choice ? `${choice}\n\nMessage (edit it if you like):` : `${promptFor(card)}\n\nMessage (edit it if you like):`
    const buttons = choice ? ["Cancel", "Send"] : ["Not now", "No", "Send"]
    const r = await exec("/usr/bin/osascript", dialogArgs(title, prompt, buttons, seconds, draftFor(card.draft, choice)), limit)
    const d = r.ok ? parseDialog(r.stdout) : null
    if (d?.button === "Send") {
      const text = d.text.trim()
      // An emptied box is not an approval of nothing.
      if (!text) return { action: "dismiss" }
      return { action: "yes", ...(choice ? { choice } : {}), text }
    }
    if (d?.button === "No") return { action: "no" }
    return { action: "dismiss" }
  }

  const r = await exec("/usr/bin/osascript", dialogArgs(title, promptFor(card), ["Not now", "No", "Yes"], seconds), limit)
  const d = r.ok ? parseDialog(r.stdout) : null
  if (d?.button === "Yes") return { action: "yes" }
  if (d?.button === "No") return { action: "no" }
  return { action: "dismiss" }
}
