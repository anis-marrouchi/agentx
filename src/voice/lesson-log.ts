// --- What the daemon log says a live lesson did ---
//
// The last acceptance point of #500 is a real hands-free voice turn on
// the Mac: a lesson that is spoken to pauses and answers, "okay, stop
// now" ends it, and its first step comes within seconds. The person who
// speaks can see the pointer; whether the lesson behaved is in the
// daemon's log, in the `[teach]` lines (stamped, with the screen-read and
// plan durations) and the `[door]` lines (what the listener's words were
// taken for). This reads those lines back into one record per lesson and
// grades each record against that list, so the check is one command and
// the same for everyone who makes it.

export interface LessonStep {
  n: number
  action: string
  target: string | null
  say: string
  /** ISO time of the step line; null on a daemon older than 0.94.0. */
  at: string | null
  readMs: number | null
  planMs: number | null
}

/** What came through the door while the lesson ran. */
export interface LessonWords {
  text: string
  /** The words ended the lesson (a spoken stop). */
  ended: boolean
  /** Steps logged before the words: the next step is the lesson's answer. */
  afterStep: number
}

export interface LessonRecord {
  agentId: string
  mode: string
  goal: string
  /** How the lesson was started: the presence seat's choice for a voice
   *  turn, or the terminal and the API, which log no seat line. */
  startedBy: { seat: true; chose: string; p: number } | { seat: false }
  startedAt: string | null
  steps: LessonStep[]
  /** From the start line to the first step line, when both carry a time. */
  firstStepMs: number | null
  hushes: number
  words: LessonWords[]
  end: { reason: string; at: string | null } | null
  /** From the start line to the end line, when both carry a time. */
  durationMs: number | null
}

export type Verdict = "ok" | "not ok" | "by eye" | "not seen"

export interface Check {
  /** The acceptance point, in the words of #500. */
  point: string
  verdict: Verdict
  /** What the log showed, in a line. */
  note: string
}

/** The first step should come within this on a Mac that is not busy. */
export const FIRST_STEP_MS = 10_000

const TAG = /\[(teach|door|presence)\] (.*)$/
const ISO = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/
const START = /^([\w.-]+) \((teach|watch|act)\): (.*)$/
const STEP = /^(\d+)\. ([a-z_]+)(?: "(.*)")?: (.*)$/
const TOOK = /^(.*) \(screen (\d+) ms, plan (\d+) ms\)$/
const END = /^ended \((.*)\)$/
const SEAT = /^([\w.-]+) seat=\S+ chose=(\S+) p=([\d.]+) → (\w+)/
const DOOR_WORDS = /^"(.*)" → lesson( \(ended\))?$/

const ms = (from: string | null, to: string | null): number | null =>
  from && to ? Date.parse(to) - Date.parse(from) : null

/** Every lesson the log holds, oldest first. A lesson with no `ended` line
 *  was still running when the log was read, or the daemon stopped. */
export function readLessons(text: string): LessonRecord[] {
  const lessons: LessonRecord[] = []
  let open: LessonRecord | null = null
  let seat: { agentId: string; chose: string; p: number } | null = null
  for (const raw of text.split("\n")) {
    const tag = TAG.exec(raw)
    if (!tag) continue
    const [, kind, rest] = tag
    if (kind === "presence") {
      const m = SEAT.exec(rest)
      if (m && ["teach", "watch", "act"].includes(m[4])) seat = { agentId: m[1], chose: m[2], p: Number(m[3]) }
      continue
    }
    if (kind === "door") {
      if (!open) continue
      if (rest.startsWith("hush → lesson")) { open.hushes++; continue }
      const m = DOOR_WORDS.exec(rest)
      if (m) open.words.push({ text: m[1], ended: !!m[2], afterStep: open.steps.length })
      continue
    }
    // [teach]: stamped since 0.94.0; older daemons wrote the line alone.
    const stamped = ISO.exec(rest)
    const at = stamped ? stamped[1] : null
    const line = stamped ? stamped[2] : rest
    const start = START.exec(line)
    if (start) {
      const [, agentId, mode, goal] = start
      const chosen = seat && seat.agentId === agentId ? { seat: true as const, chose: seat.chose, p: seat.p } : { seat: false as const }
      seat = null
      open = { agentId, mode, goal, startedBy: chosen, startedAt: at, steps: [], firstStepMs: null, hushes: 0, words: [], end: null, durationMs: null }
      lessons.push(open)
      continue
    }
    if (!open) continue
    const step = STEP.exec(line)
    if (step) {
      const took = TOOK.exec(step[4])
      open.steps.push({
        n: Number(step[1]), action: step[2], target: step[3] ?? null, say: took ? took[1] : step[4], at,
        readMs: took ? Number(took[2]) : null, planMs: took ? Number(took[3]) : null,
      })
      if (open.steps.length === 1) open.firstStepMs = ms(open.startedAt, at)
      continue
    }
    const end = END.exec(line)
    if (end) {
      open.end = { reason: end[1], at }
      open.durationMs = ms(open.startedAt, at)
      open = null
    }
  }
  return lessons
}

const s = (n: number) => `${(n / 1000).toFixed(1)} s`

/** The acceptance list of #500, graded from one lesson's record. */
export function gradeLesson(l: LessonRecord): Check[] {
  const checks: Check[] = []
  const first = l.steps[0]
  checks.push({
    point: "\"Looking at …\" shows from the start until the first step",
    verdict: "by eye",
    note: first ? `the first step came ${l.firstStepMs === null ? "with no time on it" : `after ${s(l.firstStepMs)}`}` : "no step was logged",
  })

  const spoken = l.words.filter((w) => !w.ended)
  const words = "Words said mid-lesson pause it and reach the next step"
  if (!spoken.length) {
    // Before 0.94.0 a hush ended the lesson, and the words that followed
    // never reached it: the log has the hush and the end, and no door line.
    if (l.startedAt === null && l.hushes && l.end?.reason === "stopped by the listener") checks.push({ point: words, verdict: "not ok", note: "a hush ended it: the daemon runs a build older than 0.94.0" })
    else if (l.end?.reason === "no words after the hush") checks.push({ point: words, verdict: "not seen", note: "a hush came and nothing was said within a minute, so it ended" })
    else checks.push({ point: words, verdict: "not seen", note: l.hushes ? "a hush came, but no words followed it" : "nothing was said to the lesson" })
  } else {
    const answered = spoken.filter((w) => l.steps.length > w.afterStep)
    const sayings = spoken.map((w) => `"${w.text}"`).join(", ")
    if (answered.length === spoken.length) checks.push({ point: words, verdict: "ok", note: `${sayings}: the lesson went on, and a step followed each` })
    else checks.push({ point: words, verdict: l.end ? "not ok" : "not seen", note: `${sayings}: the lesson went on, but no step followed${l.end ? ` (ended: ${l.end.reason})` : " yet"}` })
  }

  const stop = l.words.find((w) => w.ended)
  if (stop) checks.push({ point: "A spoken stop ends it", verdict: l.end?.reason === "stopped by the listener" ? "ok" : "not ok", note: `"${stop.text}" ${l.end ? `ended it (${l.end.reason})` : "was taken as a stop, but no end was logged"}` })
  else if (!l.end) checks.push({ point: "A spoken stop ends it", verdict: "not seen", note: "still running when the log was read, or the daemon stopped" })
  else checks.push({ point: "A spoken stop ends it", verdict: "not seen", note: `ended another way: ${l.end.reason}` })

  const timed = l.startedAt !== null && l.steps.every((st) => st.at !== null && st.planMs !== null)
  if (!timed) checks.push({ point: "[teach] lines carry a time and the screen-read and plan durations", verdict: "not ok", note: "no times on the lines: the daemon runs a build older than 0.94.0" })
  else if (!first) checks.push({ point: "[teach] lines carry a time and the screen-read and plan durations", verdict: "not seen", note: "no step was logged" })
  else checks.push({ point: "[teach] lines carry a time and the screen-read and plan durations", verdict: "ok", note: `step 1: screen ${s(first.readMs!)}, plan ${s(first.planMs!)}` })

  if (l.firstStepMs === null) checks.push({ point: `First step under ${s(FIRST_STEP_MS)} on an idle Mac`, verdict: "not seen", note: first ? "no time on the start or the step line" : "no step was logged" })
  else checks.push({ point: `First step under ${s(FIRST_STEP_MS)} on an idle Mac`, verdict: l.firstStepMs < FIRST_STEP_MS ? "ok" : "not ok", note: `${s(l.firstStepMs)} from the start to step 1${l.firstStepMs >= FIRST_STEP_MS ? "; a busy Mac or a slow plan model" : ""}` })
  return checks
}

/** One lesson and its grades, as `agentx voice lessons` prints them. */
export function formatLesson(l: LessonRecord, paint: (verdict: Verdict, text: string) => string = (_v, t) => t): string {
  const out: string[] = []
  const when = l.startedAt ? l.startedAt.replace(/\.\d+Z$/, "Z") : "no time"
  out.push(`  ${when}  ${l.agentId} (${l.mode}): "${l.goal}"`)
  out.push(`    started by ${l.startedBy.seat ? `a voice turn: the presence seat chose ${l.startedBy.chose} (p=${l.startedBy.p.toFixed(2)})` : "the terminal or the API"}`)
  const ended = l.end ? `ended ${l.durationMs === null ? "" : `after ${s(l.durationMs)} `}(${l.end.reason})` : "no end logged"
  out.push(`    ${l.steps.length} step${l.steps.length === 1 ? "" : "s"}, ${l.hushes} hush${l.hushes === 1 ? "" : "es"}, ${ended}`)
  for (const st of l.steps) {
    const took = st.planMs === null ? "" : ` (screen ${st.readMs} ms, plan ${st.planMs} ms)`
    out.push(`      ${st.n}. ${st.action}${st.target ? ` "${st.target}"` : ""}: ${st.say}${took}`)
  }
  for (const w of l.words) out.push(`      heard "${w.text}" → ${w.ended ? "the lesson ended" : "the lesson's next step"}`)
  for (const c of gradeLesson(l)) out.push(`    ${paint(c.verdict, c.verdict.padEnd(8))} ${c.point}: ${c.note}`)
  return out.join("\n")
}
