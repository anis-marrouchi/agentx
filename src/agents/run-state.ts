// --- A run on an agent channel ends by stating its job's state (#1861 phase 2) ---
//
// "The run ended" used to be read as "the work is done". Now a run of agent
// work (a hand-off, a scheduled job, a reminder, an event) says which of
// four states its job is in when it ends:
//
//   done      with its proof (a link, an id, what was checked)
//   continue  what is left, and when it carries on
//   waiting   on whom or what, and until when
//   blocked   why
//
// It says it with the agentx_job_state tool (agentx_waiting counts as
// "waiting"), or with a last line "State: done — <proof>". A run that says
// nothing is asked once, in the same session. Still nothing: the job is
// stalled, and the line that says so goes back with the answer, so whoever
// asked is told. Chat answers to a person are not checked.
//
// Pure: the registry carries it out.

export type JobState =
  | { state: "done"; proof: string }
  | { state: "continue"; left: string; when?: string }
  | { state: "waiting"; on: string; until?: string }
  | { state: "blocked"; why: string }

export type JobStateName = JobState["state"]
export const JOB_STATES: readonly JobStateName[] = ["done", "continue", "waiting", "blocked"]

export interface JobStateSettings {
  enabled: boolean
  /** Channels whose runs must state their job's state. */
  channels: string[]
}

/** Agent work no person reads live. Workflow steps are left out: the
 *  workflow engine already asks each step for done or failed. */
export const DEFAULT_JOB_STATE_CHANNELS = ["a2a", "cron", "reminder", "events"]

const base = (channel: string | undefined) => (channel ?? "").toLowerCase().split("@")[0]

/** Does a run on this channel have to state its job's state? */
export function needsJobState(settings: JobStateSettings | undefined, channel: string | undefined): boolean {
  return !!settings?.enabled && settings.channels.includes(base(channel))
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** A state from the tool's arguments, or an error in plain words. */
export function jobStateFrom(body: Record<string, unknown>): JobState | string {
  const state = text(body.state)
  switch (state) {
    case "done": {
      const proof = text(body.proof)
      return proof ? { state, proof } : "done needs its proof: a link, an id, or what you checked"
    }
    case "continue": {
      const left = text(body.left)
      const when = text(body.when)
      return left ? { state, left, ...(when ? { when } : {}) } : "continue needs what is left (left)"
    }
    case "waiting": {
      const on = text(body.on)
      const until = text(body.until)
      return on ? { state, on, ...(until ? { until } : {}) } : "waiting needs on whom or what (on)"
    }
    case "blocked": {
      const why = text(body.why)
      return why ? { state, why } : "blocked needs why"
    }
    default:
      return `state must be one of ${JOB_STATES.join(", ")}`
  }
}

// "State: done — https://…", "Job state: waiting: devops review, until 18:00".
// Also as a model copies it from the rule: in backticks, as a bullet or a
// quote ("- `State: done — …`"), and as the line the registry adds to an
// answer ("[Job state] waiting on devops until 18:00").
const STATE_LINE = /^[\s>`*_•-]*(?:\[job state\][\s`*_]*|(?:job\s+)?state[`*_]*\s*:[\s`*_]*)(done|continue|waiting|blocked)\b[`*_]*\s*(?:[—–:\-]\s*)?(.*)$/i

const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}\S*)?$/

/** "devops review, until 18:00" → on whom, and until when. */
function waitingFrom(rest: string): JobState | null {
  const m = rest.replace(/^on\s+/i, "").match(/^(.*?)[,;]?\s+until\s+(.+)$/i)
  const on = (m ? m[1] : rest.replace(/^on\s+/i, "")).trim()
  if (!on) return null
  return { state: "waiting", on, ...(m ? { until: m[2].trim() } : {}) }
}

/** "docs (tomorrow)" or "docs, 2030-01-31T17:00:00Z" → what is left, and
 *  when. Any other wording stays whole in what is left. */
function continueFrom(rest: string): JobState {
  const paren = rest.match(/^(.+?)\s*\(([^()]+)\)$/)
  if (paren) return { state: "continue", left: paren[1].trim(), when: paren[2].trim() }
  const cut = rest.lastIndexOf(",")
  const tail = cut > 0 ? rest.slice(cut + 1).trim().replace(/^(?:at|on|when)\s+/i, "") : ""
  if (tail && ISO_TIME.test(tail) && Number.isFinite(Date.parse(tail))) return { state: "continue", left: rest.slice(0, cut).trim(), when: tail }
  return { state: "continue", left: rest }
}

/** The state a reply gives on one of its last lines, or null. */
export function jobStateInText(reply: string | undefined): JobState | null {
  if (!reply) return null
  const lines = reply.trimEnd().split("\n").slice(-5).reverse()
  for (const line of lines) {
    const m = line.match(STATE_LINE)
    if (!m) continue
    const state = m[1].toLowerCase() as JobStateName
    const rest = m[2].replace(/[\s`*]+$/, "").trim()
    if (!rest) return null
    switch (state) {
      case "done": return { state, proof: rest }
      case "continue": return continueFrom(rest)
      case "waiting": return waitingFrom(rest)
      case "blocked": return { state, why: rest }
    }
  }
  return null
}

/** The reply without state lines, for checks that read the bare answer
 *  (a schedule's quiet word, #1289). */
export function withoutStateLines(reply: string): string {
  return reply.split("\n").filter((line) => !STATE_LINE.test(line)).join("\n").trimEnd()
}

/** What a run's job ended as: a state it gave, or none even when asked. */
export type EndState = JobState | { state: "stalled" }

/** The end state an answer carries on its last lines: the line the
 *  registry added ([Job state], [Job stalled]) or the run's own State
 *  line. For an answer that comes back as text only, from another node. */
export function endStateInAnswer(answer: string | undefined): EndState | null {
  if (!answer) return null
  if (answer.trimEnd().split("\n").slice(-5).some((l) => /^\s*\[job stalled\]/i.test(l))) return { state: "stalled" }
  return jobStateInText(answer)
}

/** One line, for logs and the answer. */
export function describeEndState(s: EndState): string {
  return s.state === "stalled" ? "stalled — it ended without saying whether the work is done, and gave no state when asked" : describeJobState(s)
}

/** One line, for logs and the answer. */
export function describeJobState(s: JobState): string {
  switch (s.state) {
    case "done": return `done — ${s.proof}`
    case "continue": return `continue — ${s.left}${s.when ? ` (${s.when})` : ""}`
    case "waiting": return `waiting on ${s.on}${s.until ? ` until ${s.until}` : ""}`
    case "blocked": return `blocked — ${s.why}`
  }
}

/** Put before a run's message on a channel that needs a state. */
export const JOB_STATE_RULE =
  "[Job state] Before you end this run, state the job's state with the agentx_job_state tool, " +
  "or as your last line: `State: done — <proof>`, `State: continue — <what is left, when>`, " +
  "`State: waiting — <on whom, until when>` or `State: blocked — <why>`.\n"

/** The one question a run that stated nothing gets, in the same session. */
export const JOB_STATE_ASK =
  "[Job state] Your run ended without stating the job's state. Reply with one line only, nothing else: " +
  "`State: done — <proof>`, `State: continue — <what is left, when>`, " +
  "`State: waiting — <on whom, until when>` or `State: blocked — <why>`. " +
  "Do not redo or continue the work in this turn."

/** Added to the answer of a run that stated nothing, even when asked. */
export function stalledLine(agentId: string): string {
  return `[Job stalled] ${agentId} ended its run without saying whether the work is done, continuing, waiting or blocked, ` +
    "and gave no state when asked. Treat the work as stalled: check on it or hand it again."
}
