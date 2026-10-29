// --- Prompt schedules that run a shell command (#1540) ---
//
// A prompt job's run counts as a success when the agent run itself did not
// error. When the prompt tells the agent to run a command, a command that
// fails is only reported in the answer's text, so the run was recorded as a
// success. A job with `expectExitZero` asks the agent to end its answer with
// the command's exit code, and the run fails when that line is missing or
// not 0. Shell work with nothing to judge is better as a `command:` job.

/** The marker the answer ends with: `EXIT=<code>`. */
export const EXIT_MARKER = "EXIT="

const MARKER_LINE = /^[\s`*_"']*EXIT=(-?\d+)[\s`*_"'.]*$/i

/** Append the exit-code rule to an agent prompt of an `expectExitZero` job. */
export function withExitRule(prompt: string, expectExitZero?: boolean): string {
  if (!expectExitZero) return prompt
  return `${prompt}\n\n[Report the exit code]\nEnd your answer with one last line, ${EXIT_MARKER}<code>, giving the exit code of the command you ran (for example ${EXIT_MARKER}0). If you ran several, give the first one that was not 0, or 0 when all succeeded. If you could not run it, write ${EXIT_MARKER}1. Write this line in every case, even after any other required answer.`
}

/** The exit code the answer's last marker line gives, if any. */
export function reportedExitCode(text: string | undefined): number | undefined {
  if (!text) return undefined
  const lines = text.trimEnd().split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = MARKER_LINE.exec(lines[i])
    if (m) return Number(m[1])
  }
  return undefined
}

/** The answer without its trailing marker line, for the quiet check. */
export function withoutExitMarker(text: string | undefined): string | undefined {
  if (!text) return text
  const lines = text.trimEnd().split("\n")
  if (lines.length && MARKER_LINE.test(lines[lines.length - 1])) lines.pop()
  return lines.join("\n")
}

/** Why the run failed the exit check, or undefined when it passed (or the
 *  job has no check). */
export function exitCheckError(expectExitZero: boolean | undefined, text: string | undefined): string | undefined {
  if (!expectExitZero) return undefined
  const code = reportedExitCode(text)
  if (code === undefined) return `the answer did not report the command's exit code (${EXIT_MARKER}<code>)`
  if (code !== 0) return `the command exited with code ${code}`
  return undefined
}
