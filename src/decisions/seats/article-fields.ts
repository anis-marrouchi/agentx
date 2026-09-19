import { noul } from "../questions"
import type { NoulAnswer, Questions, StateValue } from "../types"

// Required fields per article type, checked one Noul at a time, and
// ordered by how much of the article rests on them.
//
// Grading an article on a 0-3 completeness scale tells you it scored
// 2.17. It does not tell you what to do. Asking instead "does this state
// a contact value for this person?" returns 0.05, and that is a work
// item.
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

/**
 * Facts are not equally load-bearing, and absorb treats them as if they
 * were.
 *
 * A building is not finished by adding furniture to a slab, but that is
 * what a single absorb pass does: it reads a batch of conversation and
 * writes down what the conversation emphasised. Conversations are about
 * events, so absorb produces history — two dated invoice exchanges on a
 * page that never states the person's number. The furniture arrived
 * before the pillars, and nothing in the pipeline noticed, because
 * nothing in the pipeline had a notion of order.
 *
 * Naming the order makes the gap reportable, prioritisable, and
 * resolvable in passes. A missing foundation is a broken article; a
 * missing piece of furniture is a Tuesday.
 */
export const TIERS = ["foundation", "pillar", "walls", "openings", "furniture"] as const
export type Tier = (typeof TIERS)[number]

export const TIER_RANK: Record<Tier, number> = {
  foundation: 0, pillar: 1, walls: 2, openings: 3, furniture: 4,
}

export const TIER_MEANING: Record<Tier, string> = {
  foundation: "what the thing is — without it the article is about nothing",
  pillar: "the facts the article exists to carry — without them it cannot be acted on",
  walls: "what it connects to — people, projects, systems, status",
  openings: "how to work with it — access conventions, language, ownership",
  furniture: "history and colour — useful, replaceable, last",
}

export interface RequiredField {
  key: string
  /** Imperative form, rendered into the absorb prompt for the writer. */
  label: string
  /** Phrased as a yes/no about the article, never about the subject. */
  question: string
  tier: Tier
}

/**
 * Foundation and pillar are what "critical" used to mean, field for
 * field. Deriving it removes the second concept rather than adding one —
 * there is no way now to mark a field critical and file it under
 * furniture.
 */
export function isCritical(f: RequiredField): boolean {
  return f.tier === "foundation" || f.tier === "pillar"
}

const COMMON: RequiredField[] = [
  { key: "whatItIs", tier: "foundation", label: "what it is, in its own terms", question: "Does the article say what the subject is, in its own terms?" },
  { key: "whyItMatters", tier: "walls", label: "why it matters to our work", question: "Does the article say why the subject matters to our work?" },
  { key: "relationships", tier: "walls", label: "which named people, projects or systems it connects to", question: "Does the article connect the subject to specific named people, projects or systems?" },
]

export const REQUIRED_FIELDS: Record<string, RequiredField[]> = {
  person: [
    ...COMMON,
    { key: "role", tier: "pillar", label: "role or job title", question: "Does the article state this person's role or job title?" },
    { key: "organisation", tier: "pillar", label: "organisation or team, and their position in it", question: "Does the article name the organisation or team this person belongs to?" },
    { key: "contactValue", tier: "pillar", label: "contact identifiers VERBATIM — the actual values, not \"reaches us on WhatsApp\"", question: "Does the article give an actual contact value — a number, handle, email or address — rather than only naming a channel?" },
    { key: "language", tier: "openings", label: "preferred language", question: "Does the article say what language to use with this person?" },
    { key: "ourOwner", tier: "openings", label: "who on our side owns the relationship", question: "Does the article say who on our side owns this relationship?" },
  ],
  place: [
    ...COMMON,
    { key: "address", tier: "pillar", label: "hostname, IP, URL or path", question: "Does the article give a hostname, IP, URL or filesystem path for this system?" },
    { key: "access", tier: "pillar", label: "how access is obtained", question: "Does the article say how access is obtained?" },
    { key: "runsWhat", tier: "walls", label: "what runs on or is stored in it", question: "Does the article say what runs on or is stored in this system?" },
    { key: "administrator", tier: "walls", label: "who administers it", question: "Does the article say who administers it?" },
  ],
  project: [
    ...COMMON,
    { key: "oneLine", tier: "foundation", label: "what it is, in one line", question: "Does the article describe in one line what the project delivers?" },
    { key: "ownerClient", tier: "pillar", label: "client or internal owner", question: "Does the article name the client or internal owner?" },
    { key: "locations", tier: "pillar", label: "repository, environment and URLs", question: "Does the article give a repository, environment or URL for it?" },
    { key: "status", tier: "walls", label: "current status", question: "Does the article state the project's current status?" },
    { key: "people", tier: "walls", label: "who works on it", question: "Does the article name who works on it?" },
  ],
  concept: [
    ...COMMON,
    { key: "definition", tier: "foundation", label: "a one-line definition, first", question: "Does the article open with a one-line definition of the concept?" },
    { key: "whenApplies", tier: "walls", label: "when it applies", question: "Does the article say when this concept applies?" },
  ],
  pattern: [
    ...COMMON,
    { key: "definition", tier: "foundation", label: "a one-line statement of the pattern, first", question: "Does the article open with a one-line statement of the pattern?" },
    { key: "whenApplies", tier: "pillar", label: "when to apply it", question: "Does the article say when to apply it?" },
    { key: "whatToDo", tier: "pillar", label: "what to actually do", question: "Does the article say what to actually do?" },
  ],
  event: [
    ...COMMON,
    { key: "when", tier: "foundation", label: "the date it happened", question: "Does the article give the date the event happened?" },
    { key: "outcome", tier: "pillar", label: "what changed as a result", question: "Does the article say what changed as a result?" },
    { key: "who", tier: "walls", label: "who was involved", question: "Does the article name who was involved?" },
  ],
  decision: [
    ...COMMON,
    { key: "what", tier: "foundation", label: "what was decided", question: "Does the article state plainly what was decided?" },
    { key: "why", tier: "pillar", label: "the reasoning behind it", question: "Does the article give the reasoning behind the decision?" },
    { key: "when", tier: "walls", label: "when it was decided", question: "Does the article say when it was decided?" },
    { key: "consequence", tier: "walls", label: "what it changed", question: "Does the article say what the decision changed?" },
  ],
}

/**
 * Which fact source can supply a field without asking a person.
 *
 * This is what splits the action list in two. A missing contact value is
 * a lookup — `wacli contacts search` answers it in 300ms and nobody is
 * interrupted. A missing role is a question, because no system of record
 * on this fleet holds job titles. Ranking gaps by tier says what matters
 * most; this says which of them we can close by ourselves.
 */
/**
 * Fields a backfill may write on its own, and the resolved fact keys
 * that feed each one.
 *
 * Deliberately a short list, and deliberately not the same list as
 * FIELD_SOURCES. That one says which system *might* know something;
 * this one says what we can copy verbatim from a system of record with
 * no judgement involved. A contact value is a string we were handed. A
 * project's status is a reading of the world, and no lookup returns it.
 *
 * `role` and `organisation` are here because GitLab and Google return
 * them as literal profile fields — where those are blank, which is the
 * common case, nothing is written and the gap stays open for a human.
 */
export const BACKFILLABLE: Record<string, { heading: string; match: RegExp; from: string[] }> = {
  // Ordered by how specific the heading match is: `organisation` is
  // tried before `role` because articles write "Organisation and
  // position", and a naive /position/ test for role would claim it.
  contactValue: {
    heading: "Contact identifiers",
    match: /contact|reach|phone|whatsapp|e-?mail/i,
    from: ["phone", "whatsapp", "email", "gitlab"],
  },
  organisation: {
    heading: "Organisation and position",
    match: /organis|organiz|company|employer|team and/i,
    from: ["organisation"],
  },
  role: {
    heading: "Role or job title",
    match: /role|job title/i,
    from: ["role"],
  },
}

export const BACKFILL_ORDER = ["contactValue", "organisation", "role"] as const

export const FIELD_SOURCES: Record<string, string[]> = {
  contactValue: ["wacli", "gog", "gitlab"],
  organisation: ["gog", "gitlab", "erp"],
  role: ["gog", "gitlab"],
  locations: ["gitlab"],
  address: ["gitlab"],
  ownerClient: ["erp"],
}

export function fieldsFor(type?: string): RequiredField[] {
  return REQUIRED_FIELDS[type ?? ""] ?? COMMON
}

/** Required fields in build order — foundation first, furniture last. */
export function fieldsByTier(type?: string): RequiredField[] {
  return [...fieldsFor(type)].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])
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
  /** Missing field keys grouped by tier, so a gap can be ranked. */
  missingByTier: Record<Tier, string[]>
  /** The most load-bearing tier with a gap — what to fix first. */
  worstTier: Tier | null
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

  const missingByTier = Object.fromEntries(TIERS.map((t) => [t, [] as string[]])) as Record<Tier, string[]>
  for (const f of fields) if (missing.includes(f.key)) missingByTier[f.tier].push(f.key)

  const missingCritical = fields.filter((f) => isCritical(f) && missing.includes(f.key)).map((f) => f.key)
  const worstTier = TIERS.find((t) => missingByTier[t].length > 0) ?? null

  return {
    type: type ?? "?",
    present, missing, unclear, missingCritical, missingByTier, worstTier,
    coverage: fields.length ? present.length / fields.length : 0,
    fit: missingCritical.length === 0,
  }
}

export interface GapAction {
  field: string
  label: string
  tier: Tier
  /** Fact sources that could answer this without asking anyone. */
  sources: string[]
  /** True when no source holds it — this one needs a person. */
  needsHuman: boolean
  /** The grader was unsure rather than negative; verify before rewriting. */
  uncertain: boolean
}

/**
 * The post-absorb work list: what to go and find, most load-bearing
 * first.
 *
 * Absorbing an entry once and never revisiting it assumes one pass can
 * see everything worth keeping. It cannot — half of what an article
 * needs was never in the conversation at all. This turns the grader's
 * output into the next pass's input, so the corpus is built up in
 * layers instead of being declared finished at the first draft.
 */
export function nextActions(
  report: FieldReport,
  opts: { includeUnclear?: boolean; maxTier?: Tier } = {},
): GapAction[] {
  const byKey = new Map(fieldsFor(report.type === "?" ? undefined : report.type).map((f) => [f.key, f]))
  const limit = opts.maxTier ? TIER_RANK[opts.maxTier] : TIER_RANK.furniture

  const keys = [...report.missing, ...(opts.includeUnclear ? report.unclear : [])]
  const actions: GapAction[] = []
  for (const key of keys) {
    const f = byKey.get(key)
    if (!f || TIER_RANK[f.tier] > limit) continue
    const sources = FIELD_SOURCES[key] ?? []
    actions.push({
      field: key,
      label: f.label,
      tier: f.tier,
      sources,
      needsHuman: sources.length === 0,
      uncertain: report.unclear.includes(key),
    })
  }

  // Tier first, then resolvable-by-lookup ahead of needs-a-human: within
  // one tier the automatable work should be drained before anyone is
  // interrupted.
  return actions.sort((a, b) =>
    TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
    Number(a.needsHuman) - Number(b.needsHuman) ||
    a.field.localeCompare(b.field))
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
 *
 * Rendered in tier order, so the instruction reads in the order the
 * article should be built rather than the order the record happens to
 * list.
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
      const own = fieldsByTier(type).filter((f) => !commonKeys.has(f.key))
      const parts = own.map((f) => (isCritical(f) ? bold(f.label) : f.label))
      return `- **${type}** — ${parts.join("; ")}.`
    })
    .join("\n")
}

/** The tier ladder, for the absorb prompt. */
export function tierLadderMarkdown(): string {
  return TIERS.map((t, i) => `${i + 1}. **${t}** — ${TIER_MEANING[t]}`).join("\n")
}
