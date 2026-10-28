import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { logger } from "@/utils/logger"

// --- What the owner answered, across every kind (#1440) ---
//
// Each source keeps its own decision (the card file, the schedule, the
// memory fact, the wiki proposal, the draft). This is only the list the
// Wall's Answered tab reads: one line per yes or no that went through
// decide() (inbox.ts), whichever surface sent it, and one per card its
// agent closed after the owner answered elsewhere (resolveCard, cards.ts).
// "Later" is not an answer. It starts empty: `_answered.since` keeps the
// day it started, so the page can say so.

export interface AnsweredItem {
  key: string
  kind: string
  title: string
  raised_by: string
  /** "closed": the agent that raised the card closed it (resolveCard). */
  answer: "yes" | "no" | "closed"
  /** Cards with choices: the one picked. */
  choice?: string
  /** The short answer: the owner's text, or the agent's reason for closing. */
  text?: string
  by: string
  at: string
}

/** Lines kept: the oldest go once the file passes this. */
const KEEP = 500
/** Free text kept per line. */
const TEXT_MAX = 200

// approvalsDir (cards.ts), not imported: cards.ts records here.
const dir = (root: string) => resolve(root, ".agentx", "approvals")
const answeredFile = (root: string) => resolve(dir(root), "_answered.jsonl")
const sinceFile = (root: string) => resolve(dir(root), "_answered.since")
const cap = (s: string | undefined) => (s && s.length > TEXT_MAX ? s.slice(0, TEXT_MAX - 1) + "…" : s)

/** Never throws: the answer stands, the list is only a view of it. */
export function recordAnswered(root: string, item: AnsweredItem): void {
  try {
    answeredSince(root)
    const line: AnsweredItem = { ...item, title: cap(item.title) ?? "" }
    if (item.choice) line.choice = cap(item.choice)
    if (item.text) line.text = cap(item.text)
    else delete line.text
    const path = answeredFile(root)
    appendFileSync(path, JSON.stringify(line) + "\n")
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
    if (lines.length > KEEP) writeFileSync(path, lines.slice(-KEEP).join("\n") + "\n")
  } catch (e: any) {
    logger.warn(`[approvals] answered list not written for ${item.key}: ${e?.message ?? e}`)
  }
}

/** The day the list started: written by the first answer or the first read. */
export function answeredSince(root: string): string {
  const path = sinceFile(root)
  try {
    const at = readFileSync(path, "utf-8").trim()
    if (at) return at
  } catch {
    // Not written yet: this is the start.
  }
  const at = new Date().toISOString()
  try {
    mkdirSync(dir(root), { recursive: true })
    writeFileSync(path, at + "\n")
  } catch (e: any) {
    logger.warn(`[approvals] answered start not written: ${e?.message ?? e}`)
  }
  return at
}

/** Newest first, at most `limit`. A line that does not parse is skipped. */
export function readAnswered(root: string, limit = 50): AnsweredItem[] {
  const path = answeredFile(root)
  if (!existsSync(path)) return []
  const out: AnsweredItem[] = []
  let lines: string[]
  try {
    lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
  } catch (e: any) {
    logger.warn(`[approvals] answered list not read: ${e?.message ?? e}`)
    return []
  }
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const v = JSON.parse(lines[i])
      if (v && typeof v.key === "string" && typeof v.at === "string") out.push(v)
    } catch {
      // A torn last line from a crash mid-write: the rest still reads.
    }
  }
  return out
}
