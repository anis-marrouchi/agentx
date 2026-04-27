import { z } from "zod"

// --- Deterministic Reference Registry ---
//
// References are typed, structured fact cards (SSH hosts, GitLab project IDs,
// filesystem paths, contacts). Skills cite them by dotted ID; the resolver
// renders them as a small deterministic block at the top of agent context.
// No LLM in the lookup path — same (agent, intent, message) → same facts.

export const referenceKindSchema = z.enum([
  "ssh",
  "gitlab",
  "path",
  "contact",
  "http",
  "secret-pointer",
])
export type ReferenceKind = z.infer<typeof referenceKindSchema>

export const referenceCardSchema = z.object({
  /** Dotted ID, e.g. "ksi.gitlab.project.ksi-v2". Globally unique. */
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/, "id must be a dotted slug"),
  kind: referenceKindSchema,
  /** Human-readable summary rendered in the verified-references block. */
  summary: z.string(),
  /** Typed fact body. Shape varies by kind — validated permissively here,
   *  shape is enforced at render time. */
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** Free-form tags used by recipes for matching (e.g. "deploy", "ksi-v2"). */
  tags: z.array(z.string()).default([]),
  /** Agent that owns / verifies this card. */
  ownerAgent: z.string().optional(),
  /** ISO date the values were last verified. Stale cards surface in audit. */
  lastVerified: z.string().optional(),
  /** Inline notes — never rendered to the agent, just for human readers. */
  notes: z.string().optional(),
})
export type ReferenceCard = z.infer<typeof referenceCardSchema>

export const referenceFileSchema = z.object({
  /** Optional namespace prefix applied to every card id in the file. */
  namespace: z.string().optional(),
  cards: z.array(referenceCardSchema),
})
export type ReferenceFile = z.infer<typeof referenceFileSchema>

export interface ReferenceIndex {
  /** id → card */
  byId: Map<string, ReferenceCard>
  /** tag → card[] */
  byTag: Map<string, ReferenceCard[]>
  /** Source file path for each card id (for audit / debug). */
  sourceById: Map<string, string>
}
