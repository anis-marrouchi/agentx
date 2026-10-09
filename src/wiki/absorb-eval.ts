// Measuring what `agentx wiki absorb` writes (#808).
//
// Absorb turns raw entries into articles, and until now nothing checked
// the result against the entries it came from. This module is the
// scorecard: a fixed, seeded sample of articles, five checks per article,
// and an optional model judge for the questions a string match cannot
// answer (is this claim supported, does this source belong here).
//
// The deterministic checks are deliberately narrow. A commit hash or URL
// in an article that no cited entry and no earlier version carries is
// almost certainly made up or mis-attributed; a commit or URL in a cited
// entry that no article carries was almost certainly lost. Prose claims
// are left to the judge.

import { extractFacts } from "./absorb-context"

export interface EvalArticle {
  path: string
  title: string
  type?: string
  content: string
  sources: string[]
  lastUpdated?: string
  /** The article body before this absorb touched it, when one exists. */
  previous?: string
}

export interface EvalEntry {
  id: string
  date?: string
  content: string
}

// --- Sample ---

/** A small seeded PRNG, so a sample can be drawn again from the same seed. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `n` items picked without replacement. Same items and seed, same pick. */
export function pickSample<T extends { path: string }>(items: T[], n: number, seed: string): T[] {
  const rng = seededRandom(seed)
  const pool = [...items].sort((a, b) => a.path.localeCompare(b.path))
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, Math.max(0, n)).sort((a, b) => a.path.localeCompare(b.path))
}

// --- Terms ---

const STOP = new Set(
  ("about after again also because been before being between could does doing during each from have having here into "
    + "just more most only other over same should some such than that their them then there these they this those "
    + "through under until very were what when where which while will with would your yours user assistant agent "
    + "message entry please thanks").split(" "),
)

/** Distinctive words: four letters or more, lower-cased, minus common ones. */
export function terms(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu)) {
    if (!STOP.has(m[0])) out.add(m[0])
  }
  return out
}

/** Share of `entry`'s distinctive words that appear in `article`. */
export function termOverlap(entry: string, article: string): number {
  const e = terms(entry)
  if (e.size === 0) return 1
  const a = terms(article)
  let hit = 0
  for (const t of e) if (a.has(t)) hit++
  return hit / e.size
}

// --- Per-article checks ---

/** Below this share of shared words a cited entry is flagged as weak. */
export const WEAK_CITATION = 0.15

export interface ArticleCheck {
  path: string
  title: string
  type?: string
  sources: number
  /** Cited ids with no entry behind them. */
  missingSources: string[]
  /** Cited entries that share almost no words with the article. */
  weakSources: string[]
  /** Commits, links and numbers in the article that neither a cited entry
   *  nor the earlier version carries. */
  ungrounded: string[]
  /** Commits and links in a cited entry that no article citing it carries. */
  lost: Array<{ entry: string; fact: string }>
}

/** What a fact looks like when matched against grounding text. */
function factStrings(text: string): { commits: string[]; urls: string[]; numbers: string[] } {
  const f = extractFacts(text)
  return { commits: f.commits, urls: f.urls, numbers: f.numbers }
}

function hasCommit(haystack: string, commit: string, known: string[]): boolean {
  return haystack.includes(commit) || known.some((k) => k.startsWith(commit) || commit.startsWith(k))
}

const urlKey = (u: string) => u.toLowerCase().replace(/\/+$/, "")

/**
 * Check one article against its cited entries.
 *
 * `citersOf` returns every article (in the whole wiki, not only the
 * sample) that cites an entry, so a fact moved to a sibling article is
 * not counted as lost.
 */
export function checkArticle(
  article: EvalArticle,
  entries: Map<string, EvalEntry>,
  citersOf: (entryId: string) => string[],
): ArticleCheck {
  const cited = article.sources.map((id) => entries.get(id)).filter((e): e is EvalEntry => !!e)
  const missingSources = article.sources.filter((id) => !entries.has(id))

  const weakSources = cited
    .filter((e) => terms(e.content).size >= 5 && termOverlap(e.content, article.content) < WEAK_CITATION)
    .map((e) => e.id)

  // Grounding: entry text with its date (absorb is shown the date in the
  // entry header), plus the earlier version of the article.
  const grounding = [...cited.map((e) => `${e.date ?? ""}\n${e.content}`), article.previous ?? ""].join("\n")
  const groundLower = grounding.toLowerCase()
  const g = factStrings(grounding)
  const groundUrls = new Set(g.urls.map(urlKey))
  const groundNumbers = new Set(g.numbers)
  const mine = factStrings(article.content)
  const ungrounded: string[] = []
  for (const c of mine.commits) if (!hasCommit(groundLower, c, g.commits)) ungrounded.push(`commit ${c}`)
  for (const u of mine.urls) if (!groundUrls.has(urlKey(u)) && !groundLower.includes(urlKey(u))) ungrounded.push(`link ${u}`)
  for (const n of mine.numbers) {
    // Bare small integers ("2 tests", "3 people") are too common to judge.
    if (/^\d{1,2}$/.test(n)) continue
    if (!groundNumbers.has(n) && !groundLower.includes(n)) ungrounded.push(`number ${n}`)
  }

  const lost: Array<{ entry: string; fact: string }> = []
  for (const e of cited) {
    const facts = factStrings(e.content)
    if (facts.commits.length === 0 && facts.urls.length === 0) continue
    const carriers = citersOf(e.id)
    const text = (carriers.length > 0 ? carriers : [article.content]).join("\n").toLowerCase()
    const carrierFacts = factStrings(text)
    for (const c of facts.commits) if (!hasCommit(text, c, carrierFacts.commits)) lost.push({ entry: e.id, fact: `commit ${c}` })
    for (const u of facts.urls) if (!text.includes(urlKey(u))) lost.push({ entry: e.id, fact: `link ${u}` })
  }

  return {
    path: article.path,
    title: article.title,
    type: article.type,
    sources: article.sources.length,
    missingSources,
    weakSources,
    ungrounded,
    lost,
  }
}

// --- Uncited entries ---

/**
 * Entries absorb read and cited nowhere that carry a commit or link no
 * article on the node has. A successful run marks every entry it read as
 * done (#762), so a fact in an entry the model passed over is gone from
 * the queue for good; the per-article "lost" check cannot see it because
 * no article points back at the entry.
 */
export function uncitedWithFacts(
  uncited: EvalEntry[],
  allArticles: string,
): Array<{ entry: string; facts: string[] }> {
  const lower = allArticles.toLowerCase()
  const known = extractFacts(allArticles).commits
  const out: Array<{ entry: string; facts: string[] }> = []
  for (const e of uncited) {
    const f = extractFacts(e.content)
    const missing = [
      ...f.commits.filter((c) => !hasCommit(lower, c, known)).map((c) => `commit ${c}`),
      ...f.urls.filter((u) => !lower.includes(urlKey(u))).map((u) => `link ${u}`),
    ]
    if (missing.length > 0) out.push({ entry: e.id, facts: missing })
  }
  return out
}

// --- Duplicates ---

export interface DuplicatePair {
  a: string
  b: string
  reason: "title" | "sources"
  score: number
}

const TITLE_STOP = new Set("the and for with from into of on in at to by an a".split(" "))

function titleTerms(title: string): Set<string> {
  return new Set(
    (title || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => (w.length > 1 || /\d/.test(w)) && !TITLE_STOP.has(w) && !STOP.has(w)),
  )
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * Pairs of articles that look like one subject filed twice: the same type
 * and near-identical title words, or most of their sources in common.
 * Only pairs touching `focus` are returned when it is given.
 */
export function findDuplicates(
  catalog: Array<{ path: string; title: string; type?: string; sources?: string[] }>,
  focus?: Set<string>,
  opts: { titleMin?: number; sourcesMin?: number } = {},
): DuplicatePair[] {
  const titleMin = opts.titleMin ?? 0.75
  const sourcesMin = opts.sourcesMin ?? 0.5
  const rows = catalog.map((a) => ({ ...a, tt: titleTerms(a.title), ss: new Set(a.sources ?? []) }))
  const pairs: DuplicatePair[] = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[i], y = rows[j]
      if (focus && !focus.has(x.path) && !focus.has(y.path)) continue
      const t = (x.type ?? "") === (y.type ?? "") ? jaccard(x.tt, y.tt) : 0
      if (t >= titleMin) { pairs.push({ a: x.path, b: y.path, reason: "title", score: t }); continue }
      if (x.ss.size >= 2 && y.ss.size >= 2) {
        const s = jaccard(x.ss, y.ss)
        if (s >= sourcesMin) pairs.push({ a: x.path, b: y.path, reason: "sources", score: s })
      }
    }
  }
  return pairs.sort((p, q) => q.score - p.score || p.a.localeCompare(q.a))
}

// --- Model judge ---

export interface JudgeVerdict {
  claims: number
  supported: number
  unsupported: string[]
  contradicted: string[]
  /** Cited entry ids that are about a different subject (a wrong merge). */
  offSubject: string[]
  /** Facts in the entries that belong in this article and are missing. */
  missing: string[]
  verdict: "good" | "minor" | "major"
}

/** Per-entry cap in the judge prompt, so one long transcript cannot crowd out the rest. */
export const JUDGE_ENTRY_CHARS = 4000

export function buildJudgePrompt(article: EvalArticle, entries: EvalEntry[]): string {
  const sourceBlock = entries
    .map((e) => {
      const body = e.content.length > JUDGE_ENTRY_CHARS ? `${e.content.slice(0, JUDGE_ENTRY_CHARS)}\n[…cut]` : e.content
      return `--- ENTRY ${e.id} [${e.date ?? ""}] ---\n${body}\n--- END ENTRY ---`
    })
    .join("\n\n")
  const earlier = article.previous
    ? `\n## Earlier version of the article (facts here count as supported)\n\n${article.previous}\n`
    : ""
  return `You are auditing one wiki article against the raw entries it cites. Do not use outside knowledge.

## Article: ${article.title} (${article.type ?? "untyped"}, ${article.path})

${article.content}
${earlier}
## Cited entries (${entries.length})

${sourceBlock || "(none)"}

## What to report

1. Split the article into factual claims (one per sentence or bullet; skip headings and "unknown" placeholders). Count them.
2. A claim is supported when a cited entry or the earlier version states it or plainly implies it. List each claim that is not supported, quoted briefly.
3. List each claim an entry contradicts.
4. List the cited entry ids that are about a different subject than the article (they were merged in by mistake).
5. List facts from the entries that belong in this article and are missing (names, numbers, identifiers, decisions). Ignore small talk.
6. Verdict: "good" (nothing wrong), "minor" (wording or a small omission), "major" (an unsupported or contradicted fact, a wrong merge, or a lost identifier).

Reply with JSON only, no fencing:
{"claims": 0, "supported": 0, "unsupported": [], "contradicted": [], "off_subject": [], "missing": [], "verdict": "good"}`
}

export function parseJudgeReply(value: unknown): JudgeVerdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const list = (x: unknown) => (Array.isArray(x) ? x.map((s) => String(s)) : [])
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : NaN)
  const claims = num(v.claims)
  if (Number.isNaN(claims)) return null
  const supported = Math.min(claims, Number.isNaN(num(v.supported)) ? claims - list(v.unsupported).length : num(v.supported))
  const verdict = v.verdict === "good" || v.verdict === "minor" || v.verdict === "major" ? v.verdict : null
  if (!verdict) return null
  return {
    claims,
    supported: Math.max(0, supported),
    unsupported: list(v.unsupported),
    contradicted: list(v.contradicted),
    offSubject: list(v.off_subject ?? v.offSubject),
    missing: list(v.missing),
    verdict,
  }
}

// --- Scorecard ---

export interface Scorecard {
  sample: { articles: number; seed: string; since?: string; byType: Record<string, number> }
  citations: { withSources: number; missingSources: number; weakSources: number; articlesWithWeak: number }
  grounding: { articlesWithUngrounded: number; ungroundedFacts: number }
  lost: { entriesWithLostFacts: number; lostFacts: number }
  duplicates: { pairs: number; articlesInPair: number }
  /** Entries read in the window that no article cites. */
  uncited?: { entries: number; withLostFacts: number }
  judge?: {
    judged: number
    claims: number
    supported: number
    supportRate: number
    unsupported: number
    contradicted: number
    articlesWithWrongMerge: number
    missingFacts: number
    verdicts: Record<"good" | "minor" | "major", number>
  }
  examples: {
    ungrounded: Array<{ path: string; facts: string[] }>
    lost: Array<{ path: string; entry: string; fact: string }>
    weak: Array<{ path: string; entries: string[] }>
    duplicates: DuplicatePair[]
    uncited: Array<{ entry: string; facts: string[] }>
    judged: Array<{ path: string; verdict: string; unsupported: string[]; contradicted: string[]; offSubject: string[]; missing: string[] }>
  }
}

export function buildScorecard(
  checks: ArticleCheck[],
  duplicates: DuplicatePair[],
  meta: { seed: string; since?: string },
  judged: Array<{ path: string; verdict: JudgeVerdict }> = [],
  maxExamples = 5,
  uncited?: { entries: number; lost: Array<{ entry: string; facts: string[] }> },
): Scorecard {
  const byType: Record<string, number> = {}
  for (const c of checks) byType[c.type ?? "untyped"] = (byType[c.type ?? "untyped"] ?? 0) + 1
  const lostEntries = new Set<string>()
  const lostKeys = new Set<string>()
  for (const c of checks) for (const l of c.lost) { lostEntries.add(l.entry); lostKeys.add(`${l.entry}|${l.fact}`) }
  const inPair = new Set(duplicates.flatMap((d) => [d.a, d.b]).filter((p) => checks.some((c) => c.path === p)))

  const card: Scorecard = {
    sample: { articles: checks.length, seed: meta.seed, since: meta.since, byType },
    citations: {
      withSources: checks.filter((c) => c.sources > 0).length,
      missingSources: checks.reduce((s, c) => s + c.missingSources.length, 0),
      weakSources: checks.reduce((s, c) => s + c.weakSources.length, 0),
      articlesWithWeak: checks.filter((c) => c.weakSources.length > 0).length,
    },
    grounding: {
      articlesWithUngrounded: checks.filter((c) => c.ungrounded.length > 0).length,
      ungroundedFacts: checks.reduce((s, c) => s + c.ungrounded.length, 0),
    },
    lost: { entriesWithLostFacts: lostEntries.size, lostFacts: lostKeys.size },
    duplicates: { pairs: duplicates.length, articlesInPair: inPair.size },
    ...(uncited ? { uncited: { entries: uncited.entries, withLostFacts: uncited.lost.length } } : {}),
    examples: {
      ungrounded: checks.filter((c) => c.ungrounded.length > 0).slice(0, maxExamples).map((c) => ({ path: c.path, facts: c.ungrounded.slice(0, 6) })),
      lost: checks.flatMap((c) => c.lost.map((l) => ({ path: c.path, ...l }))).slice(0, maxExamples),
      weak: checks.filter((c) => c.weakSources.length > 0).slice(0, maxExamples).map((c) => ({ path: c.path, entries: c.weakSources })),
      duplicates: duplicates.slice(0, maxExamples),
      uncited: (uncited?.lost ?? []).slice(0, maxExamples).map((u) => ({ entry: u.entry, facts: u.facts.slice(0, 4) })),
      judged: judged
        .filter((j) => j.verdict.verdict !== "good")
        .slice(0, maxExamples)
        .map((j) => ({
          path: j.path,
          verdict: j.verdict.verdict,
          unsupported: j.verdict.unsupported.slice(0, 4),
          contradicted: j.verdict.contradicted.slice(0, 4),
          offSubject: j.verdict.offSubject,
          missing: j.verdict.missing.slice(0, 4),
        })),
    },
  }

  if (judged.length > 0) {
    const v = judged.map((j) => j.verdict)
    const claims = v.reduce((s, x) => s + x.claims, 0)
    const supported = v.reduce((s, x) => s + x.supported, 0)
    card.judge = {
      judged: v.length,
      claims,
      supported,
      supportRate: claims > 0 ? supported / claims : 1,
      unsupported: v.reduce((s, x) => s + x.unsupported.length, 0),
      contradicted: v.reduce((s, x) => s + x.contradicted.length, 0),
      articlesWithWrongMerge: v.filter((x) => x.offSubject.length > 0).length,
      missingFacts: v.reduce((s, x) => s + x.missing.length, 0),
      verdicts: {
        good: v.filter((x) => x.verdict === "good").length,
        minor: v.filter((x) => x.verdict === "minor").length,
        major: v.filter((x) => x.verdict === "major").length,
      },
    }
  }
  return card
}

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "–")

/** The scorecard as Markdown, for the issue or a PR comment. */
export function renderScorecard(card: Scorecard): string {
  const n = card.sample.articles
  const lines = [
    `# Wiki absorb scorecard`,
    "",
    `Sample: ${n} articles (seed \`${card.sample.seed}\`${card.sample.since ? `, changed since ${card.sample.since}` : ""}). `
      + `Types: ${Object.entries(card.sample.byType).map(([t, k]) => `${t} ${k}`).join(", ") || "–"}.`,
    "",
    "| Check | Result | Lower is better? |",
    "|---|---|---|",
    `| Articles citing at least one entry | ${card.citations.withSources}/${n} (${pct(card.citations.withSources, n)}) | no |`,
    `| Cited ids with no entry | ${card.citations.missingSources} | yes |`,
    `| Articles with a weak citation (entry shares <${Math.round(WEAK_CITATION * 100)}% of its words) | ${card.citations.articlesWithWeak}/${n} (${pct(card.citations.articlesWithWeak, n)}) | yes |`,
    `| Articles with an ungrounded commit, link or number | ${card.grounding.articlesWithUngrounded}/${n} (${pct(card.grounding.articlesWithUngrounded, n)}) | yes |`,
    `| Ungrounded facts | ${card.grounding.ungroundedFacts} | yes |`,
    `| Commits or links lost from cited entries | ${card.lost.lostFacts} across ${card.lost.entriesWithLostFacts} entries | yes |`,
    `| Sampled articles in a likely duplicate pair | ${card.duplicates.articlesInPair}/${n} (${pct(card.duplicates.articlesInPair, n)}) | yes |`,
  ]
  if (card.uncited) {
    lines.push(
      `| Entries read in the window but cited by no article | ${card.uncited.entries} | – |`,
      `| …of which carry a commit or link no article has | ${card.uncited.withLostFacts} | yes |`,
    )
  }
  if (card.judge) {
    const j = card.judge
    lines.push(
      `| Judge: claims supported by the cited entries | ${j.supported}/${j.claims} (${pct(j.supported, j.claims)}) | no |`,
      `| Judge: unsupported / contradicted claims | ${j.unsupported} / ${j.contradicted} | yes |`,
      `| Judge: articles with an off-subject source (wrong merge) | ${j.articlesWithWrongMerge}/${j.judged} (${pct(j.articlesWithWrongMerge, j.judged)}) | yes |`,
      `| Judge: facts missing from the article | ${j.missingFacts} | yes |`,
      `| Judge verdicts good / minor / major | ${j.verdicts.good} / ${j.verdicts.minor} / ${j.verdicts.major} | – |`,
    )
  }
  const ex = card.examples
  const section = (title: string, rows: string[]) => {
    if (rows.length === 0) return
    lines.push("", `## ${title}`, "", ...rows)
  }
  section("Examples: ungrounded facts", ex.ungrounded.map((e) => `- \`${e.path}\`: ${e.facts.join("; ")}`))
  section("Examples: lost facts", ex.lost.map((e) => `- \`${e.path}\` ← entry \`${e.entry}\`: ${e.fact}`))
  section("Examples: weak citations", ex.weak.map((e) => `- \`${e.path}\`: ${e.entries.map((x) => `\`${x}\``).join(", ")}`))
  section("Examples: uncited entries with facts no article has", ex.uncited.map((u) => `- \`${u.entry}\`: ${u.facts.join("; ")}`))
  section("Examples: likely duplicates", ex.duplicates.map((d) => `- \`${d.a}\` ↔ \`${d.b}\` (${d.reason}, ${d.score.toFixed(2)})`))
  section(
    "Examples: judge findings",
    ex.judged.map((e) => {
      const parts = [
        e.unsupported.length ? `unsupported: ${e.unsupported.join(" | ")}` : "",
        e.contradicted.length ? `contradicted: ${e.contradicted.join(" | ")}` : "",
        e.offSubject.length ? `off-subject: ${e.offSubject.join(", ")}` : "",
        e.missing.length ? `missing: ${e.missing.join(" | ")}` : "",
      ].filter(Boolean)
      return `- \`${e.path}\` (${e.verdict}): ${parts.join("; ")}`
    }),
  )
  lines.push(
    "",
    "## Method",
    "",
    "- The sample is drawn with a seeded shuffle from the articles changed in the window, so the same seed and window give the same articles.",
    "- Ungrounded: a commit hash, link or number (three digits or more, or a date) in the article that no cited entry and no earlier version of the article contains.",
    "- Lost: a commit hash or link in a cited entry that no article citing that entry contains.",
    "- Uncited: entries the absorb ledger marks as read in the window that no article cites; those carrying a commit or link that no article on the node has are counted as lost, since absorb will not offer them again.",
    "- Weak citation: a cited entry sharing fewer than 15% of its distinctive words with the article.",
    "- Duplicate: two articles of the same type whose titles share at least 75% of their words, or which share at least half their sources.",
    "- Judge (optional): one model call per article reads the article and its cited entries and lists unsupported, contradicted, off-subject and missing items.",
  )
  return lines.join("\n") + "\n"
}

// --- Run telemetry ---

/** One compile call, as appended to `_absorb-runs.jsonl`. */
export interface AbsorbCallRecord {
  kind: "call"
  at: string
  label?: string
  agent: string
  model: string
  entries: number
  articles: number
  refused: number
  /** Entries held by a refused save that another saved article cites:
   *  they leave the queue, so the refused update is never retried. */
  heldCited?: number
  /** Wiki notes (#831) the call was given, patched, and recorded. */
  notes?: number
  notesPatched?: number
  notesRecorded?: number
  failed: boolean
  /** The model call alone. */
  wallMs: number
  /** Retrieval, fact lookups and prompt building before the call. */
  prepMs?: number
  promptChars: number
  promptParts?: Record<string, number>
  costUsd?: number
  apiMs?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One whole `wiki absorb` invocation. */
export interface AbsorbRunRecord {
  kind: "run"
  label?: string
  startedAt: string
  endedAt: string
  max: number
  model: string
}

/** Cost and timing fields from the claude CLI's `--output-format json` envelope. */
export function envelopeUsage(envelope: unknown): Partial<AbsorbCallRecord> {
  if (!envelope || typeof envelope !== "object") return {}
  const e = envelope as Record<string, any>
  const u = (e.usage ?? {}) as Record<string, unknown>
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined)
  return {
    costUsd: n(e.total_cost_usd) ?? n(e.cost_usd),
    apiMs: n(e.duration_api_ms),
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
  }
}

export interface RunSummary {
  label: string
  calls: number
  failed: number
  entries: number
  articles: number
  refused: number
  heldCited: number
  /** First call start to last call end, or the run records' span when present. */
  wallMs: number
  callMsP50: number
  callMsP95: number
  /** Time spent before the model calls, summed. */
  prepMs: number
  costUsd: number
  costPerEntry: number
  entriesPerMinute: number
  promptChars: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

/** Totals per run label from the telemetry lines. Calls without a label group under "(none)". */
export function summariseRuns(records: Array<AbsorbCallRecord | AbsorbRunRecord>): RunSummary[] {
  const groups = new Map<string, { calls: AbsorbCallRecord[]; runs: AbsorbRunRecord[] }>()
  const group = (label?: string) => {
    const key = label || "(none)"
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { calls: [], runs: [] }))
    return g
  }
  for (const r of records) {
    if (r.kind === "call") group(r.label).calls.push(r)
    else if (r.kind === "run") group(r.label).runs.push(r)
  }
  const out: RunSummary[] = []
  for (const [label, { calls, runs }] of groups) {
    if (calls.length === 0) continue
    const ms = calls.map((c) => c.wallMs).sort((a, b) => a - b)
    let wallMs: number
    if (runs.length > 0) {
      wallMs = runs.reduce((s, r) => s + (Date.parse(r.endedAt) - Date.parse(r.startedAt)), 0)
    } else {
      const starts = calls.map((c) => Date.parse(c.at) - c.wallMs)
      const ends = calls.map((c) => Date.parse(c.at))
      wallMs = Math.max(...ends) - Math.min(...starts)
    }
    const entries = calls.reduce((s, c) => s + c.entries, 0)
    const costUsd = calls.reduce((s, c) => s + (c.costUsd ?? 0), 0)
    out.push({
      label,
      calls: calls.length,
      failed: calls.filter((c) => c.failed).length,
      entries,
      articles: calls.reduce((s, c) => s + c.articles, 0),
      refused: calls.reduce((s, c) => s + c.refused, 0),
      heldCited: calls.reduce((s, c) => s + (c.heldCited ?? 0), 0),
      wallMs,
      callMsP50: percentile(ms, 0.5),
      callMsP95: percentile(ms, 0.95),
      prepMs: calls.reduce((s, c) => s + (c.prepMs ?? 0), 0),
      costUsd,
      costPerEntry: entries > 0 ? costUsd / entries : 0,
      entriesPerMinute: wallMs > 0 ? (entries / wallMs) * 60_000 : 0,
      promptChars: calls.reduce((s, c) => s + c.promptChars, 0),
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}
