/**
 * G1 (#2085): a new issue is complete when it is created: a milestone, an
 * estimate and a checklist (Rules Registry row "every new issue is complete
 * when it is created", Anis 2026-11-11, ksi/int.ksi.tn#581).
 *
 * One check function, used by the GitLab adapter and the guard. This file
 * holds only pure code and the "current" milestone lookup; callers decide
 * what to do with the answer (refuse, log, fill).
 */

export const ISSUE_COMPLETE_GATE = "issue-complete"
export const ISSUE_COMPLETE_RULE = "every-new-issue-is-complete-when-it-is-created"

/** off: no check. shadow: check, log what would be refused, create anyway.
 *  enforce: refuse. Default shadow (#2085 v3 P). */
export type GateMode = "off" | "shadow" | "enforce"

export function gateMode(v: unknown, fallback: GateMode = "shadow"): GateMode {
  return v === "off" || v === "shadow" || v === "enforce" ? v : fallback
}

/** The milestone a caller passes: "current" (the month's), "none" (a
 *  deliberate no-milestone, logged with its reason), or a GitLab id. */
export const CURRENT_MILESTONE = "current"
export const NO_MILESTONE = "none"

const MILESTONE_ACTION = /^\s*\/milestone\s+%\S/m
const ESTIMATE_ACTION = /^\s*\/estimate\s+\S/m
const CHECKLIST_LINE = /^\s*[-*+]\s+\[ \]\s+\S/m

/** What a new issue lacks, in a fixed order. Empty: complete.
 *  `hasMilestone` is the caller's own milestone argument; a `/milestone %…`
 *  quick action in the body counts too. `hasEstimate`: an estimate given
 *  outside the body (glab's --time-estimate). */
export function missingParts(description: string, hasMilestone: boolean, hasEstimate = false): string[] {
  const body = description ?? ""
  const missing: string[] = []
  if (!hasMilestone && !MILESTONE_ACTION.test(body)) missing.push("milestone")
  if (!hasEstimate && !ESTIMATE_ACTION.test(body)) missing.push("/estimate")
  if (!CHECKLIST_LINE.test(body)) missing.push("checklist")
  return missing
}

export function missingReason(missing: string[]): string {
  return `missing: ${missing.join(", ")}`
}

export interface MilestoneRow {
  id: number
  title: string
  start_date?: string | null
  due_date?: string | null
  project_id?: number | null
  group_id?: number | null
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
]

/** Does the title name this month and this year? Both are needed, so a
 *  November 2025 milestone is never taken in November 2026 (P11). */
export function titleNamesMonth(title: string, now: Date): boolean {
  const t = title.toLowerCase()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const mm = String(m + 1).padStart(2, "0")
  if (new RegExp(`\\b${y}[-/.]${mm}\\b`).test(t)) return true
  if (new RegExp(`\\b${mm}[-/.]${y}\\b`).test(t)) return true
  if (!new RegExp(`\\b${y}\\b`).test(t)) return false
  const full = MONTHS[m]
  return new RegExp(`\\b(${full}|${full.slice(0, 3)})\\b`).test(t)
}

/** Pick the month's milestone from the project's active milestones (group
 *  ones included). The one whose dates hold today wins, a project one before
 *  a group one (P7); else the one whose title names this month and year. */
export function pickCurrentMilestone(rows: MilestoneRow[], now: Date): MilestoneRow | null {
  const today = now.toISOString().slice(0, 10)
  const byOwner = (a: MilestoneRow, b: MilestoneRow) => Number(!!b.project_id) - Number(!!a.project_id)
  const dated = rows
    .filter((r) => r.start_date && r.due_date && r.start_date <= today && today <= r.due_date)
    .sort(byOwner)
  if (dated[0]) return dated[0]
  const named = rows.filter((r) => titleNamesMonth(r.title ?? "", now)).sort(byOwner)
  return named[0] ?? null
}

/** Read the project's active milestones, ancestors included (monthly
 *  milestones are group milestones, #2085 v4 B2), and pick the month's.
 *  Null when none is found or the read fails; `error` says which. */
export async function lookupCurrentMilestone(
  host: string,
  project: string,
  token: string,
  now: Date = new Date(),
  fetchFn: typeof fetch = fetch,
): Promise<{ milestone: MilestoneRow | null; error?: string }> {
  const url = `${host}/api/v4/projects/${encodeURIComponent(project)}/milestones?state=active&include_ancestors=true&per_page=100`
  try {
    const res = await fetchFn(url, { headers: { "PRIVATE-TOKEN": token } })
    if (!res.ok) return { milestone: null, error: `milestone lookup returned ${res.status}` }
    const rows = (await res.json()) as MilestoneRow[]
    const found = pickCurrentMilestone(Array.isArray(rows) ? rows : [], now)
    return found ? { milestone: found } : { milestone: null, error: `no current milestone in ${project}` }
  } catch (e: any) {
    return { milestone: null, error: `milestone lookup failed: ${e?.message ?? e}` }
  }
}
