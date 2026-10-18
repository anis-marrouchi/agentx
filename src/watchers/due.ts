// A task's due time, as the caller gave it in the run's context (#1030).
// Its own file so the registry can read it without loading the watchers.

/** `context.dueAt` as epoch ms: a number of ms, or an ISO date. */
export function dueAtOf(ctx: Record<string, unknown> | undefined | null): number | undefined {
  const v = ctx?.dueAt
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return undefined
}
