// A task's due time and type, as the caller gave them in the run's context
// (#1030, #1049). Its own file so the registry can read them without loading
// the watchers.

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

/** `context.taskType`: the type that picks the task's evidence rule. */
export function taskTypeOf(ctx: Record<string, unknown> | undefined | null): string | undefined {
  const v = ctx?.taskType
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : undefined
}
