import { z } from "zod"

// --- Kanban board configuration ---
//
// Top-level optional keys in agentx.json, independent of the business layer:
//
//   boards:    array of kanban boards, each backed by a WorkSource
//   dashboard: HTTP server controlling whether the board UI serves
//
// Both default to empty / disabled so existing installs see no change.

export const boardColumnIdSchema = z.enum([
  "triage", "todo", "doing", "onhold", "review", "done",
])
export type BoardColumnId = z.infer<typeof boardColumnIdSchema>

export const boardLabelSchema = z.object({
  /** Label name — used verbatim as the GitLab label string. */
  name: z.string(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#6366f1"),
  description: z.string().optional(),
})

export const boardColumnSchema = z.object({
  id: boardColumnIdSchema,
  title: z.string(),
  /** Label written when a card enters this column (and removed when it leaves). */
  mapsToLabel: z.string(),
})

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

export const DEFAULT_COLUMNS: Array<z.infer<typeof boardColumnSchema>> = [
  { id: "triage", title: "Triage", mapsToLabel: "Triage" },
  { id: "todo",   title: "To Do",  mapsToLabel: "To Do" },
  { id: "doing",  title: "Doing",  mapsToLabel: "Doing" },
  { id: "onhold", title: "On Hold", mapsToLabel: "On Hold" },
  { id: "review", title: "Review", mapsToLabel: "Review" },
  { id: "done",   title: "Done",   mapsToLabel: "Done" },
]

export const boardSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "board id must be lowercase slug"),
  name: z.string(),
  source: boardSourceSchema,
  /** If set, ANDed into every listAll query and shown as a baseline chip in the UI. */
  primaryToolLabel: z.string().optional(),
  labels: z.array(boardLabelSchema).default([]),
  columns: z.array(boardColumnSchema).length(6).default(DEFAULT_COLUMNS),
  timeRangeDays: z.number().int().min(1).max(365).default(30),
  reconciliation: boardReconcileSchema.default({}),
})

export const boardsConfigSchema = z.array(boardSchema).default([])

export const dashboardConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().default(4202),
  bind: z.string().default("127.0.0.1"),
  /** Opt-in bearer token for writes. If unset, writes are unauthenticated. */
  token: z.string().optional(),
}).default({})

export type BoardConfig = z.infer<typeof boardSchema>
export type BoardLabel = z.infer<typeof boardLabelSchema>
export type BoardColumn = z.infer<typeof boardColumnSchema>
export type BoardSource = z.infer<typeof boardSourceSchema>
export type BoardReconcile = z.infer<typeof boardReconcileSchema>
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>

/**
 * Resolve a board's label set given a WorkItem's labels — returns the column
 * id (first column whose mapsToLabel appears in the item labels), defaulting
 * to "triage" if no column matches.
 */
export function deriveStage(
  itemLabels: string[] | undefined,
  columns: BoardColumn[],
): BoardColumnId {
  if (!itemLabels || itemLabels.length === 0) return "triage"
  const set = new Set(itemLabels)
  // Walk columns in reverse so "later" states win when multiple labels apply
  // (e.g., an item with both "Doing" and "Review" shows in Review).
  for (let i = columns.length - 1; i >= 0; i--) {
    if (set.has(columns[i].mapsToLabel)) return columns[i].id
  }
  return "triage"
}

/**
 * Compute add/remove label diff for a column transition.
 * fromColumn is optional; when provided, its mapsToLabel is removed.
 */
export function transitionLabelDiff(
  fromColumn: BoardColumn | undefined,
  toColumn: BoardColumn,
): { add: string; remove?: string } {
  return {
    add: toColumn.mapsToLabel,
    remove: fromColumn && fromColumn.mapsToLabel !== toColumn.mapsToLabel
      ? fromColumn.mapsToLabel
      : undefined,
  }
}
