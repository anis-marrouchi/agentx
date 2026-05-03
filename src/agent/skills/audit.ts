import type { Skill } from "./types"
import type { ReferenceIndex } from "@/agents/references/types"
import type { RecipeIndex } from "@/agents/references/recipes"

// --- Skill audit lint ---
//
// Verdicts:
//   PASS    — skill is deterministic and consistent with the references registry
//   REVIEW  — skill works but embeds raw infra facts that should live in references,
//             or carries known-bad anti-patterns (e.g. raw `python3 ~/scripts/...`)
//   FAILING — skill cites references that don't resolve, OR a recipe requires this
//             skill but its SKILL.md is missing, OR delegatesTo points at a
//             non-existent skill

export type SkillAuditVerdict = "PASS" | "REVIEW" | "FAILING"

export interface SkillAuditResult {
  skill: Skill | null
  /** Either skill.frontmatter.name or — when missing — the requiredName. */
  name: string
  verdict: SkillAuditVerdict
  reasons: string[]
}

export interface AuditInput {
  skills: Skill[]
  references: ReferenceIndex
  recipes: RecipeIndex
}

/**
 * Audit a single skill against the reference + recipe indices.
 * Pure function — easy to test, no I/O.
 */
export function auditSkill(
  skill: Skill,
  references: ReferenceIndex,
  recipes: RecipeIndex,
  knownSkillNames: Set<string>,
): SkillAuditResult {
  const reasons: string[] = []
  const fm = skill.frontmatter
  const body = skill.instructions ?? ""
  let verdict: SkillAuditVerdict = "PASS"

  // --- FAILING: unresolved references ---
  if (fm.references?.length) {
    for (const ref of fm.references) {
      if (!referenceResolves(ref, references)) {
        verdict = "FAILING"
        reasons.push(`references: "${ref}" does not resolve in the registry`)
      }
    }
  }

  // --- FAILING: delegatesTo points at a missing skill ---
  if (fm.delegatesTo?.length) {
    for (const delegate of fm.delegatesTo) {
      if (!knownSkillNames.has(delegate)) {
        verdict = "FAILING"
        reasons.push(`delegatesTo: "${delegate}" has no installed SKILL.md`)
      }
    }
  }

  // --- REVIEW: hardcoded raw script invocations inside fenced code blocks ---
  // Flagging only fenced code blocks avoids false positives from prose like
  // "Do not invoke `python3 ~/scripts/...`" — the skill is *recommending*
  // the script when it puts it inside ```...``` (or indented as a runnable
  // command), not when it explicitly forbids it.
  if (containsRawScriptInCodeFence(body)) {
    if (verdict !== "FAILING") verdict = "REVIEW"
    reasons.push("body contains raw `python3 ~/scripts/...` inside a code block — delegate to the relevant skill instead")
  }

  // --- REVIEW: deploy/ssh/email/gitlab skills with no references frontmatter ---
  const infraCategory = ["deploy", "ssh", "email", "gitlab", "ops"]
  const cat = (fm.category || "").toLowerCase()
  const tags = (fm.tags || []).map(t => t.toLowerCase())
  const looksInfra =
    infraCategory.includes(cat) ||
    tags.some(t => infraCategory.includes(t)) ||
    /\b(deploy|ssh|gitlab|hotmail|server|host)\b/i.test(fm.description || "")
  if (looksInfra && (!fm.references || fm.references.length === 0)) {
    if (verdict === "PASS") verdict = "REVIEW"
    reasons.push(
      "infrastructure-flavored skill has no `references:` frontmatter — facts should be cited from the registry",
    )
  }

  // --- REVIEW: raw IP/email patterns embedded that look like deterministic facts ---
  const ipMatches = body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)
  if (ipMatches && ipMatches.length > 0) {
    const known = new Set(
      [...references.byId.values()].flatMap(c =>
        Object.values(c.fields).filter(v => typeof v === "string"),
      ),
    )
    const stranded = ipMatches.filter(ip => !known.has(ip))
    if (stranded.length > 0) {
      if (verdict === "PASS") verdict = "REVIEW"
      reasons.push(
        `body contains raw IP(s) not in the registry: ${[...new Set(stranded)].slice(0, 3).join(", ")}`,
      )
    }
  }

  return { skill, name: fm.name, verdict, reasons }
}

/**
 * Audit every recipe-required skill: if a recipe lists a skill name that has
 * no SKILL.md, report it as a FAILING phantom-skill row. The non-existent
 * skill is reported under its required name with skill=null.
 */
export function auditMissingSkills(
  recipes: RecipeIndex,
  knownSkillNames: Set<string>,
): SkillAuditResult[] {
  const required = new Set<string>()
  for (const recipe of recipes.recipes) {
    for (const s of recipe.skills) required.add(s)
  }
  const results: SkillAuditResult[] = []
  for (const name of required) {
    if (!knownSkillNames.has(name)) {
      results.push({
        skill: null,
        name,
        verdict: "FAILING",
        reasons: [`required by a recipe, but no SKILL.md is installed`],
      })
    }
  }
  return results
}

/**
 * Convenience: audit every skill in `input.skills`, plus phantom-skill rows.
 */
export function auditAll(input: AuditInput): SkillAuditResult[] {
  const knownNames = new Set(input.skills.map(s => s.frontmatter.name))
  const results = input.skills.map(s =>
    auditSkill(s, input.references, input.recipes, knownNames),
  )
  return [...results, ...auditMissingSkills(input.recipes, knownNames)]
}

function containsRawScriptInCodeFence(body: string): boolean {
  let inFence = false
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence && /python3\s+~\/scripts\//.test(line)) return true
  }
  return false
}

function referenceResolves(ref: string, idx: ReferenceIndex): boolean {
  if (ref.endsWith(".*")) {
    const prefix = ref.slice(0, -2)
    for (const id of idx.byId.keys()) {
      if (id === prefix || id.startsWith(`${prefix}.`)) return true
    }
    return false
  }
  return idx.byId.has(ref)
}
