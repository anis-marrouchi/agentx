import type { WikiMode } from "./hub"
import type { PromotionCluster } from "./promote"

/**
 * Farzapedia-faithful absorb prompt.
 *
 * Replaces the legacy three-mode design (flat/graph/unified) with one prompt
 * that mirrors what Karpathy and Farza describe: article `type` is the
 * organizational spine, `[[wikilinks]]` are the navigation surface, tags are
 * a secondary hint. The LLM chooses paths and cross-references; it does not
 * produce a sprawling per-article tag cloud.
 *
 * The mode parameter is kept in the signature for backwards compatibility but
 * all values resolve to the same prompt — retained callers (hub.ts, wiki CLI)
 * still pass a mode but it no longer changes behavior.
 */
export function buildAbsorbPrompt(
  _mode: WikiMode,
  agentId: string,
  worldview: string,
  existingArticles: Array<{ title: string; path: string; type?: string; tags?: string[] }>,
  entryTexts: string,
  entryCount: number,
): string {
  return buildFarzapediaPrompt(agentId, worldview, existingArticles, entryTexts, entryCount)
}

function buildFarzapediaPrompt(
  agentId: string,
  worldview: string,
  existingArticles: Array<{ title: string; path: string; type?: string; tags?: string[] }>,
  entryTexts: string,
  entryCount: number,
): string {
  const worldviewSection = worldview ? `\n## Worldview\n\n${worldview}\n` : ""

  // Group the existing index by type so the LLM sees the structure.
  const byType = new Map<string, typeof existingArticles>()
  for (const a of existingArticles) {
    const t = a.type || "untyped"
    const list = byType.get(t) || []
    list.push(a)
    byType.set(t, list)
  }
  const existingList = existingArticles.length === 0 ? "" :
    "\n## Existing Articles (the current catalog)\n\n" +
    Array.from(byType.entries()).sort()
      .map(([type, arr]) =>
        `**${type}**\n` +
        arr.sort((x, y) => x.title.localeCompare(y.title))
          .map(a => `- [[${a.title}]] — ${a.path}`)
          .join("\n")
      ).join("\n\n") + "\n"

  return `You are compiling a personal wiki for the "${agentId}" agent in the Karpathy / Farzapedia pattern.

## The Pattern (read this first — it shapes every decision below)

The wiki is a compounding knowledge base of interlinked markdown articles that a future LLM will read by walking the graph, NOT by bag-of-words search. Your job is to produce articles that another agent can navigate via \`type\` + wikilinks. If the wikilinks don't form a coherent graph, the wiki is useless regardless of how many tags you add.

**Three rules, in priority order:**

1. **\`type\` is the organizational spine.** Every article has exactly one of: \`person | project | place | concept | event | decision | pattern\`. Choose the type BEFORE writing; if you can't pick one, the article probably isn't needed.
2. **\`related\` is the navigation surface.** Every article cross-references 2–5 other articles via \`[[Article Title]]\` wikilinks in the body AND lists them in the \`related\` frontmatter field. Links the reader could follow to learn more.
3. **Tags are a secondary hint, not a retrieval spine.** 2–4 specific tags max. Do NOT tag aggressively. Do NOT tag with dates unless the article is an \`event\`. Do NOT tag with generic terms ("deploy", "work") that will match half the corpus.

## Path convention

Path reflects type: \`<type>s/<slug>.md\` where slug is a kebab-case title.

- People: \`people/anis-marrouchi.md\`
- Projects: \`projects/mtgl-system-v2.md\`
- Concepts: \`concepts/staging-deployment.md\`
- Events: \`events/YYYY-MM-DD-<slug>.md\` (date in path)
- Decisions: \`decisions/<slug>.md\`
- Patterns: \`patterns/<slug>.md\`
- Places: \`places/<slug>.md\`

## How to process entries

For each of the ${entryCount} raw entries below, ask in this order:

1. **Does it extend an existing article?** If a person/project/concept mentioned in the entry already has an article in the catalog, produce an UPDATE with the full merged content. Prefer merging over proliferating.
2. **Does it deserve a new article?** Only if the subject is a persistent entity (a person, a project, a recurring concept, a specific event/decision) that future queries will need to find. Not every conversation deserves an article.
3. **Does it belong in an existing \`event\` or \`decision\`?** Most work entries fold into one of these.
4. **Can you skip it?** If the entry is small talk, a transient status ping, or already covered elsewhere — skip. The wiki is curated, not exhaustive.

## Writing standards

- **Wikipedia-style, flat, factual, encyclopedic.** This is the agent's knowledge, not a diary. Write about the *role* of the entity in our work, not a product description.
- **Synthesize, don't quote.** At most 2 short quoted lines per article.
- **Organize by theme, not chronology.** An article about a person lists what they do, who they work with, how they prefer to be contacted — not a log of every interaction.
- **Length: 20–100 lines.** Articles exceeding 100 lines should split into multiple type-specific articles.
- **Every paragraph earns its place.** Cut narrative filler. If you can remove a sentence without losing a fact, remove it.

## Wikilink discipline

- Use \`[[Article Title]]\` **inside the body** every time another tracked entity is referenced.
- List those same targets in the \`related\` frontmatter field.
- If you reference something that has no article yet (\`[[New Thing]]\`), add "New Thing" to the output \`gaps\` array so the next pass can create it.

## Article frontmatter (exact shape — do not invent fields)

\`\`\`yaml
---
title: "Article Title"
type: person | project | place | concept | event | decision | pattern
related: ["Other Article", "Another Article"]
tags: ["2-4-specific-tags", "no-dates-unless-event"]
owner: ${agentId}
access: public | shared | private
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
sources: ["entry-id-1", "entry-id-2"]
---
\`\`\`

Access guidance: default \`public\`; \`private\` only for sensitive credentials or agent-specific learnings; \`shared\` with specific agent IDs when the article matters only to a subset.
${worldviewSection}${existingList}
## Gap Detection

After compiling, populate a \`gaps\` array: wikilink targets you referenced but for which no article exists yet. Be specific:

- Good: "Karim Rahmouni — coach for Tunis Padel club, mentioned twice but no \`people/\` article"
- Bad: "We need more content about deployments"

## Output — valid JSON only, no markdown fencing

\`\`\`
{
  "articles": [
    {
      "path": "projects/mtgl-system-v2.md",
      "title": "MTGL System V2",
      "type": "project",
      "related": ["Anis Marrouchi", "Laravel", "Staging Deployment"],
      "tags": ["mtgl", "laravel", "react"],
      "content": "MTGL System V2 is [[Anis Marrouchi]]'s production Laravel + React app for …",
      "sources": ["entry-id-1", "entry-id-2"]
    }
  ],
  "gaps": [
    "Karim Rahmouni — Tunis Padel coach, mentioned in entries but no people/ article"
  ]
}
\`\`\`

ENTRIES (${entryCount}):

${entryTexts}`
}

/** Max chars of a memory body shown to the promotion judge. */
export const PROMOTE_BODY_LIMIT = 2000

/** Past this catalog size, list titles only (no paths) to bound the prompt. */
const PROMOTE_CATALOG_LIMIT = 300

/**
 * Memory→wiki promotion prompt. Mirrors the Farzapedia absorb prompt's
 * skeleton (type spine, path convention, wikilink discipline, gaps) but
 * judges per-agent MEMORIES instead of raw entries: promote only durable,
 * cross-agent-relevant facts into the shared wiki.
 *
 * The LLM does NOT emit frontmatter — the caller sets owner/access/dates/
 * sources itself, which removes a whole class of hallucination. Candidates
 * are referenced only by their exact stamp strings.
 */
export function buildMemoryPromotePrompt(
  ownerId: string,
  clusters: PromotionCluster[],
  existingArticles: Array<{ title: string; path: string; type?: string }>,
  worldview: string,
): string {
  const worldviewSection = worldview ? `\n## Worldview\n\n${worldview}\n` : ""

  const byType = new Map<string, typeof existingArticles>()
  for (const a of existingArticles) {
    const t = a.type || "untyped"
    const list = byType.get(t) || []
    list.push(a)
    byType.set(t, list)
  }
  const titlesOnly = existingArticles.length > PROMOTE_CATALOG_LIMIT
  const existingList = existingArticles.length === 0 ? "" :
    `\n## Existing Articles (the current catalog${titlesOnly ? `, ${existingArticles.length} articles — titles only` : ""})\n\n` +
    Array.from(byType.entries()).sort()
      .map(([type, arr]) =>
        `**${type}**\n` +
        arr.sort((x, y) => x.title.localeCompare(y.title))
          .map(a => titlesOnly ? `- [[${a.title}]]` : `- [[${a.title}]] — ${a.path}`)
          .join("\n")
      ).join("\n\n") + "\n"

  const candidateCount = clusters.reduce((n, c) => n + c.candidates.length, 0)
  const candidateBlocks = clusters.map(cluster => {
    const corroboration = cluster.corroboratingAgents.length > 1
      ? `corroborated by: ${cluster.corroboratingAgents.join(", ")} (${cluster.corroboratingAgents.length} agents)`
      : `single agent: ${cluster.corroboratingAgents[0]}`
    return cluster.candidates.map(c => {
      const body = c.memory.body.length > PROMOTE_BODY_LIMIT
        ? c.memory.body.slice(0, PROMOTE_BODY_LIMIT) + "\n[… truncated]"
        : c.memory.body
      return [
        `--- CANDIDATE ${c.stamp} ---`,
        `type: ${c.memory.type} | agent: ${c.agentId} | ${corroboration} | confidence: ${cluster.confidence.toFixed(2)}`,
        `description: ${c.memory.description}`,
        body,
        `--- END CANDIDATE ---`,
      ].join("\n")
    }).join("\n\n")
  }).join("\n\n")

  return `You are promoting per-agent experiential memories into the shared, authoritative AgentX wiki (owner: "${ownerId}").

## The Job

Memory is "what one agent learned"; the wiki is "what every agent should know." For each candidate memory below, decide: promote it into a wiki article, or skip it with a reason.

**The promotion test — apply in order, skip on the first "no":**

1. **Durable?** Will this still be true in 3 months? Transient state, one-off task context, and dated status pings fail here.
2. **Cross-agent?** Would a DIFFERENT agent benefit from knowing this? Facts about shared infrastructure, projects, people, and conventions pass; one agent's private workflow habits fail.
3. **A fact, not a preference?** Personal style preferences private to one agent's operator relationship fail.
4. **Never a secret.** Credentials, tokens, keys, and passwords are NEVER promoted — skip with reason "contains secret". Pointers to where a secret lives (e.g. "SSH config is in X") are fine; the secret itself is not.

Corroboration across agents (shown per candidate) is a confidence signal, not a requirement — a single-agent memory that passes the test above should be promoted.

**Three rules for the articles you write, in priority order:**

1. **\`type\` is the organizational spine.** Every article has exactly one of: \`person | project | place | concept | event | decision | pattern\`. Choose the type BEFORE writing; if you can't pick one, skip the memory instead.
2. **\`related\` is the navigation surface.** Every article cross-references 2–5 other articles via \`[[Article Title]]\` wikilinks in the body AND lists them in the \`related\` output field. Links the reader could follow to learn more.
3. **Tags are a secondary hint.** 2–4 specific tags max. No dates unless the article is an \`event\`. No generic terms ("deploy", "work").

## Path convention

Path reflects type: \`<type>s/<slug>.md\` where slug is a kebab-case title.

- People: \`people/anis-marrouchi.md\`
- Projects: \`projects/mtgl-system-v2.md\`
- Concepts: \`concepts/staging-deployment.md\`
- Events: \`events/YYYY-MM-DD-<slug>.md\` (date in path)
- Decisions: \`decisions/<slug>.md\`
- Patterns: \`patterns/<slug>.md\`
- Places: \`places/<slug>.md\`

## Merge over create

If a candidate extends an article in the catalog below, emit an UPDATE at the EXISTING path with the full merged content. Prefer merging over proliferating. Several candidates about the same entity should fold into ONE article.

## Writing standards

- **Wikipedia-style, flat, factual, encyclopedic.** Write about the entity's role in our work, not a diary of how the memory was learned.
- **Synthesize, don't quote.** At most 2 short quoted lines per article.
- **Length: 20–100 lines.**
- **Every paragraph earns its place.**

## Gap Detection

Populate a \`gaps\` array: wikilink targets you referenced but for which no article exists yet. Be specific ("Karim Rahmouni — coach mentioned twice, no people/ article"), not vague ("need more deploy content").
${worldviewSection}${existingList}
## Output — valid JSON only, no markdown fencing

Reference candidates ONLY by their exact stamp strings (the \`memory:...\` line in each CANDIDATE header). Every candidate must appear in exactly one of \`articles[].promotedFrom\` or \`skipped\`. Do NOT emit frontmatter, owner, access, dates, or sources — the caller sets those.

\`\`\`
{
  "articles": [
    {
      "path": "concepts/mtgl-staging-deploy.md",
      "title": "MTGL Staging Deploy",
      "type": "concept",
      "related": ["MTGL System V2", "Staging Deployment"],
      "tags": ["mtgl", "deploy"],
      "content": "Deploys to [[MTGL System V2]] staging go through …",
      "promotedFrom": ["memory:coder-agent/project_mtgl_deploy@2026-07-01T22:14:03.000Z"]
    }
  ],
  "skipped": [
    { "memory": "memory:cx/feedback_short_replies@2026-06-01T00:00:00.000Z", "reason": "agent-specific style preference, not a cross-agent fact" }
  ],
  "gaps": []
}
\`\`\`

CANDIDATES (${candidateCount} memories in ${clusters.length} clusters):

${candidateBlocks}`
}
