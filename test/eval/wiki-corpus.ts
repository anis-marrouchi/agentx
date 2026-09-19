import { readdirSync, readFileSync, statSync, existsSync } from "fs"
import { join, relative } from "path"

// Shared wiki corpus + ground truth for the retrieval evals.
//
// Extracted so the BM25 baseline and the Jev re-ranking arm grade against
// the SAME expectations. Two copies of the test cases would drift, and a
// re-ranker measured against its own private ground truth measures
// nothing.

export interface Article {
  path: string
  title: string
  tags: string[]
  content: string
}


export function walkDir(dir: string, cb: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walkDir(full, cb)
    else cb(full)
  }
}


export function parseArticle(filePath: string): Article | null {
  try {
    const raw = readFileSync(filePath, "utf-8")
    // Parse YAML frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!fmMatch) return null

    const fm = fmMatch[1]
    const content = fmMatch[2]

    const titleMatch = fm.match(/title:\s*"([^"]*)"/)
    const tagsMatch = fm.match(/tags:\s*\[(.*?)\]/)

    const title = titleMatch?.[1] ?? ""
    const tags = tagsMatch
      ? tagsMatch[1].split(",").map((t) => t.trim().replace(/"/g, ""))
      : []

    return { path: filePath, title, tags, content }
  } catch {
    return null
  }
}


export interface RealTestCase {
  name: string
  query: string
  /** The correct article's title must contain this (case-insensitive) */
  expectedTitleContains: string
  /** Category for reporting */
  category: "infra" | "incident" | "people" | "project" | "cross-agent" | "synonym"
}


export const REAL_CASES: RealTestCase[] = [
  // --- Infrastructure queries ---
  {
    name: "mtgl staging deployment steps",
    query: "how do I deploy mtgl to staging",
    expectedTitleContains: "MTGL DevOps Environment",
    category: "infra",
  },
  {
    name: "noqta website deploy pipeline",
    query: "how does noqta.tn deployment work",
    expectedTitleContains: "Noqta.tn Website",
    category: "infra",
  },
  {
    name: "elevenlabs voice integration",
    query: "what is the elevenlabs meet voice pipeline spike",
    expectedTitleContains: "ElevenLabs",
    category: "infra",
  },

  // --- Incident queries ---
  {
    name: "gitlab token expired",
    query: "gitlab token expired what happened",
    expectedTitleContains: "GITLAB_TOKEN Expired",
    category: "incident",
  },
  {
    name: "whatsapp echo loop",
    query: "whatsapp bot sending messages to itself in a loop",
    expectedTitleContains: "WhatsApp Echo Loop",
    category: "incident",
  },
  {
    name: "gitlab token renewal process",
    query: "how to renew the gitlab personal access token",
    expectedTitleContains: "GITLAB_TOKEN Expired",
    category: "incident",
  },

  // --- People queries ---
  {
    name: "who is seif",
    query: "who is seif al-arabi and what does he do",
    expectedTitleContains: "Seif al-Arabi",
    category: "people",
  },

  // --- Agent queries ---
  {
    name: "what does atlas do",
    query: "what is atlas agent responsible for",
    expectedTitleContains: "Atlas",
    category: "cross-agent",
  },

  // --- Project queries ---
  {
    name: "seo keywords noqta",
    query: "what are our SEO keyword targets for noqta.tn",
    expectedTitleContains: "SEO Priorities",
    category: "project",
  },

  // --- Synonym/indirect queries (harder) ---
  {
    name: "bot stuck in loop",
    query: "the bot keeps repeating itself what is wrong",
    expectedTitleContains: "Echo Loop",
    category: "synonym",
  },
  {
    name: "server credentials",
    query: "what are the database credentials for mtgl",
    expectedTitleContains: "MTGL DevOps Environment",
    category: "synonym",
  },
  {
    name: "CI pipeline stages",
    query: "what are the CI pipeline stages for the website",
    expectedTitleContains: "Noqta.tn Website",
    category: "synonym",
  },
]

/** Grades retrieval against the operator's OWN wiki, so it only means
 *  anything on a machine that has one. A clean checkout has no
 *  .agentx/wiki. */
export const WIKI_DIR = join(process.cwd(), ".agentx/wiki")
export const hasWiki = existsSync(WIKI_DIR)

/** Load the corpus the way wiki findRelevant sees it. */
export function loadCorpus(): { articles: Article[]; docs: string[] } {
  const articles: Article[] = []
  walkDir(WIKI_DIR, (filePath) => {
    if (!filePath.endsWith(".md")) return
    const rel = relative(WIKI_DIR, filePath)
    if (rel.includes("/raw/") || rel.startsWith("_")) return
    const base = filePath.split("/").pop() ?? ""
    if (["WIKI.md", "log.md", "worldview.md"].includes(base)) return
    if (base.startsWith("_")) return
    const article = parseArticle(filePath)
    if (article) articles.push(article)
  })
  const docs = articles.map((a) => `${a.title} ${a.tags.join(" ")} ${a.content}`)
  return { articles, docs }
}

/** Does any of the top-k carry the expected title? */
export function isHit(
  articles: Article[],
  ranked: number[],
  expectedTitle: string,
  k: number,
): boolean {
  return ranked
    .slice(0, k)
    .some((idx) => articles[idx].title.toLowerCase().includes(expectedTitle.toLowerCase()))
}
