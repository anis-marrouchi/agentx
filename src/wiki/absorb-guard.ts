// What `agentx wiki absorb` may not lose when it rewrites an article.
//
// An UPDATE replaces the whole article body. In the 2026-10-07 A/B, Opus
// rewrote the #198 review article without having seen it and would have
// dropped commit 1a01e02, the comment URL and the 16/16 test count; only
// the version history kept them. The prompt now shows the model the
// article it updates, and this check refuses a save that still drops a
// commit, a link or a number the old article carried.

import type { WikiArticleMeta } from "./types"

export interface DroppedFacts {
  commits: string[]
  links: string[]
  numbers: string[]
}

const URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+/g
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g
// A hex run of 7–40 with at least one digit and one letter: a commit SHA,
// not a word like "defaced" or a plain number.
const COMMIT_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi
// Digit runs joined by . , / : - — "16/16", "20,000", "2026-09-27", "0.115.0".
const NUMBER_RE = /\d+(?:[.,/:-]\d+)*/g
const LIST_MARKER_RE = /^(\s*)\d+[.)]\s/gm

/** The commits, links and numbers in `before` that `after` no longer has.
 *  Pass title + body for both; frontmatter lists are merged separately. */
export function droppedFacts(before: string, after: string): DroppedFacts {
  const afterLower = after.toLowerCase()
  const afterLinks = new Set(wikilinks(after))
  const afterNumbers = numberText(after)

  const commits = unique(before.match(COMMIT_RE) ?? [])
    .filter((sha) => !afterLower.includes(sha.toLowerCase()))
  const urls = unique((before.match(URL_RE) ?? []).map(trimUrl))
    .filter((url) => !after.includes(url))
  const links = unique(wikilinks(before)).filter((t) => !afterLinks.has(t))
  const numbers = unique(numberTokens(before))
    .filter((n) => !new RegExp(`(?<!\\d)(?<!\\d[.,/:-])${escape(n)}(?!\\d)(?![.,/:-]\\d)`).test(afterNumbers))

  return { commits, links: [...urls, ...links.map((t) => `[[${t}]]`)], numbers }
}

export function hasDrops(d: DroppedFacts): boolean {
  return d.commits.length + d.links.length + d.numbers.length > 0
}

export function describeDrops(d: DroppedFacts): string {
  const parts: string[] = []
  if (d.commits.length) parts.push(`commits ${d.commits.join(", ")}`)
  if (d.links.length) parts.push(`links ${d.links.join(", ")}`)
  if (d.numbers.length) parts.push(`numbers ${d.numbers.join(", ")}`)
  return parts.join("; ")
}

/** Frontmatter for an UPDATE: the model's fields, with the old article's
 *  creation date, access and graph path kept, and its sources and related
 *  links unioned rather than replaced. */
export function mergeUpdateMeta(old: WikiArticleMeta, next: WikiArticleMeta): WikiArticleMeta {
  return {
    ...next,
    access: old.access,
    sharedWith: old.sharedWith,
    created: old.created || next.created,
    sources: unique([...(old.sources ?? []), ...(next.sources ?? [])]),
    related: unique([...(old.related ?? []), ...(next.related ?? [])]),
    graphPath: next.graphPath?.length ? next.graphPath : old.graphPath,
  }
}

function wikilinks(text: string): string[] {
  return [...text.matchAll(WIKILINK_RE)].map((m) => m[1].trim().toLowerCase())
}

/** Numbers outside URLs and commits (those are checked whole), and not the
 *  markers of a numbered list, which a rewrite renumbers freely. */
function numberText(text: string): string {
  return text
    .replace(URL_RE, " ")
    .replace(COMMIT_RE, " ")
    .replace(LIST_MARKER_RE, "$1")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
}

function numberTokens(text: string): string[] {
  return numberText(text).match(NUMBER_RE) ?? []
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, "")
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}
