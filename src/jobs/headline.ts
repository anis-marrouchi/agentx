import { JOB_STATE_ASK, JOB_STATE_RULE } from "@/agents/run-state"

// --- What a job is called, and what is not a job (#2555) ---
//
// A job's text is what was asked. The daemon puts its own lines around a
// run's message (the job-state rule, a notice digest, a same-work or
// same-home note): they are not part of the ask, so they are taken off
// before the job is written. A message that is only the daemon's own
// (a hand-off's answer coming back, a wake, a job-state ask) is no job.
//
// The headline is written by whoever asks: the sender's own `headline`,
// else the subject their opener names ("About the Mac disk alert: …").
// Never the first characters of the text cut short: with no headline the
// Jobs page says "Untitled job from <agent>", so the gap shows.

export const HEADLINE_MAX = 80

// The markers the daemon starts its own lines with. Written out, not
// imported: the modules that own them pull in the whole hand-off and run
// machinery. test/job-headline.test.ts checks they still match.
export const MARKERS = {
  notices: "[agentx:notices",
  sameWork: "[agentx:same-work",
  sameHome: "[agentx:same-home]",
  delegationResult: "[agentx:delegation-result",
  jobWake: "[agentx:job-wake",
  jobStalled: "[Job stalled]",
} as const
const NOTICE_MARKER = MARKERS.notices
const SAME_WORK_MARKER = MARKERS.sameWork
const SAME_HOME_MARKER = MARKERS.sameHome

/** Messages that are the daemon's own, start to end: never a job. */
const SYSTEM_ONLY = [
  MARKERS.delegationResult, MARKERS.jobWake, MARKERS.jobStalled, JOB_STATE_ASK.slice(0, 40),
]

/** The ask without the daemon's lines around it. Empty when nothing is left. */
export function askOf(text: string): string {
  let t = String(text ?? "")
  // Everything up to the job-state rule is the daemon's preamble.
  const rule = t.lastIndexOf(JOB_STATE_RULE)
  if (rule >= 0) t = t.slice(rule + JOB_STATE_RULE.length)
  // A same-work note ends where the new message starts.
  if (t.trimStart().startsWith(SAME_WORK_MARKER)) {
    const at = t.indexOf("The new message:")
    t = at >= 0 ? t.slice(at + "The new message:".length) : ""
  }
  for (;;) {
    t = t.trimStart()
    if (t.startsWith(NOTICE_MARKER)) {
      // The digest ends at its first blank line.
      const end = t.indexOf("\n\n")
      t = end >= 0 ? t.slice(end + 2) : ""
      continue
    }
    if (t.startsWith(SAME_HOME_MARKER)) {
      const end = t.indexOf("\n")
      t = end >= 0 ? t.slice(end + 1) : ""
      continue
    }
    break
  }
  t = t.trim()
  if (SYSTEM_ONLY.some((m) => t.startsWith(m))) return ""
  return t
}

/** The job of the hand-off whose answer this message brings back
 *  (`[agentx:delegation-result task=dlg-…`), or null. */
export function handedJobOf(text: string): string | null {
  const at = String(text ?? "").indexOf(MARKERS.delegationResult)
  if (at < 0) return null
  const m = /^\s*task=(dlg-[A-Za-z0-9-]+)/.exec(text.slice(at + MARKERS.delegationResult.length))
  return m ? `job-${m[1]}` : null
}

/** Is the message only the daemon's own (no ask in it)? */
export function isSystemMessage(text: string): boolean {
  return askOf(text) === ""
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim()

/** The headline the sender wrote: theirs when given, else the subject of
 *  an "About <subject>:" opener. Null when neither fits in HEADLINE_MAX. */
export function headlineOf(given: unknown, ask: string): string | null {
  if (typeof given === "string" && flat(given)) {
    const h = flat(given)
    return h.length <= HEADLINE_MAX ? h : `${h.slice(0, HEADLINE_MAX - 1).trimEnd()}…`
  }
  const m = /^about ([^:\n]{3,200}?)\s*:/i.exec(flat(ask))
  if (!m) return null
  const subject = m[1].trim().replace(/[,.;]+$/, "")
  if (subject.length > HEADLINE_MAX) return null
  return subject[0].toUpperCase() + subject.slice(1)
}
