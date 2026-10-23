import { parseRef } from "../checkers/issue"

// --- The issues a merged merge request names (#1138 step F) ---
//
// A merge request closes an issue when its title or description says so
// with a closing word ("Closes #12", "Fixes group/app#3", "Resolves
// <issue address>"), or when its branch is named after the issue
// ("12-fix-login", the fleet's branch convention). Any other mention
// ("Refs #12", "part of #12", a bare "#12") is only a reference: a step of
// a larger issue merging does not make that issue done, so a reference is
// never a drift.

export type Provider = "github" | "gitlab"

export interface IssueLink {
  /** "group/project" or "owner/repo". */
  project: string
  number: number
  /** Named with a closing word, or by the branch. */
  closes: boolean
}

// GitLab's default closing pattern, and GitHub's words.
const CLOSING = String.raw`(?:clos(?:e|es|ed|ing)|fix(?:|es|ed|ing)|resolv(?:e|es|ed|ing)|implement(?:|s|ed|ing))`
// One issue: an address, "group/project#12", or "#12". A "#" right after a
// word character or "&" is not one ("abc#1", "&#39;").
const REF = String.raw`(?:https?:\/\/[^\s<>()\[\]]+\/(?:-\/)?issues\/\d+|(?:[\w.-]+\/)+[\w.-]+#\d+|(?<![\w&])#\d+)`
const REF_RE = new RegExp(REF, "gi")
// The closing word, then a list of refs joined by commas, "and" or "&".
const CLOSING_LIST_RE = new RegExp(String.raw`\b${CLOSING}\b:?\s+(?:issues?\s+)?(${REF}(?:\s*(?:,|\band\b|&)\s*${REF})*)`, "gi")

const BRANCH_RE = /^(\d+)-[\w.-]/

/** One ref as a link, on the merge request's own project when it names
 *  no other. Null: not an issue of this provider. */
function toLink(provider: Provider, project: string, raw: string): Omit<IssueLink, "closes"> | null {
  const bare = raw.match(/^#(\d+)$/)
  if (bare) return { project, number: Number(bare[1]) }
  const parsed = parseRef(provider, raw.replace(/[.,;:]+$/, ""))
  return parsed && !parsed.mr ? { project: parsed.project, number: parsed.number } : null
}

/** The issues a merge request names, each once, closing first. */
export function issueLinks(
  provider: Provider,
  project: string,
  mr: { title?: string; description?: string; branch?: string },
): IssueLink[] {
  const text = `${mr.title ?? ""}\n${mr.description ?? ""}`
  const out = new Map<string, IssueLink>()
  const add = (l: Omit<IssueLink, "closes"> | null, closes: boolean) => {
    if (!l || !Number.isSafeInteger(l.number) || l.number <= 0) return
    const key = `${l.project.toLowerCase()}#${l.number}`
    const had = out.get(key)
    out.set(key, { ...l, closes: closes || !!had?.closes })
  }
  for (const m of text.matchAll(CLOSING_LIST_RE)) {
    for (const r of m[1].matchAll(REF_RE)) add(toLink(provider, project, r[0]), true)
  }
  for (const r of text.matchAll(REF_RE)) add(toLink(provider, project, r[0]), false)
  // The branch closes its issue unless the text names that issue only as
  // a reference: a step of an epic is branched after the epic
  // ("1138-reach", "Part of #1138") and does not finish it.
  const branch = mr.branch?.match(BRANCH_RE)
  if (branch && !out.has(`${project.toLowerCase()}#${Number(branch[1])}`)) add({ project, number: Number(branch[1]) }, true)
  return [...out.values()].sort((a, b) => Number(b.closes) - Number(a.closes))
}

/** "group/project#12": how an issue is written in lines and keys. */
export const issueRef = (l: { project: string; number: number }) => `${l.project}#${l.number}`
