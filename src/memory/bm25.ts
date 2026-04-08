// --- BM25 scoring engine — zero dependencies ---
// Drop-in replacement for word-overlap relevance scoring.
// Standard Okapi BM25 with k1=1.2, b=0.75.

export interface BM25Index {
  docCount: number
  avgDocLen: number
  /** term → number of documents containing it */
  df: Map<string, number>
  /** docIndex → Map<term, frequency> */
  tf: Map<number, Map<string, number>>
  /** per-document token count */
  docLens: number[]
}

export interface BM25Options {
  k1?: number // term frequency saturation, default 1.2
  b?: number // length normalization, default 0.75
}

export const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "about", "through",
  "and", "but", "or", "not", "no", "if", "then", "so", "what", "how",
  "when", "where", "who", "which", "that", "this", "it", "i", "you",
  "we", "they", "he", "she", "me", "my", "your", "our", "their",
  "please", "just", "also", "very", "much", "some", "any", "all",
])

/**
 * Tokenize text: lowercase, split on non-alphanumeric, drop stop words and short tokens.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
}

/**
 * Build a BM25 inverted index over a corpus of documents.
 */
export function buildIndex(docs: string[]): BM25Index {
  const df = new Map<string, number>()
  const tf = new Map<number, Map<string, number>>()
  const docLens: number[] = []
  let totalLen = 0

  for (let i = 0; i < docs.length; i++) {
    const tokens = tokenize(docs[i])
    docLens.push(tokens.length)
    totalLen += tokens.length

    const termFreq = new Map<string, number>()
    const seen = new Set<string>()

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1)
      if (!seen.has(token)) {
        df.set(token, (df.get(token) ?? 0) + 1)
        seen.add(token)
      }
    }

    tf.set(i, termFreq)
  }

  return {
    docCount: docs.length,
    avgDocLen: docs.length > 0 ? totalLen / docs.length : 0,
    df,
    tf,
    docLens,
  }
}

/**
 * Score a single document against a query using BM25.
 */
export function score(
  query: string,
  docIndex: number,
  index: BM25Index,
  opts?: BM25Options,
): number {
  const k1 = opts?.k1 ?? 1.2
  const b = opts?.b ?? 0.75
  const queryTokens = tokenize(query)
  const docTf = index.tf.get(docIndex)
  if (!docTf) return 0

  const docLen = index.docLens[docIndex]
  let total = 0

  for (const term of queryTokens) {
    const termDf = index.df.get(term) ?? 0
    if (termDf === 0) continue

    const termTf = docTf.get(term) ?? 0
    if (termTf === 0) continue

    // IDF with +1 inside ln() to prevent negative values
    const idf = Math.log(
      (index.docCount - termDf + 0.5) / (termDf + 0.5) + 1,
    )

    // BM25 term score
    const tfNorm =
      (termTf * (k1 + 1)) /
      (termTf + k1 * (1 - b + b * (docLen / index.avgDocLen)))

    total += idf * tfNorm
  }

  return total
}

/**
 * Score all documents against a query. Returns sorted descending, zero-score docs excluded.
 */
export function scoreAll(
  query: string,
  index: BM25Index,
  opts?: BM25Options,
): Array<{ docIndex: number; score: number }> {
  const results: Array<{ docIndex: number; score: number }> = []

  for (let i = 0; i < index.docCount; i++) {
    const s = score(query, i, index, opts)
    if (s > 0) {
      results.push({ docIndex: i, score: s })
    }
  }

  return results.sort((a, b) => b.score - a.score)
}
