import { z } from "zod"

// --- Wiki ontology: what the wiki's pages are, how they link, how they are viewed (#811) ---
//
// One page per real thing for the whole fleet. A page has a type; types
// sit in pillars (the sidebar); pages link through typed properties that
// carry qualifiers; events carry an importance level; and each type has a
// lens, the panels its page opens with. All of it is data in
// `.agentx/wiki/ontology.yaml`, so an operator reshapes the wiki without a
// release. Design and the owner's decisions: notes/architecture/wiki-ontology.md.
//
// Keys are snake_case to match the YAML a person edits.

const id = z.string().regex(/^[a-z][a-z0-9_]*$/, "ids are lowercase letters, digits and _")

export const pillarSchema = z.object({
  id,
  label: z.string().min(1),
  /** Type ids shown as tabs on the pillar page (zoom level Z1), in order. */
  types: z.array(id).min(1),
  description: z.string().optional(),
})
export type Pillar = z.infer<typeof pillarSchema>

export const entityTypeSchema = z.object({
  id,
  label: z.string().min(1),
  /** schema.org classes this type maps to, most specific first. */
  schema_org: z.array(z.string()).default([]),
  /** Sub-kinds. A kind is what the thing is, never a role it plays. */
  kinds: z.array(z.string()).default([]),
  /** A page of this type is made from other statements, never written by
   *  hand (due dates). */
  generated: z.boolean().optional(),
  /** Use only when nothing else fits; a growing count means a type is missing. */
  fallback: z.boolean().optional(),
  description: z.string().optional(),
})
export type EntityType = z.infer<typeof entityTypeSchema>

/** `*` matches every type. */
const typeRef = z.union([id, z.literal("*")])

export const propertySchema = z.object({
  id,
  label: z.string().min(1),
  /** Label shown on the target page, which lists the link in reverse. */
  inverse: z.string().optional(),
  from: z.array(typeRef).min(1),
  to: z.array(typeRef).min(1),
  qualifiers: z.array(id).default([]),
  required: z.array(id).default([]),
  /** Qualifiers whose values are private unless the statement says otherwise. */
  private: z.array(id).default([]),
  wikidata: z.array(z.string()).default([]),
  description: z.string().optional(),
})
export type Property = z.infer<typeof propertySchema>

export const importanceSchema = z.object({
  id,
  label: z.string().min(1),
  /** The question absorb answers to pick this level. */
  test: z.string().min(1),
  /** Listed in the sidebar's and home page's major events. */
  nav: z.boolean().default(false),
  /** never: a line in its entity's history; if_long: a page only when a few
   *  lines are not enough; always: its own page. */
  own_page: z.enum(["never", "if_long", "always"]).default("never"),
})
export type Importance = z.infer<typeof importanceSchema>

export const rollupSchema = z.object({
  /** Repeated events of the same kind on the same page, at this level, fold into one line... */
  level: id.default("minor"),
  /** ...and after this many within `window_days`, the line is raised. */
  min: z.number().int().min(2).default(5),
  window_days: z.number().int().min(1).default(30),
  raise_to: id.default("normal"),
})

export const panelSchema = z.object({
  panel: id,
  /** Property ids, or a built-in source (see PANEL_SOURCES). */
  from: z.union([z.string(), z.array(z.string())]).optional(),
  /** Items shown at zoom level Z2; the panel's full list is Z3. */
  show: z.number().int().min(1).max(6).optional(),
  group_by: z.string().optional(),
  importance: z.array(id).optional(),
  fold: id.optional(),
  rollup: z.object({ min: z.number().int().min(2), days: z.number().int().min(1) }).optional(),
  /** Only the most recent value (readings). */
  latest: z.boolean().optional(),
  /** Narrower than the statements' own access: `owner` shows the panel to the owner only. */
  access: z.enum(["owner"]).optional(),
})
export type Panel = z.infer<typeof panelSchema>

export const ontologySchema = z.object({
  version: z.literal(1),
  /** Sidebar order. */
  pillars: z.array(pillarSchema).min(1),
  types: z.array(entityTypeSchema).min(1),
  properties: z.array(propertySchema).min(1),
  importance: z.array(importanceSchema).min(1),
  rollup: rollupSchema,
  /** Who may set the top importance level. Agents may only propose it. */
  major: z.object({
    level: id,
    set_by: z.array(z.string()).min(1),
    agents_propose: z.boolean().default(true),
  }),
  /** Legal statements stay proposed until one of these confirms them. */
  confirm: z.object({ legal: z.array(z.string()).min(1) }),
  /** Zoom level Z0. */
  sidebar: z.object({
    pins_max: z.number().int().min(0).max(5),
    show: z.array(z.enum(["home", "pins", "pillars"])).min(1),
  }),
  /** Panels a page opens with at Z2, per type id; `default` covers the rest. */
  lenses: z.record(z.string(), z.array(panelSchema).min(1)),
})
export type Ontology = z.infer<typeof ontologySchema>

/** Panel sources that are not properties: they read statements of a kind. */
export const PANEL_SOURCES = ["facts", "readings", "events", "decisions", "due_dates", "statements"] as const
