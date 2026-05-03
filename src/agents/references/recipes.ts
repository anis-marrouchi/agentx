import { existsSync, promises as fs } from "fs"
import path from "path"
import yaml from "js-yaml"
import fg from "fast-glob"
import { z } from "zod"
import { logger } from "@/utils/logger"
import type { ReferenceCard, ReferenceIndex } from "./types"

// --- Recipes ---
//
// Map (agentId, optional intent tag, optional message keyword) to a bundle of
// reference card ids and skill names. Pure deterministic lookup — no LLM in
// the hot path. Multiple recipes can match a single turn; the resolver merges
// their reference sets and de-duplicates.

const recipeSchema = z.object({
  id: z.string(),
  /** Higher = picked first when budgets bite. Default 0. */
  priority: z.number().default(0),
  when: z
    .object({
      agentIds: z.array(z.string()).optional(),
      intentTags: z.array(z.string()).optional(),
      /** OR'd, case-insensitive regex sources. */
      messageRegex: z.array(z.string()).optional(),
      /** Tags to require on the card pool. Cards must carry every tag. */
      requireTags: z.array(z.string()).optional(),
    })
    .default({}),
  /** Card ids OR ".*" glob suffixes — "ksi.contacts.*" matches all under that prefix. */
  references: z.array(z.string()).default([]),
  /** Skill names that should be considered required for this intent (audit lint
   *  flags FAILING when a referenced skill has no SKILL.md). */
  skills: z.array(z.string()).default([]),
  /** Per-recipe char budget. Total is enforced by the layer; this is advisory. */
  maxChars: z.number().int().min(100).max(8000).optional(),
})
export type Recipe = z.infer<typeof recipeSchema>

const recipeFileSchema = z.object({
  recipes: z.array(recipeSchema),
})

export interface RecipeIndex {
  recipes: Recipe[]
  /** Source path per recipe id. */
  sourceById: Map<string, string>
}

const RECIPE_DIRS = [
  "references/recipes",
  ".references/recipes",
  ".agentx/references/recipes",
  ".agentx/recipes",
]

export async function loadRecipes(cwd: string): Promise<RecipeIndex> {
  const index: RecipeIndex = { recipes: [], sourceById: new Map() }
  for (const dir of RECIPE_DIRS) {
    const abs = path.resolve(cwd, dir)
    if (!existsSync(abs)) continue
    const files = await fg.glob("**/*.{yaml,yml}", { cwd: abs, deep: 5 })
    for (const rel of files) {
      const file = path.resolve(abs, rel)
      try {
        const raw = await fs.readFile(file, "utf8")
        const parsed = yaml.load(raw)
        const validated = recipeFileSchema.parse(parsed)
        for (const recipe of validated.recipes) {
          if (index.sourceById.has(recipe.id)) {
            throw new Error(`recipe id "${recipe.id}" duplicated in ${file}`)
          }
          index.recipes.push(recipe)
          index.sourceById.set(recipe.id, file)
        }
      } catch (e: any) {
        logger.warn({ file, error: e?.message }, "recipes: failed to load file")
      }
    }
  }
  return index
}

export interface RecipeContext {
  agentId: string
  intentTags?: string[]
  message: string
}

export interface ResolvedRecipes {
  matched: Recipe[]
  cards: ReferenceCard[]
  /** Skill names required by the matched recipes. */
  requiredSkills: string[]
  /** Reference ids in the recipes that did NOT resolve — used by audit lint. */
  unresolvedIds: string[]
}

/**
 * Match recipes deterministically. AND within a `when` clause, OR across
 * recipes. A recipe with no `when` always matches (use sparingly).
 */
export function resolveRecipes(
  ctx: RecipeContext,
  recipeIndex: RecipeIndex,
  referenceIndex: ReferenceIndex,
): ResolvedRecipes {
  const matched: Recipe[] = []
  for (const recipe of recipeIndex.recipes) {
    if (recipeMatches(recipe, ctx)) matched.push(recipe)
  }
  // Highest priority first, then stable by id.
  matched.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))

  const seen = new Set<string>()
  const cards: ReferenceCard[] = []
  const skills = new Set<string>()
  const unresolvedIds: string[] = []

  for (const recipe of matched) {
    for (const ref of recipe.references) {
      const ids = expandReferenceIds(ref, referenceIndex)
      if (ids.length === 0) unresolvedIds.push(ref)
      for (const id of ids) {
        if (seen.has(id)) continue
        const card = referenceIndex.byId.get(id)
        if (!card) {
          unresolvedIds.push(id)
          continue
        }
        if (recipe.when.requireTags?.length) {
          const has = recipe.when.requireTags.every(t => card.tags.includes(t))
          if (!has) continue
        }
        seen.add(id)
        cards.push(card)
      }
    }
    for (const s of recipe.skills) skills.add(s)
  }

  return {
    matched,
    cards,
    requiredSkills: [...skills],
    unresolvedIds: [...new Set(unresolvedIds)],
  }
}

function recipeMatches(recipe: Recipe, ctx: RecipeContext): boolean {
  const w = recipe.when
  if (w.agentIds?.length && !w.agentIds.includes(ctx.agentId)) return false
  if (w.intentTags?.length) {
    const tags = ctx.intentTags ?? []
    const hit = w.intentTags.some(t => tags.includes(t))
    if (!hit) return false
  }
  if (w.messageRegex?.length) {
    const hit = w.messageRegex.some(src => {
      try {
        return new RegExp(src, "i").test(ctx.message)
      } catch {
        return ctx.message.toLowerCase().includes(src.toLowerCase())
      }
    })
    if (!hit) return false
  }
  return true
}

/**
 * Expand a reference id pattern. Plain ids return [id]. A trailing `.*` matches
 * any id with that prefix in the index.
 */
function expandReferenceIds(pattern: string, idx: ReferenceIndex): string[] {
  if (!pattern.endsWith(".*")) return [pattern]
  const prefix = pattern.slice(0, -2)
  const out: string[] = []
  for (const id of idx.byId.keys()) {
    if (id === prefix || id.startsWith(`${prefix}.`)) out.push(id)
  }
  return out
}
