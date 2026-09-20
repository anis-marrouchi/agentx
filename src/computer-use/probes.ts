import { execFile } from "child_process"
import { promisify } from "util"

const run = promisify(execFile)

// Cheap, deterministic facts about the machine, to be weighed against what
// a model thinks it saw.
//
// This exists because of a measured failure. Asked whether the screen was
// being recorded, a vision model looked at a menu bar, found an ordinary
// circular app icon and reported it as "the macOS screen recording
// indicator" — twice, in different words, with evidence that read as
// specific and was invented. The decision seat then agreed at 76%, because
// the seat is blind: it only ever sees the OBSERVATION, so a confident
// wrong description is indistinguishable to it from a confident right one.
//
// No prompt fixes that. The observation is the only evidence in play, so
// something else has to be in play.
//
// A probe is a fact obtained by asking the system instead of looking at
// it: a process list, a file's size, a window's existence. It is narrow
// and it is certain, which is exactly the counterweight a confident
// narrative needs. Where it cannot settle something, it says so — and that
// admission is itself evidence, because it tells the seat the question is
// not answerable from this capture rather than leaving it to infer
// otherwise.

export interface Probe {
  /** What was checked, in plain words. */
  checked: string
  /** What came back. */
  found: string
}

/** Processes whose mere existence proves a capture is under way.
 *
 *  `screencapture -v` exists only while it is recording, so finding it is
 *  the whole answer. Kept separate from the apps below, because that
 *  distinction is the difference between evidence and a hint — an earlier
 *  cut lumped them together and also listed ffmpeg, which is running on
 *  this machine for unrelated transcoding and would have "proved" a
 *  recording that was not happening. */
const CAPTURING_WHEN_RUNNING = ["screencapture"]

/** Apps that RECORD but are also just left open. Their presence settles
 *  nothing, and saying so is the point — this is the Screen Studio case. */
const MIGHT_BE_RECORDING = ["Screen Studio", "OBS", "QuickTime Player", "Zoom"]

/**
 * Deterministic facts relevant to `claim`, or an empty list when none apply.
 *
 * Keyword-triggered on purpose. A probe that ran for every claim would be
 * mostly noise in the state, and a seat reading irrelevant facts is a seat
 * being taught that facts are irrelevant.
 */
export async function probe(claim: string): Promise<Probe[]> {
  const text = claim.toLowerCase()
  const probes: Probe[] = []

  if (/record|recording|capturing|screen ?capture|screencast/.test(text)) {
    probes.push(await recordingProbe())
  }
  return probes
}

/**
 * Whether anything visible from here is capturing the screen.
 *
 * Three outcomes, and they are deliberately worded very differently,
 * because an earlier version used one hedging paragraph for all of them.
 * It buried a decisive finding — a live capture process — under a caveat
 * about what the check cannot see, and the seat read the caveat and
 * answered "cannot tell" while the answer was sitting in the same string.
 * A qualification attached to a fact that does not need it is not caution,
 * it is noise that outweighs the fact.
 */
async function recordingProbe(): Promise<Probe> {
  const capturing = await running(CAPTURING_WHEN_RUNNING)
  if (capturing.length) {
    return {
      checked: "running screen-capture processes (pgrep)",
      found:
        `A screen capture is definitely in progress: ${capturing.join(", ")}. ` +
        `This process only exists while it is recording, so this settles the question on its own.`,
    }
  }

  const maybe = await running(MIGHT_BE_RECORDING)
  if (maybe.length) {
    return {
      checked: "running screen-capture processes (pgrep)",
      found:
        `No standalone capture process. A recorder application IS open (${maybe.join(", ")}), but ` +
        `its process exists whether or not it is recording, so this neither confirms nor denies. ` +
        `macOS does not expose in-app recording state to this tool, and the menu bar indicator is ` +
        `about six points — measured as below what the vision models here resolve reliably. ` +
        `Unless something else settles it, this claim cannot be verified.`,
    }
  }

  return {
    checked: "running screen-capture processes (pgrep)",
    found:
      `No screen-capture process is running and no recorder application is open. Nothing that ` +
      `records the screen from outside an app is active.`,
  }
}

/** pgrep exits non-zero when nothing matches, which is an answer, not an error. */
async function running(names: string[]): Promise<string[]> {
  const found: string[] = []
  for (const name of names) {
    try {
      const { stdout } = await run("pgrep", ["-x", name])
      const pid = stdout.trim().split("\n")[0]
      if (pid) found.push(`${name} (pid ${pid})`)
    } catch {
      /* not running */
    }
  }
  return found
}
