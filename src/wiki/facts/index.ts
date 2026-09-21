import { createContactsSource } from "./sources/contacts"
import { createGitlabSource } from "./sources/gitlab"
import { createGogSource } from "./sources/gog"
import { createWacliSource } from "./sources/wacli"
import type { EntityHint, FactRecord, FactSource, FactSourceResult, Unavailable } from "./types"

export * from "./types"
export { countryFromPhone, parseContactsTable, plausible } from "./sources/wacli"
export { createGitlabSource } from "./sources/gitlab"
export { createGogSource } from "./sources/gog"
export { createWacliSource } from "./sources/wacli"
export { platformOf, recordsFromEntries } from "./sources/entries"
export { createContactsSource, factsFrom, loadContacts, namesOf } from "./sources/contacts"
export type { ContactRecord } from "./sources/contacts"
export type { SenderStampedEntry } from "./sources/entries"

export interface ResolveOptions {
  sources?: FactSource[]
  /** Whole-resolve budget. A slow address book must not stall an absorb. */
  timeoutMs?: number
  /** Cap on entities looked up per batch — each one is N network calls. */
  maxEntities?: number
  onResult?: (r: FactSourceResult) => void
}

/**
 * Probe each source once per process, not once per lookup.
 *
 * Availability does not change mid-run, but the probes are real work —
 * gog's costs about 1.4s because it has to make an API call to
 * distinguish "installed" from "installed but the API is disabled".
 * Backfilling 50 articles re-ran every probe 50 times and spent longer
 * asking whether the sources worked than using them.
 *
 * The promise is cached, not the result, so concurrent callers share one
 * probe rather than racing.
 */
export function memoizeAvailability(source: FactSource): FactSource {
  let probe: Promise<Unavailable | null> | undefined
  return {
    ...source,
    available: () => (probe ??= source.available()),
    lookup: (hints, signal) => source.lookup(hints, signal),
  }
}

/**
 * Ordered by authority, because mergeRecords lets the first source to
 * state a field win.
 *
 * The hand-maintained registry comes first: it is the only source where
 * a person decided that a name, its aliases and a set of handles all
 * refer to one human. Directories only know their own corner, and they
 * cannot resolve an alias at all.
 */
export function defaultSources(): FactSource[] {
  return [
    createContactsSource(),
    createWacliSource(),
    createGitlabSource(),
    createGogSource(),
  ].map(memoizeAvailability)
}

/**
 * Names worth a lookup, taken from the batch.
 *
 * Only entities the batch already mentions are ever queried. That is a
 * deliberate limit and not just an efficiency one: exporting the address
 * book into a prompt would put identifiers for people who have nothing
 * to do with the work into a model's context. A lookup is justified by
 * the entry that names the person.
 */
export function extractHints(
  entries: Array<{ context?: string; content?: string; sender?: string }>,
  opts: { max?: number; known?: string[] } = {},
): EntityHint[] {
  const max = opts.max ?? 25
  const byName = new Map<string, EntityHint>()

  // The stamped sender first: it is the platform's own record of who
  // spoke, so it beats both a heuristic over `context` and a substring
  // scan of the body. Entries captured before senders were recorded
  // simply have none, and fall through to the other two.
  for (const e of entries) {
    const s = (e.sender ?? "").trim()
    if (s && isPersonName(s)) byName.set(s.toLowerCase(), { name: s, origin: "sender", type: "person" })
  }

  for (const e of entries) {
    const ctx = (e.context ?? "").trim()
    if (!isPersonName(ctx)) continue
    const key = ctx.toLowerCase()
    if (byName.has(key)) continue
    byName.set(key, { name: ctx, origin: "context" })
  }

  // `context` only names a person for one-to-one channels. On a GitLab
  // entry it is the issue title, and in a group chat it is the group —
  // so the people who talk in groups, which is most of them, were never
  // looked up at all. The first article written with this layer live
  // said "Contact identifiers: unknown … no number is recorded" about
  // someone the contact store knew perfectly well.
  //
  // The bodies do name them, but harvesting capitalised word pairs out
  // of free text would spend lookups on noise and, worse, resolve
  // strangers. So the corpus is its own dictionary: a name is a hint
  // only if the wiki already has a person article for it. That is
  // precise by construction, and it targets exactly the articles a
  // second pass is going to rewrite.
  const known = (opts.known ?? []).filter((n) => n.trim().length > 2)
  if (known.length > 0) {
    const haystack = entries.map((e) => e.content ?? "").join("\n").toLowerCase()
    for (const name of known) {
      const key = name.toLowerCase().trim()
      if (byName.has(key)) continue
      if (haystack.includes(key)) byName.set(key, { name, origin: "body", type: "person" })
    }
  }

  return Array.from(byName.values()).slice(0, max)
}

const NOT_A_PERSON = new Set([
  "me", "user", "system", "cron", "unknown", "anonymous", "bot", "agent",
  "self", "test", "admin", "none", "null", "n/a",
])

/**
 * Words that make a capitalised phrase a collection rather than a person.
 *
 * A group chat's `context` is its name, and plenty of group names are
 * shaped exactly like a person's — "Team Group", "Acme Family". Shape
 * alone cannot separate them, and treating one as a person spends a
 * lookup and risks matching a real contact with a similar name.
 */
const COLLECTION_NOUNS = new Set([
  "group", "team", "chat", "channel", "squad", "crew", "room", "family",
  "project", "board", "committee", "club", "staff", "office", "dept",
  "department", "support", "sales", "ops", "admins", "everyone", "all",
])

/**
 * Two to four capitalised words, no digits, not a known placeholder.
 *
 * `context` holds a person's name for chat sources and an issue title
 * for GitLab ones, and issue titles are long and full of punctuation.
 * The bar is deliberately high: a false positive costs a wasted lookup
 * and, worse, risks putting an unrelated person's identifiers into the
 * prompt, so a missed name is the cheaper error.
 */
export function isPersonName(s: string): boolean {
  const t = s.trim()
  if (!t || t.length > 48) return false
  if (NOT_A_PERSON.has(t.toLowerCase())) return false
  if (/[\d@/\\#:|_]/.test(t)) return false
  const words = t.split(/\s+/)
  if (words.length < 2 || words.length > 4) return false
  if (words.some((w) => COLLECTION_NOUNS.has(w.toLowerCase()))) return false
  return words.every((w) => /^[\p{Lu}][\p{L}'’.-]*$/u.test(w))
}

export async function resolveFacts(
  hints: EntityHint[],
  opts: ResolveOptions = {},
): Promise<{ records: FactRecord[]; results: FactSourceResult[] }> {
  const sources = opts.sources ?? defaultSources()
  const picked = hints.slice(0, opts.maxEntities ?? 25)
  if (picked.length === 0) return { records: [], results: [] }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000)
  try {
    const results = await Promise.all(sources.map(async (s): Promise<FactSourceResult> => {
      const t0 = Date.now()
      try {
        const why = await s.available()
        if (why) return { source: s.name, records: [], unavailable: why, ms: Date.now() - t0 }
        const records = await s.lookup(picked, ac.signal)
        return { source: s.name, records, ms: Date.now() - t0 }
      } catch (err) {
        // A source that throws contributes nothing and blocks nothing.
        return {
          source: s.name,
          records: [],
          unavailable: { kind: "failed", hint: String((err as Error)?.message ?? err) },
          ms: Date.now() - t0,
        }
      }
    }))
    for (const r of results) opts.onResult?.(r)
    return { records: results.flatMap((r) => r.records), results }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What to tell the operator about the sources that did not answer.
 *
 * A source silently contributing nothing is the worst outcome: the
 * corpus quietly develops a hole shaped like the missing tool, and the
 * grader reports the resulting gaps as though the fact did not exist
 * anywhere. Installing `wacli` is a one-line fix that nobody makes if
 * nobody is told. `failed` is left out — a transient error is noise, not
 * a task.
 */
export function installPrompts(
  results: FactSourceResult[],
  sources: FactSource[] = defaultSources(),
): Array<{ source: string; kind: string; hint: string; provides: string[] }> {
  const provides = new Map(sources.map((s) => [s.name, s.provides]))
  return results
    .filter((r) => r.unavailable && r.unavailable.kind !== "failed")
    .map((r) => ({
      source: r.source,
      kind: r.unavailable!.kind,
      hint: r.unavailable!.hint,
      provides: provides.get(r.source) ?? [],
    }))
}

export interface MergedEntity {
  name: string
  /** field → value, with the source that supplied it. */
  fields: Record<string, { value: string; source: string }>
}

/**
 * Merge per entity, first source to state a field wins.
 *
 * Order is the source order, which puts WhatsApp's number ahead of
 * Google's. That is intentional rather than arbitrary: the WhatsApp
 * number is the one the agent will actually message on, so where the two
 * disagree the messaging channel's own record is the operative fact.
 * Conflicts are kept and rendered, never silently resolved.
 */
export function mergeRecords(records: FactRecord[]): MergedEntity[] {
  const out = new Map<string, MergedEntity>()
  for (const r of records) {
    const key = r.name.toLowerCase().trim()
    let e = out.get(key)
    if (!e) { e = { name: r.name, fields: {} }; out.set(key, e) }
    for (const [k, v] of Object.entries(r.fields)) {
      if (!v?.trim()) continue
      const existing = e.fields[k]
      if (!existing) { e.fields[k] = { value: v, source: r.source }; continue }
      if (existing.value !== v) {
        // Two systems of record disagree. The writer should see both.
        e.fields[`${k} (${r.source})`] ??= { value: v, source: r.source }
      }
    }
  }
  return Array.from(out.values())
}

/**
 * The prompt block.
 *
 * Phrased as an instruction to copy rather than as context to consider.
 * Absorb's whole disposition is to summarise, and an identifier
 * summarised is an identifier lost — which is the failure this exists
 * to fix.
 */
export function renderFactsBlock(entities: MergedEntity[]): string {
  if (entities.length === 0) return ""
  const lines = entities
    .filter((e) => Object.keys(e.fields).length > 0)
    .map((e) => {
      const fields = Object.entries(e.fields)
        .map(([k, v]) => `  - ${k}: \`${v.value}\` _(${v.source})_`)
        .join("\n")
      return `- **${e.name}**\n${fields}`
    })
  if (lines.length === 0) return ""
  return `
## Verified facts

These were read from systems of record — WhatsApp, GitLab, Google, the
ERP — not from the entries. They are more reliable than anything the
conversation implies, and they are the identity fields articles are
graded on.

Copy every value that belongs to an article you write, **verbatim**, into
its Identity section. Do not paraphrase an identifier, reformat it, or
replace it with the name of the channel it belongs to. Where a fact here
contradicts the entries, this wins and the entry is stale.

${lines.join("\n")}
`
}
