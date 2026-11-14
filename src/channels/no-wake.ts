// The no-wake label (noqta/noqta#800). An issue, pull request or merge
// request carrying it starts no run: not when it opens, not on a label
// change, not on a comment. It holds without any project rule. Set
// `noWakeLabel` on the channel to rename it; "" turns it off.

export const DEFAULT_NO_WAKE_LABEL = "agent:no-wake"

/** The no-wake label found in `labels` (case-insensitive), or null. */
export function noWakeLabelIn(labels: readonly unknown[] | undefined, setting: string | undefined): string | null {
  const wanted = (setting ?? DEFAULT_NO_WAKE_LABEL).trim().toLowerCase()
  if (!wanted || !labels?.length) return null
  for (const l of labels) {
    const name = typeof l === "string" ? l : (l as { name?: unknown; title?: unknown } | null)?.name ?? (l as { title?: unknown } | null)?.title
    if (typeof name === "string" && name.trim().toLowerCase() === wanted) return name
  }
  return null
}
