import { existsSync, promises as fs } from "fs"
import path from "path"
import yaml from "js-yaml"
import fg from "fast-glob"
import { logger } from "@/utils/logger"
import {
  referenceFileSchema,
  type ReferenceCard,
  type ReferenceIndex,
} from "./types"

const REFERENCE_DIRS = ["references", ".references", ".agentx/references"]
const REFERENCE_GLOB = "**/*.{yaml,yml}"

/**
 * Walk every references directory under `cwd` and build the merged index.
 * Files: YAML matching ReferenceFile schema. Each card's id can be optionally
 * prefixed by a per-file `namespace`.
 *
 * Collisions throw — references must be globally unique to keep the resolver
 * deterministic. Caller can catch and surface them via the audit lint.
 */
export async function loadReferences(cwd: string): Promise<ReferenceIndex> {
  const index: ReferenceIndex = {
    byId: new Map(),
    byTag: new Map(),
    sourceById: new Map(),
  }

  for (const dir of REFERENCE_DIRS) {
    const absDir = path.resolve(cwd, dir)
    if (!existsSync(absDir)) continue

    const files = await fg.glob(REFERENCE_GLOB, { cwd: absDir, deep: 5 })
    for (const rel of files) {
      const abs = path.resolve(absDir, rel)
      // Recipes live alongside references but are loaded separately.
      if (rel.startsWith("recipes/")) continue
      try {
        await ingestFile(abs, index)
      } catch (e: any) {
        logger.warn({ file: abs, error: e?.message }, "references: failed to load file")
      }
    }
  }

  return index
}

async function ingestFile(absPath: string, index: ReferenceIndex): Promise<void> {
  const raw = await fs.readFile(absPath, "utf8")
  const parsed = yaml.load(raw)
  const validated = referenceFileSchema.parse(parsed)

  const ns = validated.namespace ? `${validated.namespace}.` : ""
  for (const card of validated.cards) {
    const id = `${ns}${card.id}`
    if (index.byId.has(id)) {
      const prior = index.sourceById.get(id)
      throw new Error(
        `references: duplicate id "${id}" in ${absPath}` +
          (prior ? ` (also defined in ${prior})` : "")
      )
    }
    const stamped: ReferenceCard = { ...card, id }
    index.byId.set(id, stamped)
    index.sourceById.set(id, absPath)
    for (const tag of stamped.tags) {
      const bucket = index.byTag.get(tag) ?? []
      bucket.push(stamped)
      index.byTag.set(tag, bucket)
    }
  }
}

/**
 * Render a deterministic, compact block of cards. Token-trimmed by alphabetical
 * id once `maxChars` is exceeded (stable order = stable cache).
 */
export function renderReferences(
  cards: ReferenceCard[],
  maxChars: number = 2000,
): string {
  if (cards.length === 0) return ""
  const sorted = [...cards].sort((a, b) => a.id.localeCompare(b.id))
  const header = "[Verified References — deterministic, do not re-query]"
  const lines: string[] = [header]
  let total = header.length
  for (const card of sorted) {
    const fact = renderCard(card)
    if (total + fact.length + 1 > maxChars) break
    lines.push(fact)
    total += fact.length + 1
  }
  return lines.join("\n")
}

function renderCard(card: ReferenceCard): string {
  const fields = Object.entries(card.fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")
  return `- ${card.id} (${card.kind}): ${card.summary}${fields ? ` { ${fields} }` : ""}`
}
