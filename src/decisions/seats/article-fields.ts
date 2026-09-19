import { noul } from "../questions"
import type { NoulAnswer, Questions, StateValue } from "../types"

// Required fields per article type, checked one Noul at a time.
//
// Grading an article on a 0-3 completeness scale tells you it scored
// 2.17. It does not tell you what to do. Asking instead "does this state
// a phone number, handle or email for this person?" returns 0.05, and
// that is a work item.
//
// This is the fan-out Jev is built for: one article as shared state, one
// yes/no per required field, every answer in a single call. Thirteen
// fields cost the same round trip as one.
//
// The field lists mirror the Identity section the absorb prompt now
// demands, so the same contract is stated once to the writer and once to
// the checker. When they drift, the checker is right — it is the one
// measured against real articles.

export const ARTICLE_FIELDS_SEAT = "article-fields"

export interface RequiredField {
  key: string
  /** Imperative form, rendered into the absorb prompt for the writer. */
  label: string
  /** Phrased as a yes/no about the article, never about the subject. */
  question: string
  /** A missing critical field makes the article unfit for its purpose;
   *  a non-critical one makes it thinner. */
  critical?: boolean
}

const COMMON: RequiredField[] = [
  { key: "whatItIs", label: "what it is, in its own terms", question: "Does the article say what the subject is, in its own terms?", critical: true },
  { key: "whyItMatters", label: "why it matters to our work", question: "Does the article say why the subject matters to our work?" },
  { key: "relationships", label: "which named people, projects or systems it connects to", question: "Does the article connect the subject to specific named people, projects or systems?" },
]

export const REQUIRED_FIELDS: Record<string, RequiredField[]> = {
  person: [
    ...COMMON,
    { key: "role", label: "role or job title", question: "Does the article state this person's role or job title?", critical: true },
    { key: "organisation", label: "organisation or team, and their position in it", question: "Does the article name the organisation or team this person belongs to?", critical: true },
    { key: "contactValue", label: "contact identifiers VERBATIM — phone, WhatsApp, email, handle; the actual value, not \"reaches us on WhatsApp\"", question: "Does the article give an actual contact value — a phone number, handle, email or address — rather than only naming a channel?", critical: true },
    { key: "language", label: "preferred language", question: "Does the article say what language to use with this person?" },
    { key: "ourOwner", label: "who on our side owns the relationship", question: "Does the article say who on our side owns this relationship?" },
  ],
  place: [
    ...COMMON,
    { key: "address", label: "hostname, IP, URL or path", question: "Does the article give a hostname, IP, URL or filesystem path for this system?", critical: true },
    { key: "access", label: "how access is obtained", question: "Does the article say how access is obtained?", critical: true },
    { key: "runsWhat", label: "what runs on or is stored in it", question: "Does the article say what runs on or is stored in this system?" },
    { key: "administrator", label: "who administers it", question: "Does the article say who administers it?" },
  ],
  project: [
    ...COMMON,
    { key: "oneLine", label: "what it is, in one line", question: "Does the article describe in one line what the project delivers?", critical: true },
    { key: "ownerClient", label: "client or internal owner", question: "Does the article name the client or internal owner?", critical: true },
    { key: "status", label: "current status", question: "Does the article state the project's current status?" },
    { key: "locations", label: "repository, environment and URLs", question: "Does the article give a repository, environment or URL for it?", critical: true },
    { key: "people", label: "who works on it", question: "Does the article name who works on it?" },
  ],
  concept: [
    ...COMMON,
    { key: "definition", label: "a one-line definition, first", question: "Does the article open with a one-line definition of the concept?", critical: true },
    { key: "whenApplies", label: "when it applies", question: "Does the article say when this concept applies?" },
  ],
  pattern: [
    ...COMMON,
    { key: "definition", label: "a one-line statement of the pattern, first", question: "Does the article open with a one-line statement of the pattern?", critical: true },
    { key: "whenApplies", label: "when to apply it", question: "Does the article say when to apply it?", critical: true },
    { key: "whatToDo", label: "what to actually do", question: "Does the article say what to actually do?", critical: true },
  ],
  event: [
    ...COMMON,
    { key: "when", label: "the date it happened", question: "Does the article give the date the event happened?", critical: true },
    { key: "who", label: "who was involved", question: "Does the article name who was involved?" },
    { key: "outcome", label: "what changed as a result", question: "Does the article say what changed as a result?", critical: true },
  ],
  decision: [
    ...COMMON,
    { key: "what", label: "what was decided", question: "Does the article state plainly what was decided?", critical: true },
    { key: "why", label: "the reasoning behind it", question: "Does the article give the reasoning behind the decision?", critical: true },
    { key: "when", label: "when it was decided", question: "Does the article say when it was decided?" },
    { key: "consequence", label: "what it changed", question: "Does the article say what the decision changed?" },
  ],
}

export function fieldsFor(type?: string): RequiredField[] {
  return REQUIRED_FIELDS[type ?? ""] ?? COMMON
}

/** One Noul per required field — all answered in a single call. */
export function fieldQuestions(type?: string): Questions {
  const q: Record<string, ReturnType<typeof noul>> = {}
  for (const f of fieldsFor(type)) q[f.key] = noul(f.question)
  return q as Questions
}

export function articleFieldsState(a: { title: string; type?: string; body: string }, max = 12_000): StateValue {
  const body = String(a.body ?? "").trim()
  return {
    title: a.title,
    type: a.type ?? null,
    body: body.length > max ? `${body.slice(0, max)}\n…[truncated]` : body,
  }
}

export interface FieldReport {
  type: string
  present: string[]
  missing: string[]
  /** Between the thresholds — the model is not sure the field is there,
   *  which usually means it is mentioned vaguely. Worth a human glance
   *  rather than an automatic rewrite. */
  unclear: string[]
  missingCritical: string[]
  /** Share of required fields present. */
  coverage: number
  fit: boolean
}

/**
 * TypeSafe's own review band: act below 0.30 or above 0.70, escalate
 * between. classifier.dev — which runs on Jev — re-asks anything under
 * 0.70 for the same reason, and gains 2.5 points of accuracy on AG News
 * doing it. Treating the middle as an answer is where that gain is lost.
 */
export function reportFields(
  type: string | undefined,
  answers: Record<string, unknown>,
  opts: { low?: number; high?: number } = {},
): FieldReport {
  const low = opts.low ?? 0.3
  const high = opts.high ?? 0.7
  const fields = fieldsFor(type)
  const present: string[] = [], missing: string[] = [], unclear: string[] = []

  for (const f of fields) {
    const p = (answers[f.key] as NoulAnswer | undefined)?.noul
    if (p === undefined) { unclear.push(f.key); continue }
    if (p > high) present.push(f.key)
    else if (p <= low) missing.push(f.key)
    else unclear.push(f.key)
  }

  const missingCritical = fields
    .filter((f) => f.critical && missing.includes(f.key))
    .map((f) => f.key)

  return {
    type: type ?? "?",
    present, missing, unclear, missingCritical,
    coverage: fields.length ? present.length / fields.length : 0,
    fit: missingCritical.length === 0,
  }
}

/**
 * The same field list, rendered for the absorb prompt.
 *
 * The writer and the checker read one definition. When these were two
 * hand-written lists they drifted within a day: the prompt asked for a
 * relationship owner, the rubric never looked for one, and nobody could
 * tell whether a missing owner was the writer's fault or the checker's
 * blind spot. Generating the prompt from the checked fields makes that
 * class of disagreement unrepresentable.
 */
export function fieldChecklistMarkdown(): string {
  const order = ["person", "project", "place", "concept", "pattern", "event", "decision"]
  const commonKeys = new Set(COMMON.map((f) => f.key))
  const bold = (t: string) => {
    if (t.includes("**")) throw new Error(`field label must not carry its own emphasis: ${t}`)
    return `**${t}**`
  }
  return order
    .map((type) => {
      const own = REQUIRED_FIELDS[type].filter((f) => !commonKeys.has(f.key))
      const parts = own.map((f) => (f.critical ? bold(f.label) : f.label))
      return `- **${type}** — ${parts.join("; ")}.`
    })
    .join("\n")
}
