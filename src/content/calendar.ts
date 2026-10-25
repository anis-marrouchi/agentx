import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

// --- The content calendar: <workspace>/calendar.md ---
//
// A plain Markdown table the owner can read and edit by hand, and the
// agent fills each week on its schedule:
//
//   | Date       | Platform | Topic                   | Status  |
//   |------------|----------|-------------------------|---------|
//   | 2026-11-02 | linkedin | What we learned in March | planned |
//
// The status moves on its own as a post goes through: planned → drafted
// (the agent raised a draft) → posted, or ready (saved to paste by hand),
// or skipped (the owner said no). Lines that are not table rows are kept
// as they are.

export const CALENDAR_FILE = "calendar.md"

export const CALENDAR_STATUSES = ["planned", "drafted", "posted", "ready", "skipped"] as const
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number]

export interface CalendarEntry {
  date: string
  platform: string
  topic: string
  status: string
}

export const CALENDAR_TEMPLATE = [
  "# Content calendar",
  "",
  "One row per planned post. The agent adds next week's rows every Monday and updates the status.",
  "",
  "| Date | Platform | Topic | Status |",
  "|------|----------|-------|--------|",
  "",
].join("\n")

export function calendarPath(workspace: string): string {
  return resolve(workspace, CALENDAR_FILE)
}

const ROW = /^\s*\|(.*)\|\s*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function cells(line: string): string[] | null {
  const m = ROW.exec(line)
  return m ? m[1].split("|").map((c) => c.trim()) : null
}

/** The rows of a calendar, in file order. Header and divider rows are not entries. */
export function parseCalendar(text: string): CalendarEntry[] {
  const out: CalendarEntry[] = []
  for (const line of text.split("\n")) {
    const c = cells(line)
    if (!c || c.length < 4 || !DATE.test(c[0])) continue
    out.push({ date: c[0], platform: c[1].toLowerCase(), topic: c[2], status: c[3].toLowerCase() || "planned" })
  }
  return out
}

export function readCalendar(workspace: string): CalendarEntry[] | null {
  const path = calendarPath(workspace)
  if (!existsSync(path)) return null
  try { return parseCalendar(readFileSync(path, "utf-8")) } catch { return null }
}

/** Rows from `from` (inclusive) for `days` days, by date. */
export function upcoming(entries: CalendarEntry[], from: Date, days = 7): CalendarEntry[] {
  const start = from.toISOString().slice(0, 10)
  const end = new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10)
  return entries.filter((e) => e.date >= start && e.date < end).sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Set the status of the row for `date` and `platform`, keeping every other
 * line as it is. False when there is no calendar or no such row.
 */
export function setCalendarStatus(workspace: string, date: string, platform: string, status: CalendarStatus): boolean {
  const path = calendarPath(workspace)
  if (!existsSync(path)) return false
  let text: string
  try { text = readFileSync(path, "utf-8") } catch { return false }
  let changed = false
  const lines = text.split("\n").map((line) => {
    if (changed) return line
    const c = cells(line)
    if (!c || c.length < 4 || c[0] !== date || c[1].toLowerCase() !== platform.toLowerCase()) return line
    changed = true
    c[3] = status
    return `| ${c.join(" | ")} |`
  })
  if (!changed) return false
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, lines.join("\n"))
  renameSync(tmp, path)
  return true
}
