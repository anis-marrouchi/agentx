// --- The kind of work, asked for in every close and accept hint (Anis 2026-11-25) ---
//
// Every request carries the kind of work it was. While a request has none,
// the hints that tell an agent how to close or accept it ask for one, so the
// call is not refused for it first.

export const WORK_KINDS_HINT = "code, ops, review, research, writing or reply"

/** `, work:"<…>"` while the request has no kind yet, "" once it has one. */
export function workHint(r: { work?: string | null }): string {
  return r.work ? "" : `, work:"<${WORK_KINDS_HINT}>"`
}
