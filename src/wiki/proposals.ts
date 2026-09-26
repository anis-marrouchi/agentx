import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { resolve } from "path"

// --- Promotion proposals: lessons wait for a human before the wiki ---
//
// `wiki promote` used to write public, org-wide articles straight into the
// shared wiki from a nightly job. A wrong lesson, or one planted through a
// poisoned memory, reached every agent the next morning. Now the judge's
// output becomes a proposal here, with the evidence that produced it, and
// only an operator's approval writes the article (promote.ts).
//
// Storage only: one JSON file per proposal under `<wiki>/_proposals/`.
// The wiki index skips `_`-prefixed folders, so pending proposals are
// invisible to agents.

export type ProposalStatus = "pending" | "approved" | "rejected"

/** The article the judge wants to write. Same shape as PromotedArticle. */
export interface ProposedArticle {
  path: string
  title: string
  type?: string
  related?: string[]
  tags: string[]
  content: string
  promotedFrom: string[]
}

/** One memory or review finding behind the proposal. */
export interface ProposalSource {
  stamp: string
  kind: "memory" | "review"
  agentId: string
  type: string
  name: string
  description: string
  /** Distinct sessions a review finding appeared in. */
  occurrences?: number
  /** Some of those sessions, for a reviewer to open. */
  sessions?: string[]
  /** Who wrote the memory, and in which task (agent-memory provenance). */
  author?: string
  taskId?: string
  updatedAt: string
  /** Start of the memory body. */
  excerpt: string
}

export interface ProposalEvidence {
  /** Agents whose memories or reviews back it. */
  agents: string[]
  /** Highest recurrence among its sources (1 for plain memories). */
  occurrences: number
  sources: ProposalSource[]
}

export interface PromotionProposal {
  id: string
  createdAt: string
  status: ProposalStatus
  article: ProposedArticle
  evidence: ProposalEvidence
  /** Set when the article already existed: approval refuses if it has
   *  changed since, so a proposal can't silently revert someone's edit. */
  replaces?: { lastUpdated: string; contentHash: string }
  decidedBy?: string
  decidedAt?: string
  reason?: string
}

export function proposalsDir(wikiDir: string): string {
  return resolve(wikiDir, "_proposals")
}

function fileFor(wikiDir: string, id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid proposal id: ${id}`)
  return resolve(proposalsDir(wikiDir), `${id}.json`)
}

export function newProposalId(now: number, path: string): string {
  const day = new Date(now).toISOString().slice(0, 10)
  const slug = path.replace(/\.md$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
  return `${day}-${slug || "article"}-${Math.random().toString(36).slice(2, 6)}`
}

export function saveProposal(wikiDir: string, p: PromotionProposal): void {
  mkdirSync(proposalsDir(wikiDir), { recursive: true })
  const path = fileFor(wikiDir, p.id)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n")
  renameSync(tmp, path)
}

export function readProposal(wikiDir: string, id: string): PromotionProposal | null {
  try {
    return JSON.parse(readFileSync(fileFor(wikiDir, id), "utf-8")) as PromotionProposal
  } catch {
    return null
  }
}

/** Proposals, oldest first; only `status` ones when given. */
export function listProposals(wikiDir: string, status?: ProposalStatus): PromotionProposal[] {
  const dir = proposalsDir(wikiDir)
  if (!existsSync(dir)) return []
  const out: PromotionProposal[] = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const p = readProposal(wikiDir, f.slice(0, -5))
    if (p && (!status || p.status === status)) out.push(p)
  }
  return out
}
