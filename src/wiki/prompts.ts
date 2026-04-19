import type { WikiMode } from "./hub"

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
