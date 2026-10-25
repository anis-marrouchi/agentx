import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

// --- Leads and opt-outs (#1288) ---
//
// The sales agent keeps its leads in leads.md, one line per lead, and the
// people who asked not to be contacted in opt-outs.md. Both are plain files
// the owner can read and edit. Which leads are new or quiet is worked out
// here, not by the model, so an opted-out person never gets a follow-up
// drafted, however the prompt is read.
//
//   leads.md:     - Name | Company | last contact YYYY-MM-DD | offered: ... | next: ... | added YYYY-MM-DD
//   opt-outs.md:  - Name | Company | YYYY-MM-DD | reason
//
// In leads.md only the name is required; `next: done` closes a lead. In
// opt-outs.md the company may be left empty: the person is then opted out
// at every company.

export const LEADS_FILE = "leads.md"
export const OPT_OUTS_FILE = "opt-outs.md"

const DAY = 86_400_000
const DATE = /\d{4}-\d{2}-\d{2}/

export interface Lead {
  name: string
  company: string
  lastContact?: string
  added?: string
  offered?: string
  next?: string
  /** The line as written in leads.md. */
  line: string
}

export interface OptOut {
  name: string
  company: string
  date?: string
  reason?: string
}

function listItems(text: string): string[][] {
  return text.split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").split("|").map((p) => p.trim()))
}

export function parseLeads(text: string): Lead[] {
  return text.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).map((line) => {
    const [name, company = "", ...rest] = line.trim().replace(/^[-*]\s+/, "").split("|").map((p) => p.trim())
    const lead: Lead = { name, company, line: line.trim() }
    for (const part of rest) {
      const lower = part.toLowerCase()
      if (lower.startsWith("last contact")) lead.lastContact = part.match(DATE)?.[0]
      else if (lower.startsWith("added")) lead.added = part.match(DATE)?.[0]
      else if (lower.startsWith("offered:")) lead.offered = part.slice(8).trim()
      else if (lower.startsWith("next:")) lead.next = part.slice(5).trim()
    }
    return lead
  }).filter((l) => l.name)
}

export function parseOptOuts(text: string): OptOut[] {
  return listItems(text).map(([name = "", company = "", date, reason]) => ({
    name,
    company,
    date: date?.match(DATE)?.[0],
    reason: reason || undefined,
  })).filter((o) => o.name)
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")

/** Whether `lead` asked not to be contacted. */
export function isOptedOut(lead: Pick<Lead, "name" | "company">, optOuts: OptOut[]): boolean {
  return optOuts.some((o) => norm(o.name) === norm(lead.name) && (!o.company || norm(o.company) === norm(lead.company)))
}

const isDone = (l: Lead) => /^done\b/i.test(l.next ?? "")
const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`)

/**
 * Leads that went quiet: open, not opted out, and last contacted at least
 * `days` days before `today`. A lead with no last contact date is quiet
 * once it was added that long ago, or straight away when it has neither.
 */
export function quietLeads(leads: Lead[], optOuts: OptOut[], today: string, days = 7): Lead[] {
  const cutoff = dayOf(today) - days * DAY
  return leads.filter((l) => {
    if (isDone(l) || isOptedOut(l, optOuts)) return false
    const last = l.lastContact ?? l.added
    return !last || dayOf(last) <= cutoff
  })
}

/** Leads added on `today` or the `days - 1` days before it, opt-outs left out. */
export function newLeads(leads: Lead[], optOuts: OptOut[], today: string, days = 1): Lead[] {
  const from = dayOf(today) - (days - 1) * DAY
  return leads.filter((l) => l.added && dayOf(l.added) >= from && dayOf(l.added) <= dayOf(today) && !isOptedOut(l, optOuts))
}

function readIfThere(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : ""
}

export function readLeads(workspace: string): Lead[] {
  return parseLeads(readIfThere(join(workspace, LEADS_FILE)))
}

export function readOptOuts(workspace: string): OptOut[] {
  return parseOptOuts(readIfThere(join(workspace, OPT_OUTS_FILE)))
}

const OPT_OUTS_HEADER = "# Opt-outs\n\nPeople who asked not to be contacted. The sales agent never drafts a message to them.\n\n"

/**
 * Record that `who` asked not to be contacted. Returns false when they were
 * already on the list (nothing is written).
 */
export function recordOptOut(workspace: string, who: { name: string; company?: string; reason?: string }, today: string): boolean {
  const name = who.name.replace(/[|\n]/g, " ").trim()
  const company = (who.company ?? "").replace(/[|\n]/g, " ").trim()
  if (!name) throw new Error("a name is required")
  const path = join(workspace, OPT_OUTS_FILE)
  const current = readIfThere(path)
  if (isOptedOut({ name, company }, parseOptOuts(current))) return false
  const reason = (who.reason ?? "").replace(/[|\n]/g, " ").trim()
  const line = `- ${name} | ${company} | ${today}${reason ? ` | ${reason}` : ""}\n`
  const base = current ? (current.endsWith("\n") ? current : current + "\n") : OPT_OUTS_HEADER
  writeFileSync(path, base + line)
  return true
}

/** One lead as a brief line, citing leads.md as its source. */
export function leadLine(l: Lead): string {
  const bits = [l.company && `at ${l.company}`, l.lastContact && `last contact ${l.lastContact}`, l.next && `next: ${l.next}`].filter(Boolean)
  return `- ${l.name}${bits.length ? ` (${bits.join(", ")})` : ""} [${LEADS_FILE}](${LEADS_FILE})`
}
