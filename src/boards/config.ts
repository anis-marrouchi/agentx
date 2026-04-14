import { z } from "zod"

// --- Kanban board configuration ---
//
// Top-level optional keys in agentx.json, independent of the business layer:
//
//   boards:    array of kanban boards, each backed by a WorkSource
//   dashboard: HTTP server controlling whether the board UI serves
//
// Both default to empty / disabled so existing installs see no change.

export const boardLabelSchema = z.object({
  /** Label name — used verbatim as the GitLab label string. */
  name: z.string(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#6366f1"),
  description: z.string().optional(),
})

/**
 * A board column. `kind` controls what issues land here and how drag-to-this-column
 * mutates the issue:
 *
 *   - "open-backlog": opened issues that have NO scoped label matching `scopedPrefix`
 *       (default "Status"). Dragging INTO this column removes any existing scoped label.
 *   - "scoped-label": opened issues carrying `scopedLabel` (e.g. "Status::Doing").
 *       Scoped labels are mutually exclusive by prefix, so adding the new one lets
 *       GitLab auto-remove the old one (Premium), but we still explicitly strip the
 *       previous column's label for compatibility.
 *   - "closed": all closed issues. Dragging here closes the issue; dragging away
 *       reopens it.
 *   - "label" (default, legacy): opened issues with `mapsToLabel`; flat add/remove.
 */
export const boardColumnSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "column id must be lowercase slug"),
  title: z.string(),
  kind: z.enum(["open-backlog", "scoped-label", "closed", "label"]).default("label"),
  /** For kind="label": label written on entry, removed on exit. */
  mapsToLabel: z.string().optional(),
  /** For kind="scoped-label": the full scoped label (e.g. "Status::Doing"). */
  scopedLabel: z.string().optional(),
  /** For kind="open-backlog": scoped prefix that marks "claimed" cards to exclude. */
  scopedPrefix: z.string().default("Status"),
  /** CSS color or hex — shown as the column's top accent bar. */
  accent: z.string().optional(),
})
export type BoardColumnId = string

export const boardReconcileSchema = z.object({
  enabled: z.boolean().default(true),
  staleDoingMinutes: z.number().int().min(1).default(45),
  respectLunchBreak: z.boolean().default(true),
  respectSchedule: z.boolean().default(true),
  /** Badge only for P1/P3; auto-notify + auto-demote deferred. */
  action: z.enum(["badge", "notify"]).default("badge"),
})

export const boardSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("gitlab"),
    /** GitLab project paths (e.g. "mtgl/mtgl-system-v2"). At least one required. */
    projects: z.array(z.string()).min(1),
  }),
  // future: backlog, wiki
])

/**
 * GitLab-style default board — six columns:
 *   Open (backlog) → To Do → Doing → On Hold → Review → Closed
 *
 * Drives the `Status::*` scoped label taxonomy. Moving a card adds/removes the
 * column's scoped label; moving INTO Closed closes the issue; moving OUT of
 * Closed reopens it; moving INTO Open strips any Status::* label.
 */
export const DEFAULT_COLUMNS: Array<z.infer<typeof boardColumnSchema>> = [
  { id: "open",   title: "Open",    kind: "open-backlog", scopedPrefix: "Status", accent: "#6b7280" },
  { id: "todo",   title: "To Do",   kind: "scoped-label", scopedLabel: "Status::To Do",   scopedPrefix: "Status", accent: "#fb7a35" },
  { id: "doing",  title: "Doing",   kind: "scoped-label", scopedLabel: "Status::Doing",   scopedPrefix: "Status", accent: "#22c55e" },
  { id: "onhold", title: "On Hold", kind: "scoped-label", scopedLabel: "Status::On Hold", scopedPrefix: "Status", accent: "#f59e0b" },
  { id: "review", title: "Review",  kind: "scoped-label", scopedLabel: "Status::Review",  scopedPrefix: "Status", accent: "#3b82f6" },
  { id: "closed", title: "Closed",  kind: "closed",       scopedPrefix: "Status", accent: "#6b7280" },
]

export const boardSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "board id must be lowercase slug"),
  name: z.string(),
  source: boardSourceSchema,
  /** If set, ANDed into every listAll query and shown as a baseline chip in the UI. */
  primaryToolLabel: z.string().optional(),
  labels: z.array(boardLabelSchema).default([]),
  columns: z.array(boardColumnSchema).min(1).default(DEFAULT_COLUMNS),
  timeRangeDays: z.number().int().min(1).max(365).default(30),
  /** Maximum closed-issue window (days) shown in the Closed column. */
  closedWindowDays: z.number().int().min(1).max(365).default(30),
  reconciliation: boardReconcileSchema.default({}),
})

export const boardsConfigSchema = z.array(boardSchema).default([])

export const dashboardDaemonSchema = z.object({
  name: z.string(),
  url: z.string(),
  /** Optional bearer token if the daemon is auth-gated. */
  token: z.string().optional(),
})

export const dashboardConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().default(4202),
  bind: z.string().default("127.0.0.1"),
  /** Opt-in bearer token for writes. If unset, writes are unauthenticated. */
  token: z.string().optional(),
  /** Primary daemon the dashboard talks to for live view + A2A. */
  daemonUrl: z.string().default("http://localhost:18800"),
  /** Additional daemons to poll (beyond peers discovered via primary's /mesh). */
  daemons: z.array(dashboardDaemonSchema).default([]),
  /** Default agent used for AI-assisted drafting in the create-issue flow. */
  draftAgent: z.string().optional(),
}).default({})

export type BoardConfig = z.infer<typeof boardSchema>
export type BoardLabel = z.infer<typeof boardLabelSchema>
export type BoardColumn = z.infer<typeof boardColumnSchema>
export type BoardSource = z.infer<typeof boardSourceSchema>
export type BoardReconcile = z.infer<typeof boardReconcileSchema>
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>

/**
 * Decide which column an item lives in. Walks columns in order; the first
 * matching column wins. Items with `state: "closed"` always land in the
 * first `kind: "closed"` column; otherwise the first `scoped-label` whose
 * `scopedLabel` is present wins; otherwise the first `label` column whose
 * `mapsToLabel` is present; otherwise the first `open-backlog` column.
 *
 * Returns `null` when the item carries a scoped label matching an
 * `open-backlog` column's `scopedPrefix` but no `scoped-label` column claims
 * it — those are off-board workflow states (e.g. `Status::Done` when no
 * Done column exists) and must not leak into the backlog.
 */
export function deriveStage(
  item: { state?: "opened" | "closed"; labels?: string[] },
  columns: BoardColumn[],
): BoardColumnId | null {
  const set = new Set(item.labels || [])
  if (item.state === "closed") {
    const closed = columns.find((c) => c.kind === "closed")
    if (closed) return closed.id
  }
  for (const c of columns) {
    if (c.kind === "scoped-label" && c.scopedLabel && set.has(c.scopedLabel)) return c.id
  }
  for (const c of columns) {
    if (c.kind === "label" && c.mapsToLabel && set.has(c.mapsToLabel)) return c.id
  }
  const backlog = columns.find((c) => c.kind === "open-backlog")
  if (backlog) {
    // If the item has any scoped-prefix label, it's not an open-backlog candidate.
    const prefix = backlog.scopedPrefix + "::"
    const hasScoped = [...set].some((l) => l.startsWith(prefix))
    return hasScoped ? null : backlog.id
  }
  return columns[0]?.id ?? null
}

/**
 * Describes how to mutate an issue to move it between two columns.
 * `closeIssue` / `reopen` take precedence over label mutations on the same action.
 */
export interface ColumnTransition {
  addLabels?: string[]
  removeLabels?: string[]
  closeIssue?: boolean
  reopen?: boolean
}

export function transitionDiff(
  fromColumn: BoardColumn | undefined,
  toColumn: BoardColumn,
): ColumnTransition {
  const add: string[] = []
  const remove: string[] = []
  let closeIssue = false
  let reopen = false

  // Handle target column.
  if (toColumn.kind === "scoped-label" && toColumn.scopedLabel) {
    add.push(toColumn.scopedLabel)
  } else if (toColumn.kind === "label" && toColumn.mapsToLabel) {
    add.push(toColumn.mapsToLabel)
  } else if (toColumn.kind === "closed") {
    closeIssue = true
  }

  // Handle source column — strip its label; if it was "closed", reopen.
  if (fromColumn) {
    if (fromColumn.kind === "scoped-label" && fromColumn.scopedLabel) {
      remove.push(fromColumn.scopedLabel)
    } else if (fromColumn.kind === "label" && fromColumn.mapsToLabel) {
      remove.push(fromColumn.mapsToLabel)
    } else if (fromColumn.kind === "closed" && toColumn.kind !== "closed") {
      reopen = true
    }
  }

  return {
    addLabels: add.length ? add : undefined,
    removeLabels: remove.length ? remove : undefined,
    closeIssue: closeIssue || undefined,
    reopen: reopen || undefined,
  }
}
