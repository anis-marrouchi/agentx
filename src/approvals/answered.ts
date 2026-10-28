import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { approvalsDir } from "./cards"

// --- What the owner answered, across every kind (#1440) ---
//
// Each source keeps its own decision (the card file, the schedule, the
// memory fact, the wiki proposal, the draft). This is only the list the
// Wall's Answered tab reads: one line per yes or no that went through
// decide() (inbox.ts), whichever surface sent it. "Later" is not an answer.
// It starts empty: answers given before it existed are not in it.

export interface AnsweredItem {
  key: string
  kind: string
  title: string
  raised_by: string
  answer: "yes" | "no"
  /** Cards with choices: the one picked. */
  choice?: string
  by: string
  at: string
}

/** Lines kept: the oldest go once the file passes this. */
const KEEP = 500

function answeredFile(root: string): string {
  return resolve(approvalsDir(root), "_answered.jsonl")
}

export function recordAnswered(root: string, item: AnsweredItem): void {
  mkdirSync(approvalsDir(root), { recursive: true })
  const path = answeredFile(root)
  appendFileSync(path, JSON.stringify(item) + "\n")
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
  if (lines.length > KEEP * 1.2) writeFileSync(path, lines.slice(-KEEP).join("\n") + "\n")
}

/** Newest first, at most `limit`. A line that does not parse is skipped. */
export function readAnswered(root: string, limit = 50): AnsweredItem[] {
  const path = answeredFile(root)
  if (!existsSync(path)) return []
  const out: AnsweredItem[] = []
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
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
