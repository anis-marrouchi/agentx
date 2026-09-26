import { createHash } from "crypto"
import type { MemoryType } from "../agents/agent-memory"
import { commitmentKey } from "@/daemon/session-monitor"
import type { MemoryCandidate } from "./promote"

// Monitor reviews → wiki promotion candidates.
//
// The session monitor has been producing structured findings all along
// and none of them have ever reached the wiki. 574 parsed reviews hold
// 1,543 decisions, 1,511 warnings, 1,278 pieces of context, 1,216
// actions and 1,106 friction notes — 6,654 items against a wiki of 784
// articles. The single richest seam of institutional knowledge on the
// fleet has been sitting in SQLite because nothing was pointed at it.
//
// It never reached absorb for a structural reason rather than an
// oversight: absorb reads raw *conversation* entries, and a review is
// not a conversation. It is a judgement already extracted from one, with
// its evidence attached. Pushing reviews through absorb would pay a
// writing model to re-derive what the monitor already derived.
//
// So they go through `wiki promote` instead, which exists for exactly
// this shape — a durable, already-formed claim that needs judging for
// fleet relevance and writing into a shared article. Reviews become
// MemoryCandidates carrying a `review:` stamp, and inherit the ledger,
// the idempotency and the judge without any of it being rebuilt.
//
// Only the kinds that describe what IS or WAS are eligible. `actions`
// are excluded: an action is a thing somebody should do, it goes stale
// the moment it is done or abandoned, and a wiki full of last month's
// to-dos is worse than one without them. Those belong on the questions
// queue if anywhere.

export const REVIEW_STAMP_PREFIX = "review:"

/** Review kinds worth keeping, mapped to the memory type they promote as. */
export const PROMOTABLE_KINDS: Record<string, MemoryType> = {
  decisions: "project",
  warnings: "feedback",
  friction: "feedback",
  context: "reference",
}

export interface ReviewRow {
  id: string
  /** The run being reviewed. The monitor re-reviews a session as it
   *  progresses, so several rows share one session_id. */
  session_id?: string
  agent: string
  source?: string
  updated_at?: number
  /** The parsed Review JSON as stored. */
  result: string
}

export interface ReviewItem {
  text: string
  evidence?: string
}

/**
 * Stable identity for one item inside one review.
 *
 * Keyed on the item's TEXT, not its index. The monitor re-reviews a
 * session as it progresses, so the same finding reappears at a
 * different position in a later review of the same run; indexing by
 * position would promote it again as something new. Hashing the text
 * means a re-stated finding is recognised and a genuinely reworded one
 * is treated as new, which is the right way round.
 */
export function reviewStamp(reviewId: string, kind: string, text: string): string {
  const digest = createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 10)
  return `${REVIEW_STAMP_PREFIX}${reviewId}/${kind}@${digest}`
}

export function parseReviewStamp(s: string): { reviewId: string; kind: string; digest: string } | null {
  if (!s.startsWith(REVIEW_STAMP_PREFIX)) return null
  const rest = s.slice(REVIEW_STAMP_PREFIX.length)
  const at = rest.lastIndexOf("@")
  const slash = rest.lastIndexOf("/", at === -1 ? undefined : at)
  if (at === -1 || slash === -1) return null
  return { reviewId: rest.slice(0, slash), kind: rest.slice(slash + 1, at), digest: rest.slice(at + 1) }
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "finding"

/**
 * Turn stored reviews into promotion candidates.
 *
 * The evidence travels with the claim. A warning without it is an
 * assertion a reader has to take on faith, and the monitor already went
 * to the trouble of collecting it — dropping it here would make the
 * resulting article exactly the kind of unfalsifiable prose the wiki is
 * meant not to accumulate.
 */
/** Example sessions kept per finding; the count is in `occurrences`. */
export const MAX_EVIDENCE_SESSIONS = 5

export interface ReviewCandidate extends MemoryCandidate {
  /** Some of the sessions (ids) that produced this finding. */
  sessions?: string[]
  /** How many DISTINCT SESSIONS produced substantially this finding.
   *
   *  Distinct sessions, not review rows, and the difference decides
   *  whether the number means anything. The monitor re-reviews a run as
   *  it progresses, so counting rows made a single miner run that
   *  restated one observation 24 times look like the fleet's most
   *  recurrent finding. It ranked top, and the promotion judge threw it
   *  out as "a snapshot of pending operator items from one miner run" —
   *  correctly. Recurrence across sessions is evidence of a pattern;
   *  recurrence within one is evidence of a long session. */
  occurrences: number
}

/**
 * Two keys, deliberately, because dedupe and ranking want opposite errors.
 *
 * IDENTITY is the exact text hash in the stamp. It must never merge two
 * findings that differ, because a merge drops one permanently — so it
 * errs towards treating a rewording as new.
 *
 * SIMILARITY, for counting recurrence, wants the opposite: monitor
 * findings are free text re-derived from scratch every session, so exact
 * matching almost never fires. On this corpus it found 3 recurrences in
 * 5,435 findings, which is no signal at all. `commitmentKey` is the
 * monitor's own answer to this, written after one leaked token produced
 * 18 separate "rotate it" actions — verb plus the entity acted on. Over-
 * merging here only inflates a rank; it cannot lose a finding.
 */
function similarityKey(kind: string, text: string): string {
  return `${kind}|${commitmentKey(text)}`
}

export function reviewsToCandidates(
  rows: ReviewRow[],
  opts: { kinds?: string[]; minLength?: number } = {},
): ReviewCandidate[] {
  const kinds = opts.kinds ?? Object.keys(PROMOTABLE_KINDS)
  const minLength = opts.minLength ?? 24

  const out: ReviewCandidate[] = []
  // Emit once per exact wording…
  const byExact = new Map<string, ReviewCandidate>()
  const familyOf = new Map<string, string>()
  // …but count per family. Keeping these separate is the point: sharing
  // one map would make an over-merge drop a distinct finding instead of
  // merely inflating a rank.
  const familySessions = new Map<string, Set<string>>()
  const provenance = new Map<string, { text: string; evidence: string; agent: string; source?: string }>()

  for (const row of rows) {
    let review: Record<string, unknown>
    try { review = JSON.parse(row.result) as Record<string, unknown> } catch { continue }

    const when = row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()

    for (const kind of kinds) {
      const type = PROMOTABLE_KINDS[kind]
      if (!type) continue
      const items = review[kind]
      if (!Array.isArray(items)) continue

      for (const raw of items as ReviewItem[]) {
        const text = String(raw?.text ?? "").trim()
        // Very short findings are almost always a restated status line
        // ("deploy succeeded"), which carries nothing an article wants.
        if (text.length < minLength) continue

        const stamp = reviewStamp(row.id, kind, text)
        // The same finding recurs across reviews of one run and across
        // runs. Promote the first occurrence, but count the rest: a
        // finding stated once is usually about that session, while one
        // stated a dozen times is a property of the fleet. That count is
        // the only durability signal this source offers for free, and
        // without it 5,000 candidates arrive in arbitrary order.
        const dedupe = stamp.slice(stamp.lastIndexOf("@"))
        const key = `${kind}${dedupe}`

        // Count every occurrence, including restatements of something
        // already emitted — a finding said five different ways is one
        // recurring finding, and that is what deserves promoting first.
        const family = similarityKey(kind, text)
        const sessions = familySessions.get(family) ?? new Set<string>()
        sessions.add(row.session_id ?? row.id)
        familySessions.set(family, sessions)
        if (byExact.has(key)) continue

        const evidence = String(raw?.evidence ?? "").trim()
        const candidate: ReviewCandidate = {
          occurrences: 1,
          agentId: row.agent,
          key: `${row.agent}/${type}_${slug(text)}`,
          stamp,
          memory: {
            name: slug(text),
            type,
            description: text.slice(0, 200),
            // Body is filled in after the counting pass, because how a
            // finding should be framed depends on how often it recurred.
            body: "",
            createdAt: when,
            updatedAt: when,
          },
        }
        provenance.set(stamp, { text, evidence, agent: row.agent, source: row.source })
        byExact.set(key, candidate)
        familyOf.set(key, family)
        out.push(candidate)
      }
    }
  }

  for (const [key, candidate] of byExact) {
    const sessions = familySessions.get(familyOf.get(key) ?? "")
    candidate.occurrences = sessions?.size ?? 1
    // A few of the sessions it came from, as evidence a reviewer can open.
    candidate.sessions = [...(sessions ?? [])].slice(0, MAX_EVIDENCE_SESSIONS)
    const p = provenance.get(candidate.stamp)!
    candidate.memory.body = renderBody(p, candidate.occurrences)
  }

  // Recurrence decides which finding matters; diversity decides what a
  // capped run gets to see. Sorting on count alone put five rewordings
  // of the same 24× observation in the top five, spending the whole
  // nightly budget on one idea. So: one representative per family
  // first, in count order, then second representatives, and so on.
  // Nothing is dropped — the rewordings are still in the list, just
  // behind a first look at everything else.
  const byFamily = new Map<string, ReviewCandidate[]>()
  for (const [key, candidate] of byExact) {
    const family = familyOf.get(key) ?? key
    const list = byFamily.get(family) ?? []
    list.push(candidate)
    byFamily.set(family, list)
  }
  const families = [...byFamily.values()].sort((a, b) => b[0].occurrences - a[0].occurrences)

  const ordered: ReviewCandidate[] = []
  for (let round = 0; ordered.length < out.length; round++) {
    let placed = false
    for (const list of families) {
      if (round < list.length) { ordered.push(list[round]); placed = true }
    }
    if (!placed) break
  }
  return ordered
}

/**
 * How a finding is written decides whether it survives the judge.
 *
 * The monitor writes point-in-time observations, and the promotion
 * judge — correctly — rejects those: "a transient OAuth expiry that
 * stalled #38", "issue-thread state, not a wiki fact". Twelve
 * candidates across two runs, all skipped, every reason sound.
 *
 * But a finding seen in seven separate sessions is no longer a status
 * report about one of them; it is evidence of something that keeps
 * happening, and that IS durable. The observation was never the
 * knowledge — the repetition is. Saying so explicitly, with the session
 * count as the evidence, is the difference between offering the judge a
 * stale fact and offering it a pattern.
 *
 * A one-off stays phrased as what it is. Dressing a single observation
 * up as a pattern would just launder session state past the judge,
 * which is the failure this is trying to avoid, not a way around it.
 */
function renderBody(
  p: { text: string; evidence: string; agent: string; source?: string },
  occurrences: number,
): string {
  const origin = `${p.agent}${p.source ? ` via ${p.source}` : ""}`
  const parts: string[] = []

  if (occurrences > 1) {
    parts.push(`Observed in ${occurrences} separate sessions. Most recently stated as:`)
    parts.push(`> ${p.text}`)
    parts.push(
      `Recurring across ${occurrences} sessions is what makes this worth recording — ` +
      `any single occurrence is session state, the repetition is the finding.`,
    )
  } else {
    parts.push(p.text)
  }

  if (p.evidence) parts.push(`**Evidence:** ${p.evidence}`)
  parts.push(`_From ${occurrences > 1 ? "session reviews" : "a session review"} of ${origin}._`)
  return parts.join("\n\n")
}
