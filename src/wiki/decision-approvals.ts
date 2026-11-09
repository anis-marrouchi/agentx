// --- Owner approval for decision pages (#1778) ---
//
// A fresh session puts the newest wiki `decision` pages ahead of the chat
// history and says they win (agents/owner-decisions.ts, #1777). Until now
// any write could make such a page: the absorb job types pages from raw
// chat and cron entries (a client's message included), `wiki patch` and
// `wiki interview` take an agent id from the caller, the daily
// contributions can create pages, and mesh sync copies a peer's pages.
// None of them asks the owner. So one unreviewed write could steer every
// fresh session of that agent.
//
// The gate is off unless `wiki.decisionApprovals.required` is set. When on,
// a decision page reaches that block only while its title and
// body are exactly what the owner approved. The approval is kept outside
// the pages, in `_decisions/approved.json` of the agent's wiki, which no
// page write touches and the article index skips (`_` prefix). Any later
// edit, by anyone, changes the hash, and the page waits for a new
// approval. The owner approves from a terminal; the command refuses inside
// an agent's run.

import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import type { WikiArticle } from "./types"

export interface DecisionApproval {
  /** Hash of the title and body the owner approved. */
  hash: string
  approvedAt: string
  by: string
  /** The page's own `last_updated` when approved, for the listing. */
  lastUpdated?: string
  note?: string
}

export type DecisionApprovals = Record<string, DecisionApproval>

/** Where a wiki's approvals live. */
export function approvalsFile(wikiBaseDir: string): string {
  return resolve(wikiBaseDir, "_decisions", "approved.json")
}

/** What an approval covers: the title and the body, whitespace at the ends
 *  ignored. Frontmatter dates and tags are not part of it. */
export function decisionHash(article: Pick<WikiArticle, "meta" | "content">): string {
  return createHash("sha256")
    .update(`${article.meta.title ?? ""}\n${(article.content ?? "").trim()}`)
    .digest("hex")
}

export function readApprovals(wikiBaseDir: string): DecisionApprovals {
  const file = approvalsFile(wikiBaseDir)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as DecisionApprovals : {}
  } catch {
    return {} // unreadable: nothing counts as approved
  }
}

function writeApprovals(wikiBaseDir: string, all: DecisionApprovals): void {
  const file = approvalsFile(wikiBaseDir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n")
  renameSync(tmp, file)
}

export type DecisionState = "approved" | "changed" | "waiting"

/** approved: the page is what the owner approved. changed: approved once,
 *  edited since. waiting: never approved. */
export function decisionState(article: WikiArticle, approvals: DecisionApprovals): DecisionState {
  const a = approvals[article.path]
  if (!a) return "waiting"
  return a.hash === decisionHash(article) ? "approved" : "changed"
}

/** Decision pages as they may reach the owner-decisions block: approved
 *  ones only. Other page types pass through unchanged. */
export function approvedDecisionsOnly(articles: WikiArticle[], approvals: DecisionApprovals): WikiArticle[] {
  return articles.filter((a) => a.meta.type !== "decision" || decisionState(a, approvals) === "approved")
}

/** What the owner-decisions block may read. With approvals not required
 *  (the default, `wiki.decisionApprovals.required`), every page passes as
 *  #1776 specifies; required, decision pages need the owner's approval. */
export function decisionsForBlock(articles: WikiArticle[], wikiBaseDir: string, required: boolean): WikiArticle[] {
  return required ? approvedDecisionsOnly(articles, readApprovals(wikiBaseDir)) : articles
}

/** The decision pages an agent's owner-decisions block considers: the pages
 *  that agent may read (the wiki's access filter), old versions left out.
 *  `wiki decisions list` and the block both read this set, so the list
 *  never offers a page for approval that would not reach the agent (#1782). */
export function decisionPagesFor(store: { listArticles(agentId: string): WikiArticle[] }, agentId: string): WikiArticle[] {
  return store.listArticles(agentId).filter((a) => a.meta.type === "decision" && !a.path.includes("/_versions/"))
}

/** Why the current process may not approve: inside an agent's run. */
export function approvalRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AGENTX_AGENT_ID?.trim() || env.AGENTX_TASK_ID?.trim()) {
    return "decision pages are approved by the owner from a terminal, not from inside an agent's run"
  }
  return null
}

export function approveDecision(
  wikiBaseDir: string,
  article: WikiArticle,
  opts: { by?: string; now?: number; note?: string } = {},
): DecisionApproval {
  if (article.meta.type !== "decision") throw new Error(`${article.path} is not a decision page (type: ${article.meta.type ?? "none"})`)
  const all = readApprovals(wikiBaseDir)
  const approval: DecisionApproval = {
    hash: decisionHash(article),
    approvedAt: new Date(opts.now ?? Date.now()).toISOString(),
    by: opts.by || "owner",
    lastUpdated: article.meta.lastUpdated || undefined,
    ...(opts.note ? { note: opts.note } : {}),
  }
  all[article.path] = approval
  writeApprovals(wikiBaseDir, all)
  return approval
}

/** Remove an approval. True when there was one. */
export function revokeDecision(wikiBaseDir: string, path: string): boolean {
  const all = readApprovals(wikiBaseDir)
  if (!all[path]) return false
  delete all[path]
  writeApprovals(wikiBaseDir, all)
  return true
}
