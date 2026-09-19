import { BACKFILLABLE, BACKFILL_ORDER, IDENTITY_SLOTS } from "@/decisions/seats/article-fields"
import type { MergedEntity } from "./facts"

// Writing resolved identifiers back into articles that are missing them.
//
// `wiki gaps` reports that a person article has no contact value and
// that wacli can supply one. Reporting is where it stopped, so the
// corpus kept a list of things nobody was going to do by hand. This
// closes that loop for the one class of gap where closing it needs no
// judgement: a contact value is a string a system of record handed us,
// and copying it is the whole operation.
//
// Everything else stays a report. A project's status, why a decision was
// made, who owns a relationship — no lookup returns those, and a
// confident guess written into the source of truth is worse than an
// acknowledged gap.
//
// All edits go through WikiStore.writeArticle, which versions the prior
// content into `_versions/` first, so every backfill is reversible.

export interface FieldEdit {
  field: string
  heading: string
  value: string
  /** Replaced an existing bullet rather than adding one. */
  replaced: boolean
}

export interface BackfillResult {
  content: string
  edits: FieldEdit[]
}

/**
 * Render one identity bullet's value from resolved facts.
 *
 * Several facts can feed one field — a person may have a number, an
 * address and a handle — and all of them belong in the article. Each
 * carries the source it came from, because a reader who finds two
 * numbers needs to know which system said what.
 */
export function renderValue(
  entity: MergedEntity,
  from: string[],
): string | null {
  const parts: string[] = []
  for (const key of from) {
    const f = entity.fields[key]
    if (!f?.value?.trim()) continue
    parts.push(`${f.value} (${key}, via ${f.source})`)
  }
  return parts.length > 0 ? parts.join("; ") : null
}

const IDENTITY_HEADING = "## Identity"

/**
 * Replace or insert one identity bullet.
 *
 * Matching is by keyword rather than by exact heading because the
 * headings were written by a model from the prompt's field labels and
 * vary — "Contact identifiers", "How to reach him", "Contact details".
 * Rewriting them all to a canonical form would be a bigger edit than
 * the fact being added, so the patcher meets the article where it is.
 */
export function patchIdentityField(
  content: string,
  field: string,
  value: string,
): { content: string; replaced: boolean } | null {
  // The wider map: a human answer may fill any identity slot, while
  // only BACKFILLABLE fields may be written without being asked.
  const spec = IDENTITY_SLOTS[field]
  if (!spec) return null

  const lines = content.split("\n")
  const bullet = `- **${spec.heading}:** ${value}`

  // Find the Identity section's bounds.
  const start = lines.findIndex((l) => l.trim().toLowerCase() === IDENTITY_HEADING.toLowerCase())
  let end = lines.length
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break }
    }
  }

  if (start >= 0) {
    for (let i = start + 1; i < end; i++) {
      const m = lines[i].match(/^\s*-\s*\*\*([^*]+)\*\*\s*:?/)
      if (!m || !spec.match.test(m[1])) continue
      // Already carries this exact value — leave it alone so the
      // backfill is idempotent and re-running writes no new version.
      if (lines[i].includes(value)) return null
      lines[i] = bullet
      return { content: lines.join("\n"), replaced: true }
    }
    // Section exists, field does not.
    lines.splice(end, 0, bullet)
    return { content: lines.join("\n"), replaced: false }
  }

  // No Identity section at all — articles written before the tier work.
  // It goes after the opening paragraph, which is the definition, so
  // identity still follows "what this is" rather than displacing it.
  let insertAt = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { insertAt = i; break }
  }
  lines.splice(insertAt, 0, IDENTITY_HEADING, "", bullet, "")
  return { content: lines.join("\n"), replaced: false }
}

/**
 * Apply every backfillable field the facts can answer.
 *
 * Only fields named in `missing` are touched. A field the grader found
 * present is left exactly as written, even when a source could supply
 * a different value — the article may carry a better-sourced fact than
 * the directory does, and overwriting it would make the wiki a mirror
 * of the systems rather than a record that can correct them.
 */
export function backfillArticle(
  content: string,
  entity: MergedEntity,
  missing: string[],
): BackfillResult {
  let out = content
  const edits: FieldEdit[] = []

  for (const field of BACKFILL_ORDER) {
    if (!missing.includes(field)) continue
    const spec = BACKFILLABLE[field]
    const value = renderValue(entity, spec.from)
    if (!value) continue
    const patched = patchIdentityField(out, field, value)
    if (!patched) continue
    out = patched.content
    edits.push({ field, heading: spec.heading, value, replaced: patched.replaced })
  }

  return { content: out, edits }
}
