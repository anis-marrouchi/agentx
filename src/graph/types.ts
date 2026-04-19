import { z } from "zod"

// --- Intent Knowledge Graph types + Zod schemas ---
//
// A hierarchical, enumerable intent taxonomy with fixed axes per level.
// See plan: /Users/macbookpro/.claude/plans/delightful-floating-diffie.md
//
// Shape on disk (.agentx/graph/):
//   schema.json              — level definitions + required axes per level
//   nodes.json               — tree of nodes: { id, level, parentId, axes }
//   classifications.jsonl    — append-only log of message → path decisions
//   index.json               — fingerprint → pathId snap-to-path cache

export const axisTypeSchema = z.enum(["enum", "free", "ref"])
export type AxisType = z.infer<typeof axisTypeSchema>

export const axisDefSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/i, "axis name must be a simple identifier"),
  type: axisTypeSchema,
  /** For type="enum": closed set of allowed values. */
  values: z.array(z.string()).optional(),
  /** For type="ref": which level's nodes may be referenced. */
  refLevel: z.string().optional(),
  /** Optional human-readable help, shown as tooltip in the admin UI. */
  description: z.string().optional(),
})
export type AxisDef = z.infer<typeof axisDefSchema>

export const levelDefSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, "level id must be lowercase slug"),
  /** Axes every node at this level MUST carry. Order matters for UI rendering. */
  axes: z.array(axisDefSchema).min(1),
  description: z.string().optional(),
})
export type LevelDef = z.infer<typeof levelDefSchema>

export const graphSchemaSchema = z.object({
  version: z.number().int().default(1),
  /** Ordered from root to leaf. Max 5 to keep the taxonomy scannable. */
  levels: z.array(levelDefSchema).min(1).max(5),
  /** Axis describing where a leaf classification came from (channel, cron, etc.). */
  leafInput: axisDefSchema.optional(),
  /** Free-form description of the expected result of a leaf classification. */
  leafOutput: axisDefSchema.optional(),
})
export type GraphSchema = z.infer<typeof graphSchemaSchema>

export const nodeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "node id must be lowercase slug")

export const graphNodeSchema = z.object({
  id: nodeIdSchema,
  /** Matches a `levels[*].id` from the schema. */
  level: z.string(),
  /** null for root-level nodes (level[0]); otherwise the id of a node at level-1. */
  parentId: nodeIdSchema.nullable(),
  /** Values for every axis declared at this level's schema entry. `ref` axes
   *  hold the id of another node; `enum` axes hold one of the declared values;
   *  `free` axes hold any string. */
  axes: z.record(z.string(), z.string()),
  createdAt: z.string(),
  createdBy: z.string().optional(),
})
export type GraphNode = z.infer<typeof graphNodeSchema>

export const classificationSourceSchema = z.enum(["llm", "user", "cache"])
export type ClassificationSource = z.infer<typeof classificationSourceSchema>

export const classificationStatusSchema = z.enum(["pending", "approved", "rejected"])
export type ClassificationStatus = z.infer<typeof classificationStatusSchema>

export const classificationSchema = z.object({
  ts: z.string(),
  msgHash: z.string(),
  agentId: z.string().optional(),
  channel: z.string().optional(),
  sender: z.string().optional(),
  /** Node ids from root to leaf, one per level. Shorter-than-full paths are
   *  allowed if the classifier was only confident down to a certain depth. */
  path: z.array(nodeIdSchema),
  /** Axis values asserted by the classifier for new nodes it proposed along
   *  the path. Keyed by node id. */
  proposedAxes: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** Leaf-level extras. */
  leaf: z.object({
    input: z.string().optional(),
    output: z.string().optional(),
  }).partial().default({}),
  source: classificationSourceSchema,
  status: classificationStatusSchema,
  confidence: z.number().min(0).max(1).optional(),
  /** Redacted first ~200 chars of the message, for the approval UI. */
  preview: z.string().optional(),
})
export type Classification = z.infer<typeof classificationSchema>

/** Row in the fingerprint → path snap cache. */
export const fingerprintEntrySchema = z.object({
  fingerprint: z.string(),
  path: z.array(nodeIdSchema),
  leaf: classificationSchema.shape.leaf,
  updatedAt: z.string(),
})
export type FingerprintEntry = z.infer<typeof fingerprintEntrySchema>

/** Nodes file is a plain list, not a nested tree — lookups are by id. */
export const nodesFileSchema = z.object({
  version: z.number().int().default(1),
  nodes: z.array(graphNodeSchema).default([]),
})
export type NodesFile = z.infer<typeof nodesFileSchema>

/** Index file — record of fingerprints. Hot path; kept as a map on disk. */
export const indexFileSchema = z.object({
  version: z.number().int().default(1),
  entries: z.record(z.string(), fingerprintEntrySchema).default({}),
})
export type IndexFile = z.infer<typeof indexFileSchema>
